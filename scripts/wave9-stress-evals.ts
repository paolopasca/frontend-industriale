#!/usr/bin/env tsx
/**
 * Wave 9 — Stress test EVALS (live Haiku + backend).
 *
 * 10 cycles end-to-end through the real BFF (`/api/apply-whatif`) targeting
 * the two new Wave 9 intents:
 *   - 5 × "Aggiungo 1 operatore turno serale"   (capacity_addition)
 *   - 5 × "Anticipa turno mattino di 1h"        (shift_window)
 *
 * Each cycle is a live call: Haiku intent-parser → strategy-router →
 * backend solver → solved. The script verifies for each cycle:
 *   - The intent classified correctly.
 *   - The strategy is B (rule_addition), NOT unsupported.
 *   - The wave7.apply_rules contains the Wave 9 type tag
 *     (`extra_capacity_added` / `shift_window_modified`).
 *   - delta_kpi != 0 (the schedule actually changed).
 *
 * Targets (Paolo direttiva):
 *   - 10/10 cycles produce delta KPI != 0
 *   - total cost < $1.00 (HARD CAP — abort early if breached)
 *   - 10/10 emit the correct apply_rule_type tag
 *
 * Usage:
 *   npx tsx scripts/wave9-stress-evals.ts
 *   BASE_URL=http://localhost:8080 BACKEND_URL=http://localhost:8001 \
 *     npx tsx scripts/wave9-stress-evals.ts
 *
 * Output:
 *   scripts/wave9-stress-evals-results.json
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8001';
const SLUG = 'demo-commesse';
const COST_CAP_USD = Number(process.env.COST_CAP_USD ?? 1.00);
const CYCLES_PER_INTENT = 5;
/**
 * `INTENT_FILTER` env var allows running only one bucket. Useful when one of
 * the two intents has a known upstream issue (e.g. F-W9-01: capacity_addition
 * cascades to Strategy C at $0.25/cycle until the shift validator strip is
 * shipped). Values: `capacity_addition`, `shift_window`, or unset for both.
 */
const INTENT_FILTER = process.env.INTENT_FILTER as
  | 'capacity_addition'
  | 'shift_window'
  | undefined;

interface Scenario {
  id: string;
  intent: 'capacity_addition' | 'shift_window';
  utterance: string;
  expected_apply_rule_type: 'extra_capacity_added' | 'shift_window_modified';
}

// F-W9-10 (2026-05-23, lead): demo-commesse dataset only has shift_types
// ['mattina', 'pomeriggio']. The original Wave 9 utterances referenced
// 'serale' / 'notte' which produce legitimate `_skipped: unknown_shift_id`
// (NOT a bug — the dataset doesn't have those shifts). Scenarios updated
// to use the existing shifts so we can actually verify `*_added` /
// `*_modified` outcomes against real KPI deltas.
const SCENARIOS: Scenario[] = [
  // -- capacity_addition x 5 (all on existing shifts) -----------------------
  {
    id: 'cap_01',
    intent: 'capacity_addition',
    utterance: 'Aggiungi 1 operatore al turno mattina.',
    expected_apply_rule_type: 'extra_capacity_added',
  },
  {
    id: 'cap_02',
    intent: 'capacity_addition',
    utterance: 'Metti un operatore in più al turno pomeriggio.',
    expected_apply_rule_type: 'extra_capacity_added',
  },
  {
    id: 'cap_03',
    intent: 'capacity_addition',
    utterance: 'Aggiungo 2 operatori al turno mattina per domani.',
    expected_apply_rule_type: 'extra_capacity_added',
  },
  {
    id: 'cap_04',
    intent: 'capacity_addition',
    utterance: 'Voglio rinforzare il turno pomeriggio con un operatore extra.',
    expected_apply_rule_type: 'extra_capacity_added',
  },
  {
    id: 'cap_05',
    intent: 'capacity_addition',
    utterance: 'Faccio fare ore straordinarie a 1 operatore nel turno mattina.',
    expected_apply_rule_type: 'extra_capacity_added',
  },
  // -- shift_window x 5 (on existing shifts with VIABLE bounds) -------------
  //
  // Bounds chosen to STAY WIDER than the default windows so the kernel
  // remains feasible. demo-commesse defaults: mattina [0, 480], pomeriggio
  // [480, 1080]. We always extend (never shrink narrower than 6h) to avoid
  // INFEASIBLE / MODEL_INVALID outcomes from over-restrictive windows.
  {
    id: 'shift_01',
    intent: 'shift_window',
    utterance: 'Anticipa il turno mattina di mezz\'ora, dalle 7:30 alle 12.',
    expected_apply_rule_type: 'shift_window_modified',
  },
  {
    id: 'shift_02',
    intent: 'shift_window',
    utterance: 'Estendi il turno mattina fino alle 13 invece che alle 12.',
    expected_apply_rule_type: 'shift_window_modified',
  },
  {
    id: 'shift_03',
    intent: 'shift_window',
    utterance: 'Anticipa il turno pomeriggio di un\'ora, parte alle 7.',
    expected_apply_rule_type: 'shift_window_modified',
  },
  {
    id: 'shift_04',
    intent: 'shift_window',
    utterance: 'Allunga il turno pomeriggio fino alle 19.',
    expected_apply_rule_type: 'shift_window_modified',
  },
  {
    id: 'shift_05',
    intent: 'shift_window',
    utterance: 'Estendi il turno mattina, parte alle 6 e termina alle 13.',
    expected_apply_rule_type: 'shift_window_modified',
  },
];

