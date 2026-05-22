#!/usr/bin/env tsx
/**
 * Wave 7 integration — 10 cycles back-to-back on demo-commesse, each one
 * blocks a random machine for a random window via /api/apply-whatif.
 *
 * For each cycle we record:
 *   - cost_usd                       (translator + apply pipeline)
 *   - latency_ms                     (full SSE stream)
 *   - status                         (ok / unsupported / error)
 *   - lock_fired                     (frozen_phases array non-empty in `solved` payload)
 *   - constraint_respected           (no candidate phase on the blocked machine
 *                                     overlaps the blocked window — see § verifyConstraint)
 *
 * Aggregates: mean cost, p50/p95 latency, fail rate, lock-fired %, constraint
 * respected %. Output: scripts/wave7-integration-results.json.
 *
 * Cap costo: $2.00 totale, prebudget per cycle ~$0.07 (Opus translator + 0
 * solver LLM). Pannel-stress is intentionally bounded to 10 cycles.
 *
 * Usage:
 *   npx tsx scripts/wave7-integration.ts
 *   BASE_URL=http://localhost:8080 STRESS_CYCLES=10 npx tsx scripts/wave7-integration.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8001';
const TOTAL_CYCLES = Math.min(Number(process.env.STRESS_CYCLES ?? 10), 15);
const SLUG = 'demo-commesse';

// 5 machines in demo-commesse: M01..M05. Phrasing varies to keep the
// translator from cache-hitting trivially.
const MACHINES = ['M01', 'M02', 'M03', 'M04', 'M05'] as const;

interface Cycle {
  index: number;
  scenario: string;
  machine: string;
  window_start_min: number;
  window_end_min: number;
  status: 'ok' | 'unsupported' | 'error';
  latency_ms: number;
  cost_usd: number;
  lock_fired: boolean;
  lock_count: number;
  constraint_respected: boolean | null;
  candidate_phase_count: number;
  warnings: string[];
  error_msg?: string;
}

interface SolvedPayload {
  newSolution?: Record<string, { fasi?: Array<Record<string, unknown>> }>;
  newKpis?: Record<string, number>;
  deltaKpis?: Record<string, number>;
  warnings?: string[];
  status?: string;
  strategy?: string;
  // Wave 7 BFF wraps the backend response with these fields; the backend
  // emits `locked_count` from f_apply_rules.py and `frozen_count` is the
  // BFF's count from buildFrozenPhases (before solve).
  cutoff_min?: number;
  frozen_count?: number;
  locked_count?: number;
  modified_count?: number;
}

interface ApplyResult {
  status: 'ok' | 'unsupported' | 'error';
  solved: SolvedPayload | null;
  warnings: string[];
  cost_usd: number;
  error_msg?: string;
}

let _ipCounter = 200;
function nextIp(): string {
  _ipCounter++;
  return `10.50.${Math.floor(_ipCounter / 256)}.${_ipCounter % 256}`;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(Math.max(Math.ceil((p / 100) * s.length) - 1, 0), s.length - 1);
  return s[i];
}

function fmtMs(ms: number): string {
  return `${ms.toFixed(0).padStart(6)}ms`;
}

function fmt$(n: number): string {
  return `$${n.toFixed(5)}`;
}

/** Pick a deterministic-ish scenario for cycle index. */
function pickScenario(idx: number): { scenario: string; machine: string; start_min: number; end_min: number } {
  // Rotate machines so each gets blocked ~2x in 10 cycles.
  const machine = MACHINES[idx % MACHINES.length];
  // Vary window across days 1..3, length 3-6 hours, anchored on whole hours.
  // Catalog convention: gg1 = minuti 0-1440, gg2 = 1440-2880, gg3 = 2880-4320.
  // Day d=1..3 starts at (d-1)*1440 to match the Haiku parser's day indexing.
  const day = (idx % 3) + 1; // gg1..gg3
  const hour = 8 + (idx % 8); // 8..15
  const span = 3 + (idx % 4); // 3..6
  const start_min = (day - 1) * 1440 + hour * 60;
  const end_min = start_min + span * 60;
  // Phrase varies slightly to avoid prompt-cache trivialisation, but stays
  // Italian-natural so the Haiku parser actually exercises entity extraction.
  const phrases = [
    `${machine} si è rotta al gg${day} ore ${hour}, deve restare ferma fino a ore ${hour + span}.`,
    `Posso fermare ${machine} il gg${day} dalle ${hour} alle ${hour + span} per manutenzione?`,
    `${machine} indisponibile gg${day} ${hour}-${hour + span}, vincolo da consolidare.`,
    `Stop ${machine} gg${day} ${hour}:00 → ${hour + span}:00, manutenzione preventiva.`,
  ];
  const scenario = phrases[idx % phrases.length];
  return { scenario, machine, start_min, end_min };
}

