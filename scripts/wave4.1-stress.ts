#!/usr/bin/env tsx
/**
 * Wave 4.1 stress — fast lane.
 *
 * 20 cycles of `POST /api/apply-whatif` on the demo-commesse fixture,
 * varying only the time window in the scenario ("fermo M-3 N-M") to keep
 * the prompt-cache warm while still exercising distinct translator outputs.
 *
 * SSE events expected from the BFF (per task #8 contract):
 *   - translating  { phase: 'translating' }
 *   - translated   { change: ConstraintChange }
 *   - aborted_unsupported  { reason }            (terminal, no solve)
 *   - solving      { phase: 'solving' }
 *   - solved       { newSolution, newKpis, deltaKpis, warnings }
 *   - done         { cost_usd, tokens_in, tokens_out }
 *   - error        { code, message }
 *
 * Targets:
 *   - time-to-translated p50  < 3.0 s
 *   - time-to-solved      p50 < 15.0 s
 *   - real error rate         < 5 %
 *   - cost mean / cycle       < $0.05
 *
 * Local IP-based rate-limiting is bypassed by default (.dev.vars sets
 * DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL=1), and we additionally set a unique
 * X-Forwarded-For per cycle for defence in depth.
 *
 * Usage:
 *   npx tsx scripts/wave4.1-stress.ts
 *   BASE_URL=http://localhost:8080 STRESS_CYCLES=20 npx tsx scripts/wave4.1-stress.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8001';
const TOTAL_CYCLES = Math.min(Number(process.env.STRESS_CYCLES ?? 20), 25);
const SLUG = 'demo-commesse';

const SCENARIO_BASE = 'Posso fermare la macchina M03 oggi dalle ';
// Window pairs (start hour, end hour) — 20 distinct windows in working day.
const WINDOWS: Array<[number, number]> = [];
for (let h = 8; h <= 14 && WINDOWS.length < TOTAL_CYCLES; h++) {
  for (const span of [2, 3, 4]) {
    if (WINDOWS.length >= TOTAL_CYCLES) break;
    WINDOWS.push([h, h + span]);
  }
}
while (WINDOWS.length < TOTAL_CYCLES) WINDOWS.push([10, 14]);

function buildScenario(idx: number): string {
  const [s, e] = WINDOWS[idx % WINDOWS.length];
  return `${SCENARIO_BASE}${s} alle ${e} per manutenzione preventiva? Quali commesse rischio di mandare in ritardo?`;
}

interface CycleStats {
  index: number;
  scenario: string;
  ok: boolean;
  status?: number;
  ttft_ms?: number;
  time_to_translated_ms?: number;
  time_to_solved_ms?: number;
  full_ms: number;
  cost_usd?: number;
  translator_cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  cache_read?: number;
  cache_write?: number;
  change_type?: string;
  warnings_count?: number;
  error?: string;
  external_overload: boolean;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(Math.max(Math.ceil((p / 100) * s.length) - 1, 0), s.length - 1);
  return s[i];
}

function fmtMs(ms?: number): string {
  if (ms == null) return '    n/a';
  return `${ms.toFixed(0).padStart(6)}ms`;
}

function fmt$(n?: number): string {
  if (n == null) return '     n/a';
  return `$${n.toFixed(5)}`;
}

let _ipCounter = 100;
function nextIp(): string {
  _ipCounter++;
  return `10.42.${Math.floor(_ipCounter / 256)}.${_ipCounter % 256}`;
}

async function fetchBaseline(): Promise<{ solution: unknown; kpis: Record<string, number> }> {
  const res = await fetch(`${BACKEND_URL}/api/public/solve-template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, problem_type: 'fjsp' }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`Baseline solve failed: HTTP ${res.status}`);
  }
  const j = await res.json() as Record<string, unknown>;
  // The backend returns nested KPI objects (e.g. carico_macchine = {M01: 727, ...}).
  // The BFF body schema requires Record<string, number>, so flatten by keeping
  // only scalar numeric values.
  const rawKpis = (j.kpis ?? {}) as Record<string, unknown>;
  const flatKpis: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawKpis)) {
    if (typeof v === 'number' && Number.isFinite(v)) flatKpis[k] = v;
  }
  // Trim the solution to a minimal "ID-list" shape so the translator can
  // still verify machine/order existence but token spend stays bounded.
  // The translator's job is to refuse hallucination, not to inspect timings.
  const rawSolution = j.solution as Record<string, { fasi?: Array<Record<string, unknown>> }>;
  const machineIds = new Set<string>();
  const orderIds = Object.keys(rawSolution);
  for (const order of Object.values(rawSolution)) {
    for (const fase of order.fasi ?? []) {
      const m = fase.macchina;
      if (typeof m === 'string') machineIds.add(m);
    }
  }
  const trimmedSolution = {
    status: 'FEASIBLE',
    machines: Array.from(machineIds).sort(),
    orders: orderIds.sort(),
  };
  return { solution: trimmedSolution, kpis: flatKpis };
}

const WHATIF_SAMPLE = `## 1. Interpretazione
Lo scenario propone di fermare la macchina M03 in una finestra oraria diurna per manutenzione preventiva. La sospensione e' di alcune ore consecutive.

## 2. Impatto
La macchina M03 e' una risorsa attiva nel piano corrente. Bloccarla puo' ritardare le commesse che dipendono da fasi su M03, in particolare quelle ad alta priorita'. Il makespan rischia di slittare.

## 3. Trade-off
Il guadagno e' la prevenzione del guasto e la disponibilita' affidabile della macchina nei giorni successivi. Il costo e' lo slittamento delle commesse attive nell'orizzonte.

## 4. Raccomandazione
Fermo applicabile in finestra di bassa carica, da verificare con il re-solve del CP-SAT.`;

async function callApplyWhatIf(
  idx: number,
  baseline: { solution: unknown; kpis: Record<string, number> },
): Promise<CycleStats> {
  const t0 = Date.now();
  const scenario = buildScenario(idx);

  // The BFF route expects whatifText (translator input). Per task #8 it is
  // the runtime-produced what-if markdown; for the fast lane we use the
  // pre-canned WHATIF_SAMPLE augmented with the scenario string so the
  // translator has a concrete window to extract. This keeps the prompt
  // cache warm across cycles.
  const whatifText = WHATIF_SAMPLE + '\n\n<<scenario>> ' + scenario;

  const body = JSON.stringify({
    slug: SLUG,
    originalSolution: baseline.solution,
    kpis: baseline.kpis,
    whatifText,
  });

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/apply-whatif`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': nextIp(),
      },
      body,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    return {
      index: idx,
      scenario,
      ok: false,
      full_ms: Date.now() - t0,
      external_overload: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    return {
      index: idx,
      scenario,
      ok: false,
      status: res.status,
      full_ms: Date.now() - t0,
      external_overload: res.status === 529 || res.status === 503,
      error: `HTTP ${res.status}: ${txt.slice(0, 200)}`,
    };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ttft: number | undefined;
  let timeToTranslated: number | undefined;
  let timeToSolved: number | undefined;
  let done: Record<string, unknown> | null = null;
  let errorPayload: Record<string, unknown> | null = null;
  let changeType: string | undefined;
  let warningsCount = 0;
  let translatorCost: number | undefined;

  while (true) {
    const r = await reader.read();
    if (r.done) break;
    if (ttft == null) ttft = Date.now() - t0;
    buf += dec.decode(r.value, { stream: true });
    let idxBuf;
    while ((idxBuf = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idxBuf);
      buf = buf.slice(idxBuf + 2);
      const eMatch = chunk.match(/^event:\s*(.+)/m);
      const dMatch = chunk.match(/^data:\s*(.+)/m);
      if (!eMatch || !dMatch) continue;
      const ev = eMatch[1].trim();
      let data: Record<string, unknown> | null = null;
      try { data = JSON.parse(dMatch[1].trim()) as Record<string, unknown>; } catch { /* ignore parse error */ }
      if (!data) continue;
      if (ev === 'translated') {
        timeToTranslated = Date.now() - t0;
        const change = data.change as Record<string, unknown> | undefined;
        if (change) {
          if (typeof change.type === 'string') changeType = change.type;
          if (typeof change.cost_usd === 'number') translatorCost = change.cost_usd as number;
        }
      } else if (ev === 'solved') {
        timeToSolved = Date.now() - t0;
        const warnings = data.warnings as unknown[] | undefined;
        if (Array.isArray(warnings)) warningsCount = warnings.length;
      } else if (ev === 'done') {
        done = data;
      } else if (ev === 'error') {
        errorPayload = data;
      } else if (ev === 'aborted_unsupported') {
        // treat as terminal but non-error for stats purposes
        changeType = 'unsupported';
      }
    }
  }

  const fullMs = Date.now() - t0;

  if (errorPayload) {
    const msg = typeof errorPayload.message === 'string' ? errorPayload.message : JSON.stringify(errorPayload);
    return {
      index: idx,
      scenario,
      ok: false,
      status: res.status,
      ttft_ms: ttft,
      time_to_translated_ms: timeToTranslated,
      time_to_solved_ms: timeToSolved,
      full_ms: fullMs,
      change_type: changeType,
      external_overload: /529|overload/i.test(msg),
      error: msg.slice(0, 200),
    };
  }

  return {
    index: idx,
    scenario,
    ok: true,
    status: res.status,
    ttft_ms: ttft,
    time_to_translated_ms: timeToTranslated,
    time_to_solved_ms: timeToSolved,
    full_ms: fullMs,
    cost_usd: typeof done?.cost_usd === 'number' ? done.cost_usd as number : undefined,
    translator_cost_usd: translatorCost,
    tokens_in: typeof done?.tokens_in === 'number' ? done.tokens_in as number : undefined,
    tokens_out: typeof done?.tokens_out === 'number' ? done.tokens_out as number : undefined,
    cache_read: typeof done?.cache_read_tokens === 'number' ? done.cache_read_tokens as number : undefined,
    cache_write: typeof done?.cache_write_tokens === 'number' ? done.cache_write_tokens as number : undefined,
    change_type: changeType,
    warnings_count: warningsCount,
    external_overload: false,
  };
}