if (SCENARIOS.length !== CYCLES_PER_INTENT * 2) {
  console.error(`Scenario count mismatch: ${SCENARIOS.length} (expected ${CYCLES_PER_INTENT * 2})`);
  process.exit(2);
}

interface BackendFase {
  commessa?: string;
  operazione?: string;
  macchina?: string;
  machine_id?: string;
  start_min?: number;
  end_min?: number;
}

interface BackendSolution {
  [commessa: string]: { fasi?: BackendFase[] };
}

let _ipCounter = 400;
function nextIp(): string {
  _ipCounter++;
  return `10.52.${Math.floor(_ipCounter / 256)}.${_ipCounter % 256}`;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(Math.max(Math.ceil((p / 100) * s.length) - 1, 0), s.length - 1);
  return s[i];
}

async function fetchBaseline(): Promise<{ solution: BackendSolution; kpis: Record<string, number> }> {
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
  return { solution: (j.solution ?? {}) as BackendSolution, kpis: flatKpis };
}

const WHATIF_SAMPLE = `## 1. Interpretazione
Scenario eval Wave 9.

## 2. Impatto
Da verificare con re-solve.

## 3. Trade-off
Standard.

## 4. Raccomandazione
Applicare e confrontare KPI.`;

interface CycleRecord {
  index: number;
  scenario_id: string;
  intent_expected: Scenario['intent'];
  expected_apply_rule_type: Scenario['expected_apply_rule_type'];
  utterance: string;
  parsed_intent_id: string | null;
  parsed_entities: Record<string, unknown> | null;
  parsed_confidence: string | null;
  strategy: 'A' | 'B' | 'C' | 'unsupported' | null;
  solve_status: string | null;
  delta_kpis: Record<string, number>;
  delta_nonzero: boolean;
  apply_rule_types: string[];
  expected_type_present: boolean;
  cost_usd: number;
  latency_ms: number;
  warnings: string[];
  error_msg?: string;
  events_seen: string[];
}