async function fetchBaseline(): Promise<{ solution: Record<string, { fasi?: Array<Record<string, unknown>> }>; kpis: Record<string, number> }> {
  const res = await fetch(`${BACKEND_URL}/api/public/solve-template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, problem_type: 'fjsp', force_cold_start: true }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Baseline solve failed: HTTP ${res.status}`);
  const j = await res.json() as Record<string, unknown>;
  const rawKpis = (j.kpis ?? {}) as Record<string, unknown>;
  const flatKpis: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawKpis)) {
    if (typeof v === 'number' && Number.isFinite(v)) flatKpis[k] = v;
  }
  const solution = (j.solution ?? {}) as Record<string, { fasi?: Array<Record<string, unknown>> }>;
  return { solution, kpis: flatKpis };
}

/**
 * Verify the candidate solution respects the blocked machine window. Returns
 * true if no candidate phase on `machine` overlaps [start_min, end_min).
 * Returns null if the candidate is missing OR empty (we can't verify a
 * vacuous schedule — an empty solution trivially "respects" any window but
 * also fails the real test "the plan accommodates the rule").
 */
function verifyConstraint(
  solution: Record<string, { fasi?: Array<Record<string, unknown>> }> | undefined,
  machine: string,
  start_min: number,
  end_min: number,
): boolean | null {
  if (!solution) return null;
  // Count total phases — if zero, the backend returned an empty schedule
  // (e.g. status=ERROR was masked into `solved` with empty newSolution).
  // Treat that as "cannot verify" rather than "respected".
  let total = 0;
  for (const job of Object.values(solution)) total += job?.fasi?.length ?? 0;
  if (total === 0) return null;

  for (const job of Object.values(solution)) {
    for (const fase of job?.fasi ?? []) {
      if (typeof fase !== 'object' || fase === null) continue;
      const f = fase as Record<string, unknown>;
      if (f.macchina !== machine) continue;
      const s = Number(f.start_min);
      const e = Number(f.end_min);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      // Overlap test: phase intersects [start_min, end_min)
      if (s < end_min && e > start_min) return false;
    }
  }
  return true;
}

function countPhases(solution?: Record<string, { fasi?: Array<Record<string, unknown>> }>): number {
  if (!solution) return 0;
  let n = 0;
  for (const job of Object.values(solution)) n += job?.fasi?.length ?? 0;
  return n;
}

const WHATIF_SAMPLE = `## 1. Interpretazione
Scenario di indisponibilità macchina per finestra oraria definita.

## 2. Impatto
Lo stop pianificato può ritardare alcune commesse che dipendono da quella macchina. Da verificare con re-solve.

## 3. Trade-off
Manutenzione preventiva vs slittamento. Tipicamente accettabile.

## 4. Raccomandazione
Applicare lo stop, poi confrontare KPI.`;