async function main(): Promise<void> {
  console.log(`Wave 4.1 stress (fast lane) — ${TOTAL_CYCLES} sequential cycles on /api/apply-whatif`);
  console.log(`BFF=${BASE_URL}  Backend=${BACKEND_URL}  slug=${SLUG}`);

  console.log('\nFetching baseline solve...');
  const baseline = await fetchBaseline();
  const kpiSummary = Object.entries(baseline.kpis).map(([k, v]) => `${k}=${v}`).slice(0, 4).join(', ');
  console.log(`Baseline ready — KPI sample: ${kpiSummary}\n`);

  console.log('idx | ttft     | translated | solved   | full     | type            | cost      | tokens i/o     | cache_r | warns | status');
  console.log('-'.repeat(140));

  const stats: CycleStats[] = [];
  for (let i = 0; i < TOTAL_CYCLES; i++) {
    const r = await callApplyWhatIf(i, baseline);
    stats.push(r);
    const statusStr = r.ok ? 'OK' : (r.external_overload ? 'EXT-OVERLOAD' : 'ERR');
    console.log(
      `${String(i).padStart(3)} | ${fmtMs(r.ttft_ms)} | ${fmtMs(r.time_to_translated_ms)} | ${fmtMs(r.time_to_solved_ms)} | ${fmtMs(r.full_ms)} | ${String(r.change_type ?? '-').padEnd(15)} | ${fmt$(r.cost_usd)} | ${String(r.tokens_in ?? '-').padStart(6)}/${String(r.tokens_out ?? '-').padEnd(5)} | ${String(r.cache_read ?? '-').padStart(7)} | ${String(r.warnings_count ?? '-').padStart(5)} | ${statusStr}${r.error ? ` (${r.error.slice(0, 40)})` : ''}`,
    );
  }

  // Summary
  const ok = stats.filter((s) => s.ok);
  const ext = stats.filter((s) => s.external_overload);
  const err = stats.filter((s) => !s.ok && !s.external_overload);
  console.log('\n=== Wave 4.1 Fast Lane Summary ===');
  console.log(`OK: ${ok.length}/${stats.length}`);
  console.log(`EXT-OVERLOAD: ${ext.length}/${stats.length}`);
  console.log(`Real errors: ${err.length}/${stats.length}`);

  if (ok.length > 0) {
    const translatedTimes = ok.map((s) => s.time_to_translated_ms).filter((v): v is number => v != null);
    const solvedTimes = ok.map((s) => s.time_to_solved_ms).filter((v): v is number => v != null);
    const costs = ok.map((s) => s.cost_usd).filter((v): v is number => v != null);
    const cacheReads = ok.map((s) => s.cache_read ?? 0);

    console.log('\nLatency (OK only):');
    console.log(`  translated p50=${fmtMs(pct(translatedTimes, 50))} p95=${fmtMs(pct(translatedTimes, 95))} max=${fmtMs(Math.max(...translatedTimes, 0))}`);
    console.log(`  solved     p50=${fmtMs(pct(solvedTimes, 50))} p95=${fmtMs(pct(solvedTimes, 95))} max=${fmtMs(Math.max(...solvedTimes, 0))}`);

    if (costs.length > 0) {
      const mean = costs.reduce((s, v) => s + v, 0) / costs.length;
      const total = costs.reduce((s, v) => s + v, 0);
      console.log(`\nCost:  mean=${fmt$(mean)} total=${fmt$(total)} max=${fmt$(Math.max(...costs))}`);
    }

    console.log(`\nCache hits after #0: ${ok.slice(1).some((s) => (s.cache_read ?? 0) > 0) ? 'YES' : 'NO'}`);
    console.log(`Cache read tokens sum: ${cacheReads.reduce((s, v) => s + v, 0)}`);
  }

  console.log('\n=== Targets ===');
  let fails = 0;
  if (ok.length > 0) {
    const translatedTimes = ok.map((s) => s.time_to_translated_ms).filter((v): v is number => v != null);
    const solvedTimes = ok.map((s) => s.time_to_solved_ms).filter((v): v is number => v != null);
    const costs = ok.map((s) => s.cost_usd).filter((v): v is number => v != null);

    if (translatedTimes.length > 0) {
      const p50 = pct(translatedTimes, 50);
      const passed = p50 < 3_000;
      console.log(`  time-to-translated p50 < 3.0s ? ${(p50 / 1000).toFixed(2)}s  ${passed ? 'PASS' : 'FAIL'}`);
      if (!passed) fails++;
    }
    if (solvedTimes.length > 0) {
      const p50 = pct(solvedTimes, 50);
      const passed = p50 < 15_000;
      console.log(`  time-to-solved     p50 < 15s ?  ${(p50 / 1000).toFixed(2)}s  ${passed ? 'PASS' : 'FAIL'}`);
      if (!passed) fails++;
    }
    if (costs.length > 0) {
      const mean = costs.reduce((s, v) => s + v, 0) / costs.length;
      const passed = mean < 0.05;
      console.log(`  cost mean / cycle  < $0.05 ?    $${mean.toFixed(5)}  ${passed ? 'PASS' : 'FAIL'}`);
      if (!passed) fails++;
    }
  }

  const realErrRate = stats.length > 0 ? err.length / stats.length : 0;
  const passed = realErrRate < 0.05;
  console.log(`  real-error rate    < 5% ?       ${(realErrRate * 100).toFixed(1)}%  ${passed ? 'PASS' : 'FAIL'}`);
  if (!passed) fails++;

  const outPath = join(process.cwd(), 'docs/wave4.1-stress-fast-results.json');
  const totalCost = ok.reduce((s, v) => s + (v.cost_usd ?? 0), 0);
  writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    base_url: BASE_URL,
    total_cycles: TOTAL_CYCLES,
    stats,
    summary: {
      ok: ok.length,
      external_overload: ext.length,
      real_errors: err.length,
      total_cost_usd: totalCost,
      targets_passed: fails === 0,
    },
  }, null, 2));
  console.log(`\nResults: ${outPath}`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(2);
});