async function callApplyWhatIf(
  baseline: { solution: BackendSolution; kpis: Record<string, number> },
  utterance: string,
): Promise<{ cycle: Partial<CycleRecord>; latency_ms: number }> {
  const t0 = Date.now();
  const whatifText = `${WHATIF_SAMPLE}\n\n<<scenario>> ${utterance}`;
  const body = JSON.stringify({
    slug: SLUG,
    originalSolution: baseline.solution,
    kpis: baseline.kpis,
    whatifText,
    managerText: utterance,
    currentTimeMin: 0,
    cushionMin: 30,
  });

  let parsed_intent_id: string | null = null;
  let parsed_entities: Record<string, unknown> | null = null;
  let parsed_confidence: string | null = null;
  let strategy: 'A' | 'B' | 'C' | 'unsupported' | null = null;
  let solve_status: string | null = null;
  let delta_kpis: Record<string, number> = {};
  let applyRules: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  let cost_usd = 0;
  let error_msg: string | undefined;
  const events_seen: string[] = [];

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
      cycle: { error_msg: err instanceof Error ? err.message : String(err) },
      latency_ms: Date.now() - t0,
    };
  }

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    return {
      cycle: { error_msg: `HTTP ${res.status}: ${txt.slice(0, 200)}` },
      latency_ms: Date.now() - t0,
    };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
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
      events_seen.push(ev);
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(dMatch[1].trim()) as Record<string, unknown>; } catch { continue; }
      if (ev === 'intent_parsed') {
        parsed_intent_id = typeof data.intent_id === 'string' ? (data.intent_id as string) : null;
        parsed_entities = (data.entities ?? null) as Record<string, unknown> | null;
        parsed_confidence = typeof data.confidence === 'string' ? (data.confidence as string) : null;
      } else if (ev === 'routed') {
        const s = typeof data.strategy === 'string' ? (data.strategy as string) : null;
        if (s === 'A' || s === 'B' || s === 'C' || s === 'unsupported') strategy = s;
      } else if (ev === 'solved') {
        solve_status = typeof data.status === 'string' ? (data.status as string) : null;
        delta_kpis = (data.deltaKpis ?? {}) as Record<string, number>;
        const w = data.warnings;
        if (Array.isArray(w)) warnings.push(...(w as string[]));
        const wave7 = (data.wave7 ?? null) as { apply_rules?: Array<Record<string, unknown>> } | null;
        if (wave7?.apply_rules) applyRules = wave7.apply_rules;
      } else if (ev === 'aborted_unsupported') {
        strategy = 'unsupported';
        const w = data.warnings;
        if (Array.isArray(w)) warnings.push(...(w as string[]));
      } else if (ev === 'done') {
        cost_usd = typeof data.cost_usd === 'number' ? (data.cost_usd as number) : 0;
      } else if (ev === 'error') {
        error_msg = typeof data.message === 'string' ? (data.message as string).slice(0, 200) : 'unknown';
      }
    }
  }

  const applyRuleTypes = applyRules
    .map((r) => typeof r.type === 'string' ? (r.type as string) : '')
    .filter((t) => t.length > 0);
  const deltaNonzero = Object.values(delta_kpis).some((v) => Math.abs(v) > 0.01);

  return {
    cycle: {
      parsed_intent_id,
      parsed_entities,
      parsed_confidence,
      strategy,
      solve_status,
      delta_kpis,
      delta_nonzero: deltaNonzero,
      apply_rule_types: applyRuleTypes,
      cost_usd,
      warnings: warnings.slice(0, 12),
      error_msg,
      events_seen,
    },
    latency_ms: Date.now() - t0,
  };
}