async function callApplyWhatIf(
  baseline: { solution: unknown; kpis: Record<string, number> },
  scenarioObj: { scenario: string; machine: string; start_min: number; end_min: number },
  cushionMin = 30,
): Promise<{ result: ApplyResult; latency_ms: number }> {
  const t0 = Date.now();
  const whatifText = `${WHATIF_SAMPLE}\n\n<<scenario>> ${scenarioObj.scenario}`;
  const body = JSON.stringify({
    slug: SLUG,
    originalSolution: baseline.solution,
    kpis: baseline.kpis,
    whatifText,
    // managerText triggers the Wave 7 Haiku-parser path (cheaper, $0.005)
    // — we want the integration to exercise the new pipeline, not the
    // legacy Wave 4.1 Opus translator fallback.
    managerText: scenarioObj.scenario,
    currentTimeMin: 0, // anchor on horizon start so cushion controls cutoff
    cushionMin,
  });

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/apply-whatif`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
      body,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    return {
      result: {
        status: 'error',
        solved: null,
        warnings: [],
        cost_usd: 0,
        error_msg: err instanceof Error ? err.message : String(err),
      },
      latency_ms: Date.now() - t0,
    };
  }

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    return {
      result: {
        status: 'error',
        solved: null,
        warnings: [],
        cost_usd: 0,
        error_msg: `HTTP ${res.status}: ${txt.slice(0, 200)}`,
      },
      latency_ms: Date.now() - t0,
    };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let solved: SolvedPayload | null = null;
  let costUsd = 0;
  const warnings: string[] = [];
  let unsupported = false;

  while (true) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let idxBuf: number;
    while ((idxBuf = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idxBuf);
      buf = buf.slice(idxBuf + 2);
      const eMatch = chunk.match(/^event:\s*(.+)/m);
      const dMatch = chunk.match(/^data:\s*(.+)/m);
      if (!eMatch || !dMatch) continue;
      const ev = eMatch[1].trim();
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(dMatch[1].trim()) as Record<string, unknown>; } catch { continue; }
      if (ev === 'solved') {
        solved = data as unknown as SolvedPayload;
        const w = (data.warnings as unknown);
        if (Array.isArray(w)) warnings.push(...(w as string[]));
      } else if (ev === 'translated') {
        const change = data.change as Record<string, unknown> | undefined;
        const w = change?.warnings;
        if (Array.isArray(w)) warnings.push(...(w as string[]));
      } else if (ev === 'aborted_unsupported') {
        unsupported = true;
        const w = data.warnings;
        if (Array.isArray(w)) warnings.push(...(w as string[]));
      } else if (ev === 'done') {
        if (typeof data.cost_usd === 'number') costUsd = data.cost_usd as number;
      } else if (ev === 'error') {
        return {
          result: {
            status: 'error',
            solved: null,
            warnings,
            cost_usd: costUsd,
            error_msg: typeof data.message === 'string' ? (data.message as string).slice(0, 200) : 'unknown',
          },
          latency_ms: Date.now() - t0,
        };
      }
    }
  }

  const status: ApplyResult['status'] = unsupported ? 'unsupported' : solved ? 'ok' : 'error';
  return {
    result: { status, solved, warnings, cost_usd: costUsd },
    latency_ms: Date.now() - t0,
  };
}

async function main(): Promise<void> {
  console.log(`Wave 7 integration — ${TOTAL_CYCLES} sequential cycles on /api/apply-whatif`);
  console.log(`BFF=${BASE_URL}  Backend=${BACKEND_URL}  slug=${SLUG}`);

  console.log('\nFetching baseline solve (cold start)...');
  const baseline = await fetchBaseline();
  const baselinePhaseCount = countPhases(baseline.solution);
  console.log(`Baseline ready — ${baselinePhaseCount} phases, KPI keys: ${Object.keys(baseline.kpis).join(',')}\n`);

  console.log('idx | machine | window               | status      | latency  | cost      | lock | resp.| warns');
  console.log('-'.repeat(125));

  const cycles: Cycle[] = [];
  for (let i = 0; i < TOTAL_CYCLES; i++) {
    const obj = pickScenario(i);
    // Slight pause between cycles to give the BFF's _inFlightBySlug map
    // time to release. The lock cleanup runs in finally/cancel; in dev
    // mode (vite) the cancel() callback can lag by a few hundred ms.
    if (i > 0) await new Promise((res) => setTimeout(res, 500));
    const { result, latency_ms } = await callApplyWhatIf(baseline, obj);
    // Prefer the backend's locked_count (number actually hard-pinned) but
    // fall back to the BFF's frozen_count (number sent to the backend) so
    // we still observe pipeline traffic when the backend wire-up lags.
    const lockCount = result.solved?.locked_count ?? result.solved?.frozen_count ?? 0;
    const respected = result.status === 'ok'
      ? verifyConstraint(result.solved?.newSolution, obj.machine, obj.start_min, obj.end_min)
      : null;
    const cycle: Cycle = {
      index: i,
      scenario: obj.scenario,
      machine: obj.machine,
      window_start_min: obj.start_min,
      window_end_min: obj.end_min,
      status: result.status,
      latency_ms,
      cost_usd: result.cost_usd,
      lock_fired: lockCount > 0,
      lock_count: lockCount,
      constraint_respected: respected,
      candidate_phase_count: countPhases(result.solved?.newSolution),
      warnings: result.warnings.slice(0, 8),
      error_msg: result.error_msg,
    };
    cycles.push(cycle);
    const respStr = respected === null ? '-' : respected ? 'YES' : 'NO ';
    console.log(
      `${String(i).padStart(3)} | ${obj.machine.padEnd(7)} | ${String(obj.start_min).padStart(5)}-${String(obj.end_min).padEnd(5)} (gg${(i % 3) + 1}) | ` +
      `${result.status.padEnd(11)} | ${fmtMs(latency_ms)} | ${fmt$(result.cost_usd)} | ${String(lockCount).padStart(4)} | ${respStr} | ${cycle.warnings.length ? cycle.warnings.slice(0, 2).join(';') : '-'}`,
    );
  }

  // Aggregate.
  const ok = cycles.filter((c) => c.status === 'ok');
  const unsup = cycles.filter((c) => c.status === 'unsupported');
  const errs = cycles.filter((c) => c.status === 'error');
  const lockFiredCount = cycles.filter((c) => c.lock_fired).length;
  const respectedCount = cycles.filter((c) => c.constraint_respected === true).length;
  const violatedCount = cycles.filter((c) => c.constraint_respected === false).length;

  const latencies = cycles.map((c) => c.latency_ms);
  const costs = cycles.map((c) => c.cost_usd);
  const meanCost = costs.length > 0 ? costs.reduce((s, v) => s + v, 0) / costs.length : 0;
  const totalCost = costs.reduce((s, v) => s + v, 0);

  console.log('\n=== Wave 7 Integration Summary ===');
  console.log(`OK:           ${ok.length}/${cycles.length}`);
  console.log(`Unsupported:  ${unsup.length}/${cycles.length}`);
  console.log(`Errors:       ${errs.length}/${cycles.length}`);
  console.log(`Lock fired:   ${lockFiredCount}/${cycles.length} (${((lockFiredCount / cycles.length) * 100).toFixed(0)}%)`);
  console.log(`Respected:    ${respectedCount}/${cycles.length} (${((respectedCount / cycles.length) * 100).toFixed(0)}%)`);
  console.log(`Violated:     ${violatedCount}/${cycles.length} (${((violatedCount / cycles.length) * 100).toFixed(0)}%)`);
  console.log(`Latency:      p50=${fmtMs(pct(latencies, 50))} p95=${fmtMs(pct(latencies, 95))} max=${fmtMs(Math.max(...latencies, 0))}`);
  console.log(`Cost:         mean=${fmt$(meanCost)} total=${fmt$(totalCost)} max=${fmt$(Math.max(...costs, 0))}`);

  // Targets.
  console.log('\n=== Wave 7 Targets ===');
  const targets: Array<{ name: string; value: number; threshold: number; cmp: '<' | '>'; pass: boolean }> = [];
  targets.push({ name: 'cost/click mean',     value: meanCost,                  threshold: 0.10,  cmp: '<', pass: meanCost < 0.10 });
  targets.push({ name: 'cost/click total',    value: totalCost,                 threshold: 2.00,  cmp: '<', pass: totalCost < 2.00 });
  targets.push({ name: 'latency p50',         value: pct(latencies, 50) / 1000, threshold: 20,    cmp: '<', pass: pct(latencies, 50) < 20_000 });
  targets.push({ name: 'error rate',          value: errs.length / cycles.length, threshold: 0.10, cmp: '<', pass: (errs.length / cycles.length) < 0.10 });
  targets.push({
    name: 'respected rate (of OK)',
    value: ok.length > 0 ? respectedCount / ok.length : 1,
    threshold: 0.95,
    cmp: '>',
    pass: ok.length === 0 || respectedCount / ok.length >= 0.95,
  });
  for (const t of targets) {
    const v = t.threshold >= 1 ? t.value.toFixed(3) : `${(t.value * 100).toFixed(1)}%`;
    const thr = t.threshold >= 1 ? t.threshold.toFixed(2) : `${(t.threshold * 100).toFixed(0)}%`;
    console.log(`  ${t.name.padEnd(28)} ${t.cmp} ${thr.padEnd(8)} ? value=${v.padEnd(10)} ${t.pass ? 'PASS' : 'FAIL'}`);
  }

  const fails = targets.filter((t) => !t.pass);

  const outPath = join(process.cwd(), 'scripts/wave7-integration-results.json');
  writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    base_url: BASE_URL,
    backend_url: BACKEND_URL,
    total_cycles: TOTAL_CYCLES,
    cycles,
    summary: {
      ok: ok.length,
      unsupported: unsup.length,
      errors: errs.length,
      lock_fired_count: lockFiredCount,
      lock_fired_pct: cycles.length > 0 ? lockFiredCount / cycles.length : 0,
      respected_count: respectedCount,
      violated_count: violatedCount,
      respected_pct_of_ok: ok.length > 0 ? respectedCount / ok.length : 0,
      latency_ms: {
        p50: pct(latencies, 50),
        p95: pct(latencies, 95),
        max: Math.max(...latencies, 0),
      },
      cost: {
        mean_usd: meanCost,
        total_usd: totalCost,
        max_usd: Math.max(...costs, 0),
      },
      targets_passed: fails.length === 0,
      target_fails: fails.map((t) => t.name),
    },
  }, null, 2));
  console.log(`\nResults: ${outPath}`);
  process.exit(fails.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(2);
});