async function main(): Promise<void> {
  console.log(`Wave 9 stress EVALS — ${SCENARIOS.length} cycles, live Haiku + backend`);
  console.log(`BFF=${BASE_URL}  Backend=${BACKEND_URL}  slug=${SLUG}`);
  console.log(`Cost cap: $${COST_CAP_USD.toFixed(2)} (HARD — abort if breached)\n`);

  console.log('Fetching baseline solve (cold start)...');
  const baseline = await fetchBaseline();
  console.log(`Baseline ready — ${Object.keys(baseline.solution).length} orders\n`);

  console.log(
    'idx | scenario   | intent_exp        | parsed                | strat | rule_type             | delta!=0 | cost     | latency',
  );
  console.log('-'.repeat(140));

  const cycles: CycleRecord[] = [];
  let totalCost = 0;
  let aborted = false;

  const filteredScenarios = INTENT_FILTER
    ? SCENARIOS.filter((s) => s.intent === INTENT_FILTER)
    : SCENARIOS;
  const scenarioTarget = filteredScenarios.length;
  if (INTENT_FILTER) {
    console.log(`INTENT_FILTER=${INTENT_FILTER} → running ${scenarioTarget} scenarios (skipping the other bucket).\n`);
  }

  for (let i = 0; i < filteredScenarios.length; i++) {
    const sc = filteredScenarios[i];

    if (totalCost >= COST_CAP_USD) {
      console.log(`\nABORT — total cost $${totalCost.toFixed(5)} ≥ cap $${COST_CAP_USD.toFixed(2)}.`);
      aborted = true;
      break;
    }

    if (i > 0) await new Promise((res) => setTimeout(res, 500));

    const { cycle: partial, latency_ms } = await callApplyWhatIf(baseline, sc.utterance);
    totalCost += partial.cost_usd ?? 0;

    const expectedTypePresent = (partial.apply_rule_types ?? []).includes(sc.expected_apply_rule_type);

    const cycle: CycleRecord = {
      index: i,
      scenario_id: sc.id,
      intent_expected: sc.intent,
      expected_apply_rule_type: sc.expected_apply_rule_type,
      utterance: sc.utterance,
      parsed_intent_id: partial.parsed_intent_id ?? null,
      parsed_entities: partial.parsed_entities ?? null,
      parsed_confidence: partial.parsed_confidence ?? null,
      strategy: partial.strategy ?? null,
      solve_status: partial.solve_status ?? null,
      delta_kpis: partial.delta_kpis ?? {},
      delta_nonzero: partial.delta_nonzero ?? false,
      apply_rule_types: partial.apply_rule_types ?? [],
      expected_type_present: expectedTypePresent,
      cost_usd: partial.cost_usd ?? 0,
      latency_ms,
      warnings: partial.warnings ?? [],
      error_msg: partial.error_msg,
      events_seen: partial.events_seen ?? [],
    };
    cycles.push(cycle);

    const ruleStr = (cycle.apply_rule_types[0] ?? '-').slice(0, 21).padEnd(21);
    const scStr = sc.id.slice(0, 10).padEnd(10);
    const intExp = sc.intent.slice(0, 17).padEnd(17);
    const intGot = (cycle.parsed_intent_id ?? 'null').slice(0, 21).padEnd(21);
    const stratStr = (cycle.strategy ?? '-').padEnd(5);
    const deltaStr = (cycle.delta_nonzero ? 'YES' : 'no ').padEnd(8);

    console.log(
      `${String(i).padStart(3)} | ${scStr} | ${intExp} | ${intGot} | ${stratStr} | ${ruleStr} | ${deltaStr} | ` +
      `$${cycle.cost_usd.toFixed(5)} | ${latency_ms}ms`,
    );
    if (cycle.error_msg) {
      console.log(`    ↳ ERROR: ${cycle.error_msg}`);
    }
    if (cycle.parsed_intent_id !== sc.intent) {
      console.log(`    ↳ INTENT MISMATCH: expected=${sc.intent} got=${cycle.parsed_intent_id}`);
    }
    if (!cycle.expected_type_present) {
      console.log(`    ↳ APPLY_RULE_TYPE MISSING: expected=${sc.expected_apply_rule_type} got=[${cycle.apply_rule_types.join(',')}]`);
    }
  }

  // Aggregates.
  const intentHits = cycles.filter((c) => c.parsed_intent_id === c.intent_expected).length;
  const strategyB = cycles.filter((c) => c.strategy === 'B').length;
  const deltaOk = cycles.filter((c) => c.delta_nonzero).length;
  const typeOk = cycles.filter((c) => c.expected_type_present).length;
  const errors = cycles.filter((c) => c.error_msg).length;
  const costs = cycles.map((c) => c.cost_usd);
  const latencies = cycles.map((c) => c.latency_ms);
  const meanCost = costs.length > 0 ? costs.reduce((s, v) => s + v, 0) / costs.length : 0;
  const totalSpent = costs.reduce((s, v) => s + v, 0);

  console.log('\n=== Wave 9 EVALS Summary ===');
  console.log(`Cycles run:                ${cycles.length}/${scenarioTarget}${aborted ? ' (ABORTED — cost cap)' : ''}`);
  console.log(`Intent classified ok:      ${intentHits}/${cycles.length}`);
  console.log(`Strategy = B:              ${strategyB}/${cycles.length}`);
  console.log(`Delta KPI != 0:            ${deltaOk}/${cycles.length}`);
  console.log(`apply_rule_type present:   ${typeOk}/${cycles.length}`);
  console.log(`Errors:                    ${errors}/${cycles.length}`);
  console.log(`Cost mean:                 $${meanCost.toFixed(5)}`);
  console.log(`Cost total:                $${totalSpent.toFixed(5)} / $${COST_CAP_USD.toFixed(2)}`);
  console.log(`Cost p50/p95:              $${pct(costs, 50).toFixed(5)} / $${pct(costs, 95).toFixed(5)}`);
  console.log(`Latency p50/p95/max:       ${pct(latencies, 50)}ms / ${pct(latencies, 95)}ms / ${Math.max(...latencies, 0)}ms`);

  const targets: Array<{ name: string; pass: boolean; detail: string }> = [];
  targets.push({
    name: `${scenarioTarget}/${scenarioTarget} delta KPI != 0`,
    pass: deltaOk === scenarioTarget,
    detail: `${deltaOk}/${scenarioTarget}`,
  });
  targets.push({
    name: `${scenarioTarget}/${scenarioTarget} apply_rule_type present`,
    pass: typeOk === scenarioTarget,
    detail: `${typeOk}/${scenarioTarget}`,
  });
  targets.push({
    name: 'Total cost < $1.00 (hard cap)',
    pass: totalSpent < COST_CAP_USD && !aborted,
    detail: `$${totalSpent.toFixed(4)} / $${COST_CAP_USD.toFixed(2)}`,
  });
  targets.push({
    name: 'Intent classified ≥ 80%',
    pass: intentHits / scenarioTarget >= 0.80,
    detail: `${intentHits}/${scenarioTarget}`,
  });
  targets.push({
    name: 'Strategy = B ≥ 80%',
    pass: strategyB / scenarioTarget >= 0.80,
    detail: `${strategyB}/${scenarioTarget}`,
  });
  targets.push({
    name: 'Error rate < 10%',
    pass: errors / scenarioTarget < 0.10,
    detail: `${errors}/${scenarioTarget}`,
  });

  console.log('\n=== Wave 9 EVALS Targets ===');
  for (const t of targets) {
    console.log(`  ${t.pass ? 'PASS' : 'FAIL'}: ${t.name.padEnd(40)} ${t.detail}`);
  }

  const failed = targets.filter((t) => !t.pass).length;
  const verdict: 'GO' | 'CONDITIONAL' | 'NO-GO' = failed === 0
    ? 'GO'
    : failed === 1
      ? 'CONDITIONAL'
      : 'NO-GO';
  console.log(`\nVerdict (evals): ${verdict}`);

  const out = {
    timestamp: new Date().toISOString(),
    base_url: BASE_URL,
    backend_url: BACKEND_URL,
    slug: SLUG,
    cost_cap_usd: COST_CAP_USD,
    total_scenarios: SCENARIOS.length,
    aborted_on_cost_cap: aborted,
    cycles,
    summary: {
      intent_correct: intentHits,
      strategy_b: strategyB,
      delta_nonzero: deltaOk,
      apply_rule_type_present: typeOk,
      errors,
      cost: { mean: meanCost, total: totalSpent, p50: pct(costs, 50), p95: pct(costs, 95) },
      latency_ms: { p50: pct(latencies, 50), p95: pct(latencies, 95), max: Math.max(...latencies, 0) },
      verdict,
      target_results: targets,
    },
  };
  const outPath = join(process.cwd(), 'scripts/wave9-stress-evals-results.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nResults: ${outPath}`);
  process.exit(targets.every((t) => t.pass) ? 0 : 1);
}

const isMainEntry = (() => {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  const argv1 = process.argv[1].replace(/\\/g, '/');
  const meta = typeof import.meta !== 'undefined' && import.meta.url
    ? import.meta.url.replace(/^file:\/\//, '')
    : '';
  return meta === argv1 || argv1.endsWith('/wave9-stress-evals.ts');
})();

if (isMainEntry) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(2);
  });
}
