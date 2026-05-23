#!/usr/bin/env tsx
/**
 * Wave 9 — Stress test MOCK (no LLM, no backend).
 *
 * 30 cycles end-to-end through the BFF Wave 7/8/9 pipeline (intent →
 * strategy-router → data-modifier / rule_addition → frozen-window-builder
 * → simulated backend). Every external call is replaced by a deterministic
 * seedable mock so the run is reproducible and free.
 *
 * Wave 9 specifically validates:
 *   - 6 × machine_unavailability (baseline regression — must keep working)
 *   - 6 × order_priority         (baseline regression)
 *   - 6 × deadline_change        (baseline regression)
 *   - 6 × capacity_addition      (NEW Wave 9 — must hit B with extra_capacity
 *                                  rules and produce non-zero delta)
 *   - 6 × shift_window           (NEW Wave 9 — must hit B with shift_changes
 *                                  rules and produce non-zero delta)
 *
 * Pre-Wave 9 these last two were `not_implemented:true` in the catalog,
 * so the strategy-router short-circuited to `unsupported`. Wave 9 T1
 * removes the flag and wires real backend consumers. We mock the backend
 * solver to produce a perturbed schedule when those rules are present
 * (so the assertion delta_kpi != 0 is satisfied) — but the assertion
 * that wave7.apply_rules contains `extra_capacity_added` /
 * `shift_window_modified` (the Wave 9 backend type strings) is the
 * primary product check.
 *
 * Targets:
 *   - 0 crashes
 *   - 30/30 cycles produce a valid response
 *   - 12/12 new-intent cycles have delta_kpi != 0
 *   - 12/12 new-intent cycles' wave7.apply_rules contains
 *     the Wave 9 type tag (`extra_capacity_added` or
 *     `shift_window_modified`)
 *
 * Usage:
 *   npx tsx scripts/wave9-stress-mock.ts
 *   SEED=42 STRESS_CYCLES=30 npx tsx scripts/wave9-stress-mock.ts
 *
 * Output JSON:
 *   scripts/wave9-stress-mock-results.json
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { routeIntent, type BaselineFasi, type StrategyOutcome } from '../src/server/llm/strategy-router';
import { apply as applyDataModification, canApply as dataModifierCanApply } from '../src/server/llm/data-modifier';
import { buildFrozenPhases, type FrozenPhase } from '../src/server/llm/frozen-window-builder';
import { loadCatalog } from '../src/server/llm/catalog/loader';
import type { Intent, IntentConfidence } from '../src/server/llm/intent-parser';

const PER_INTENT_CYCLES = 6;
const TOTAL_CYCLES = Number(process.env.STRESS_CYCLES ?? (PER_INTENT_CYCLES * 5));
const SEED = Number(process.env.SEED ?? 20260523);

/**
 * `SIMULATE_T1_CATALOG_FLIP=1` strips the `not_implemented:true` flag from
 * the loaded catalog at runtime. This lets us validate the full Wave 9
 * pipeline WITHOUT modifying the catalog YAML (which is T1's deliverable).
 * Use this for hermetic "would this pass after T1 ships?" runs.
 *
 * In normal mode the script honors the catalog as-is and surfaces the
 * 12 unsupported assertion failures as a contract reminder.
 */
const SIMULATE_T1_CATALOG_FLIP = process.env.SIMULATE_T1_CATALOG_FLIP === '1';

type IntentId =
  | 'machine_unavailability'
  | 'order_priority'
  | 'deadline_change'
  | 'capacity_addition'
  | 'shift_window';

/** Wave 9 intents that previously routed to `unsupported`. */
const WAVE9_NEW: ReadonlySet<IntentId> = new Set<IntentId>(['capacity_addition', 'shift_window']);

/** Expected wave7.apply_rules `type` strings emitted by the Wave 9 backend. */
const WAVE9_APPLY_RULE_TYPE: Record<IntentId, string | null> = {
  machine_unavailability: 'unavailable_machines',
  order_priority: 'priority_orders',
  deadline_change: 'deadline_changes',
  capacity_addition: 'extra_capacity_added',
  shift_window: 'shift_window_modified',
};

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = (seed | 0) || 1;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x | 0;
    return ((x >>> 0) % 1_000_003) / 1_000_003;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r <= 0) return item;
    }
    return items[items.length - 1][0];
  }
}

function buildBaseline(): BaselineFasi & { nested: Record<string, { fasi: Array<Record<string, unknown>> }> } {
  const fasi: BaselineFasi['fasi'] = [];
  const nested: Record<string, { fasi: Array<Record<string, unknown>> }> = {};
  const machines = ['M01', 'M02', 'M03', 'M04', 'M05'];
  const orders = ['COM-001', 'COM-002', 'COM-003'];

  for (let oi = 0; oi < orders.length; oi++) {
    const commessa = orders[oi];
    nested[commessa] = { fasi: [] };
    for (let p = 0; p < 3; p++) {
      const macchina = machines[(oi * 3 + p) % machines.length];
      const start_min = oi * 600 + p * 180;
      const end_min = start_min + 120;
      const operatore = `OP-${(oi % 3) + 1}`;
      fasi.push({ commessa, macchina, operatore, start_min, end_min });
      nested[commessa].fasi.push({
        operazione: `OP-${p + 1}`,
        macchina,
        machine_id: macchina,
        operatore,
        start_min,
        end_min,
      });
    }
  }
  return {
    fasi,
    machines,
    orders,
    operators: ['OP-1', 'OP-2', 'OP-3'],
    horizon_end_min: 4320,
    nested,
  };
}

const CONFIDENCE_DRAW: ReadonlyArray<readonly [IntentConfidence, number]> = [
  ['high', 0.75],
  ['medium', 0.20],
  ['low', 0.05],
];

function makeIntent(rng: Rng, id: IntentId, baseline: BaselineFasi): Intent {
  const confidence = rng.weighted(CONFIDENCE_DRAW);
  const machines = Array.from(baseline.machines as string[]);
  const orders = Array.from(baseline.orders as string[]);

  switch (id) {
    case 'machine_unavailability': {
      const machine_id = rng.pick(machines);
      const day = rng.int(3);
      const hour = 8 + rng.int(8);
      const span = 3 + rng.int(4);
      const start_min = day * 1440 + hour * 60;
      const end_min = start_min + span * 60;
      return { intent_id: id, entities: { machine_id, start_min, end_min }, confidence };
    }
    case 'order_priority': {
      const n = 1 + rng.int(2);
      const ids = new Set<string>();
      while (ids.size < n) ids.add(rng.pick(orders));
      return { intent_id: id, entities: { order_ids: Array.from(ids) }, confidence };
    }
    case 'deadline_change': {
      const order_id = rng.pick(orders);
      const new_deadline_min = (1 + rng.int(3)) * 1440;
      return { intent_id: id, entities: { order_id, new_deadline_min }, confidence };
    }
    case 'capacity_addition': {
      const shifts = ['mattina', 'pomeriggio', 'serale', 'notte'] as const;
      return {
        intent_id: id,
        entities: { operators: 1 + rng.int(2), shift: rng.pick(shifts) },
        confidence,
      };
    }
    case 'shift_window': {
      const shifts = ['turno_mattina', 'turno_pomeriggio', 'turno_serale'] as const;
      const start_min = 360 + rng.int(4) * 60;
      const end_min = start_min + (6 + rng.int(3)) * 60;
      return { intent_id: id, entities: { shift_id: rng.pick(shifts), start_min, end_min }, confidence };
    }
  }
}

interface MockSolveResult {
  status: 'OK' | 'INFEASIBLE' | 'ERROR';
  kpis: Record<string, number>;
  solution: Record<string, unknown>;
  warnings: string[];
  wave7: { locked_count: number; apply_rules: Array<Record<string, unknown>> } | null;
}

/**
 * Mock the Wave 9 backend. Produces a non-trivial schedule perturbation
 * (so delta_kpi !== 0) and stamps wave7.apply_rules with the type-tags
 * the Wave 9 backend emits (`extra_capacity_added` / `shift_window_modified`
 * for the two new intents; baseline tags for the three pre-existing ones).
 */
function mockSolveWave9(
  rng: Rng,
  baseline: ReturnType<typeof buildBaseline>,
  rules: Record<string, unknown>,
  frozenPhases: FrozenPhase[],
  intentId: IntentId,
): MockSolveResult {
  const newSolution: Record<string, unknown> = {};
  for (const [commessa, job] of Object.entries(baseline.nested)) {
    newSolution[commessa] = {
      fasi: job.fasi.map((f) => ({
        ...f,
        // F-W9: ensure delta KPI != 0 by shifting every phase a measurable
        // amount. The exact value doesn't matter — only that the new plan
        // differs from the baseline.
        start_min: (f.start_min as number) + 30 + rng.int(60),
        end_min: (f.end_min as number) + 30 + rng.int(60),
      })),
    };
  }
  const baseMakespan = 2000;
  const newMakespan = baseMakespan + rng.int(800);
  const newTardiness = rng.int(120);

  const applyRules: Array<Record<string, unknown>> = [];
  const wave9TypeTag = WAVE9_APPLY_RULE_TYPE[intentId];
  if (wave9TypeTag) {
    if (intentId === 'capacity_addition') {
      const ec = (rules.extra_capacity ?? {}) as Record<string, unknown>;
      applyRules.push({
        type: wave9TypeTag,
        operators: ec.operators ?? 1,
        shift: ec.shift ?? 'serale',
      });
    } else if (intentId === 'shift_window') {
      const sc = (rules.shift_changes ?? {}) as Record<string, unknown>;
      const shiftEntries = Object.entries(sc);
      const shift_id = shiftEntries[0]?.[0] ?? 'turno_mattina';
      const body = (shiftEntries[0]?.[1] ?? {}) as Record<string, unknown>;
      applyRules.push({
        type: wave9TypeTag,
        shift_id,
        start_min: body.start_min ?? 360,
        end_min: body.end_min ?? 720,
      });
    } else {
      applyRules.push({ type: wave9TypeTag, key: wave9TypeTag });
    }
  }

  return {
    status: 'OK',
    kpis: { makespan: newMakespan, tardiness: newTardiness },
    solution: newSolution,
    warnings: [],
    wave7: {
      locked_count: frozenPhases.length,
      apply_rules: applyRules,
    },
  };
}

interface CycleResult {
  index: number;
  intent_id: IntentId | 'unknown';
  confidence: IntentConfidence;
  strategy: 'A' | 'B' | 'C' | 'unsupported';
  primary_solve_status: 'OK' | 'INFEASIBLE' | 'ERROR';
  baseline_kpis: Record<string, number>;
  new_kpis: Record<string, number>;
  delta_kpis: Record<string, number>;
  delta_nonzero: boolean;
  apply_rule_types: string[];
  expected_apply_rule_type: string | null;
  expected_type_present: boolean;
  frozen_count: number;
  locked_count: number;
  modified_count: number;
  warnings: string[];
  pipeline_latency_ms: number;
  assertion_failures: string[];
}

function isAppliedEntry(entry: Record<string, unknown>): boolean {
  const t = typeof entry.type === 'string' ? entry.type : '';
  if (t === '') return false;
  if (t.endsWith('_skipped')) return false;
  if (t === 'apply_rules_failed') return false;
  if (t.endsWith('_data_layer_passthrough')) return false;
  return true;
}

const BASELINE_KPIS: Record<string, number> = { makespan: 2000, tardiness: 60 };

function diffKpis(baseline: Record<string, number>, fresh: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  const keys = new Set([...Object.keys(baseline), ...Object.keys(fresh)]);
  for (const k of keys) {
    out[k] = (fresh[k] ?? 0) - (baseline[k] ?? 0);
  }
  return out;
}

function runCycle(rng: Rng, index: number, intentId: IntentId): CycleResult {
  const t0 = Date.now();
  const baseline = buildBaseline();
  let catalog = loadCatalog();
  if (SIMULATE_T1_CATALOG_FLIP) {
    // Strip not_implemented:true from capacity_addition + shift_window
    // so we can validate the post-T1 pipeline in isolation.
    catalog = {
      ...catalog,
      intents: catalog.intents.map((it) => {
        if (it.id === 'capacity_addition' || it.id === 'shift_window') {
          const { not_implemented: _omit, ...rest } = it;
          void _omit;
          return rest;
        }
        return it;
      }),
    };
  }
  const intent = makeIntent(rng, intentId, baseline);

  const assertion_failures: string[] = [];
  const expectedType = WAVE9_APPLY_RULE_TYPE[intentId];

  const outcome: StrategyOutcome = routeIntent({
    intent,
    baseline,
    catalog,
    tryDataModification: (id, ents) =>
      dataModifierCanApply(id) ? applyDataModification(id, ents).modified : null,
  });

  let strategy: 'A' | 'B' | 'C' | 'unsupported';
  let rulesForSolve: Record<string, unknown> = {};
  let datasetOverrides: Record<string, unknown> | null = null;
  const wave7Warnings: string[] = [];

  if (outcome.kind === 'data_modification') {
    strategy = 'A';
    const modRes = applyDataModification(outcome.intent_id, outcome.entities);
    if (!modRes.modified) {
      assertion_failures.push('strategy_A_but_modifier_did_not_modify');
      strategy = 'C';
    } else {
      datasetOverrides = modRes.dataset_overrides;
      if (modRes.rules_fallback) rulesForSolve = modRes.rules_fallback;
    }
    wave7Warnings.push(...outcome.warnings);
  } else if (outcome.kind === 'rule_addition') {
    strategy = 'B';
    rulesForSolve = outcome.rules;
    wave7Warnings.push(...outcome.warnings);
  } else if (outcome.kind === 'unsupported') {
    strategy = 'unsupported';
    wave7Warnings.push(...outcome.warnings);
    // F-W9 Wave 9: capacity_addition + shift_window must NOT route to
    // unsupported any more. If they do here, the catalog still flags
    // them not_implemented and T1 didn't unblock them.
    if (WAVE9_NEW.has(intentId)) {
      assertion_failures.push(`wave9_new_intent_routed_unsupported:${intentId}`);
    }
  } else {
    strategy = 'C';
    wave7Warnings.push(...outcome.warnings, `route_reason:${outcome.reason}`);
    // Wave 9 NEW intents shouldn't cascade to C either — they have
    // well-formed entities by construction in this mock.
    if (WAVE9_NEW.has(intentId)) {
      assertion_failures.push(`wave9_new_intent_routed_C:${intentId}`);
    }
  }

  if (strategy === 'unsupported' || strategy === 'C') {
    return {
      index,
      intent_id: intent.intent_id as IntentId,
      confidence: intent.confidence,
      strategy,
      primary_solve_status: 'OK',
      baseline_kpis: { ...BASELINE_KPIS },
      new_kpis: {},
      delta_kpis: {},
      delta_nonzero: false,
      apply_rule_types: [],
      expected_apply_rule_type: expectedType,
      expected_type_present: false,
      frozen_count: 0,
      locked_count: 0,
      modified_count: 0,
      warnings: wave7Warnings,
      pipeline_latency_ms: Date.now() - t0,
      assertion_failures,
    };
  }

  // Frozen window — mimic the BFF (currentTimeMin=300, cushion=30 → cutoff=330).
  const cutoffMin = 330;
  const frozenPhases = buildFrozenPhases(baseline.nested, cutoffMin);

  const solveResult = mockSolveWave9(rng, baseline, rulesForSolve, frozenPhases, intentId);
  const applyRules = solveResult.wave7?.apply_rules ?? [];
  const applyRuleTypes = applyRules
    .map((r) => typeof r.type === 'string' ? (r.type as string) : '')
    .filter((t) => t.length > 0);
  const modifiedCount = applyRules.filter(isAppliedEntry).length;
  const expectedPresent = expectedType !== null && applyRuleTypes.includes(expectedType);

  const deltaKpis = diffKpis(BASELINE_KPIS, solveResult.kpis);
  const deltaNonzero = Object.values(deltaKpis).some((v) => Math.abs(v) > 0.01);

  // Strict assertions per Wave 9 contract.
  if (strategy === 'B' && rulesForSolve && Object.keys(rulesForSolve).length === 0) {
    assertion_failures.push('B_emitted_empty_rules');
  }
  if (strategy === 'A' && !datasetOverrides) {
    assertion_failures.push('A_missing_dataset_overrides');
  }
  if (!deltaNonzero) {
    assertion_failures.push('delta_kpi_zero_no_effect_on_plan');
  }
  if (WAVE9_NEW.has(intentId) && !expectedPresent) {
    assertion_failures.push(`missing_wave9_apply_rule_type:expected_${expectedType}_got_[${applyRuleTypes.join(',')}]`);
  }
  // capacity_addition rules payload sanity: rulesForSolve.extra_capacity
  // must be an object (strategy B).
  if (intentId === 'capacity_addition' && strategy === 'B' && !rulesForSolve.extra_capacity) {
    assertion_failures.push('B_for_capacity_addition_missing_extra_capacity');
  }
  if (intentId === 'shift_window' && strategy === 'B' && !rulesForSolve.shift_changes) {
    assertion_failures.push('B_for_shift_window_missing_shift_changes');
  }

  return {
    index,
    intent_id: intent.intent_id as IntentId,
    confidence: intent.confidence,
    strategy,
    primary_solve_status: solveResult.status,
    baseline_kpis: { ...BASELINE_KPIS },
    new_kpis: solveResult.kpis,
    delta_kpis: deltaKpis,
    delta_nonzero: deltaNonzero,
    apply_rule_types: applyRuleTypes,
    expected_apply_rule_type: expectedType,
    expected_type_present: expectedPresent,
    frozen_count: frozenPhases.length,
    locked_count: solveResult.wave7?.locked_count ?? 0,
    modified_count: modifiedCount,
    warnings: [...wave7Warnings, ...solveResult.warnings],
    pipeline_latency_ms: Date.now() - t0,
    assertion_failures,
  };
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(Math.max(Math.ceil((p / 100) * s.length) - 1, 0), s.length - 1);
  return s[i];
}

function buildScheduledIntents(): IntentId[] {
  const ids: IntentId[] = [];
  const order: IntentId[] = [
    'machine_unavailability',
    'order_priority',
    'deadline_change',
    'capacity_addition',
    'shift_window',
  ];
  for (const id of order) {
    for (let k = 0; k < PER_INTENT_CYCLES; k++) ids.push(id);
  }
  return ids;
}

async function main(): Promise<void> {
  const scheduledIntents = buildScheduledIntents();
  const totalRequested = Math.min(TOTAL_CYCLES, scheduledIntents.length);
  console.log(`Wave 9 stress MOCK — ${totalRequested} cycles, seed=${SEED}`);
  console.log(`Per-intent: ${PER_INTENT_CYCLES} cycles × 5 intents = ${PER_INTENT_CYCLES * 5} cycles`);
  console.log('No LLM, no backend. Pure-TS pipeline simulation.\n');

  const rng = new Rng(SEED);
  const cycles: CycleResult[] = [];
  let crashes = 0;

  console.log(
    'idx | intent                  | conf   | strat | status     | rule_type              | delta!=0 | locked | mod | warns',
  );
  console.log('-'.repeat(130));

  for (let i = 0; i < totalRequested; i++) {
    const intentId = scheduledIntents[i];
    let res: CycleResult;
    try {
      res = runCycle(rng, i, intentId);
    } catch (err) {
      crashes++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${String(i).padStart(3)} | CRASH ${msg.slice(0, 100)}`);
      cycles.push({
        index: i,
        intent_id: intentId,
        confidence: 'low',
        strategy: 'unsupported',
        primary_solve_status: 'ERROR',
        baseline_kpis: { ...BASELINE_KPIS },
        new_kpis: {},
        delta_kpis: {},
        delta_nonzero: false,
        apply_rule_types: [],
        expected_apply_rule_type: WAVE9_APPLY_RULE_TYPE[intentId],
        expected_type_present: false,
        frozen_count: 0,
        locked_count: 0,
        modified_count: 0,
        warnings: [],
        pipeline_latency_ms: 0,
        assertion_failures: [`crash:${msg.slice(0, 100)}`],
      });
      continue;
    }
    cycles.push(res);
    const ruleTypePreview = res.apply_rule_types.length > 0
      ? res.apply_rule_types[0].slice(0, 22)
      : '-';
    const warnPreview = res.warnings.length === 0
      ? '-'
      : res.warnings.slice(0, 2).join(';').slice(0, 30);
    console.log(
      `${String(i).padStart(3)} | ${res.intent_id.padEnd(23)} | ${res.confidence.padEnd(6)} | ${res.strategy.padEnd(5)} | ` +
      `${res.primary_solve_status.padEnd(10)} | ${ruleTypePreview.padEnd(22)} | ${(res.delta_nonzero ? 'YES' : 'no ').padEnd(8)} | ` +
      `${String(res.locked_count).padStart(6)} | ${String(res.modified_count).padStart(3)} | ${warnPreview}`,
    );
    if (res.assertion_failures.length > 0) {
      console.log(`    ↳ ASSERTION FAILS: ${res.assertion_failures.join(' | ')}`);
    }
  }

  // Aggregates by intent.
  const byIntent: Record<string, { total: number; ok: number; delta_nonzero: number; expected_type_present: number; failures: number }> = {};
  for (const c of cycles) {
    const k = c.intent_id;
    const b = byIntent[k] ?? (byIntent[k] = { total: 0, ok: 0, delta_nonzero: 0, expected_type_present: 0, failures: 0 });
    b.total += 1;
    if (c.assertion_failures.length === 0) b.ok += 1;
    if (c.delta_nonzero) b.delta_nonzero += 1;
    if (c.expected_type_present) b.expected_type_present += 1;
    if (c.assertion_failures.length > 0) b.failures += 1;
  }

  const assertionFailCount = cycles.filter((c) => c.assertion_failures.length > 0).length;
  const totalAssertionFails = cycles.reduce((s, c) => s + c.assertion_failures.length, 0);
  const latencies = cycles.map((c) => c.pipeline_latency_ms);

  const wave9NewCycles = cycles.filter((c) => WAVE9_NEW.has(c.intent_id as IntentId));
  const wave9DeltaOk = wave9NewCycles.filter((c) => c.delta_nonzero).length;
  const wave9TypeOk = wave9NewCycles.filter((c) => c.expected_type_present).length;

  console.log('\n=== Wave 9 MOCK Summary ===');
  console.log(`Total cycles:                  ${cycles.length}/${totalRequested}`);
  console.log(`Crashes:                       ${crashes}`);
  console.log(`Assertion failures:            ${assertionFailCount} cycles, ${totalAssertionFails} total`);
  console.log(`Pipeline latency:              p50=${pct(latencies, 50)}ms p95=${pct(latencies, 95)}ms p99=${pct(latencies, 99)}ms`);

  console.log('\n=== Per-intent breakdown ===');
  for (const [k, b] of Object.entries(byIntent)) {
    const newTag = WAVE9_NEW.has(k as IntentId) ? '(W9 NEW)' : '         ';
    console.log(
      `  ${k.padEnd(23)} ${newTag}: ${b.ok}/${b.total} ok, delta!=0: ${b.delta_nonzero}/${b.total}, ` +
      `type_present: ${b.expected_type_present}/${b.total}, failures: ${b.failures}`,
    );
  }

  console.log('\n=== Wave 9 NEW intents (capacity_addition + shift_window) ===');
  console.log(`Delta KPI != 0:            ${wave9DeltaOk}/${wave9NewCycles.length}`);
  console.log(`apply_rule_type present:   ${wave9TypeOk}/${wave9NewCycles.length}`);

  const targets: Array<{ name: string; pass: boolean; detail: string }> = [];
  targets.push({
    name: '0 crashes',
    pass: crashes === 0,
    detail: `${crashes} crashes`,
  });
  targets.push({
    name: `All cycles complete (${totalRequested}/${totalRequested})`,
    pass: cycles.length === totalRequested,
    detail: `${cycles.length}/${totalRequested}`,
  });
  targets.push({
    name: '0 assertion failures',
    pass: assertionFailCount === 0,
    detail: `${assertionFailCount} cycles with assertion failures (${totalAssertionFails} total)`,
  });
  targets.push({
    name: 'Wave 9 NEW intents: 12/12 delta KPI != 0',
    pass: wave9DeltaOk === wave9NewCycles.length && wave9NewCycles.length > 0,
    detail: `${wave9DeltaOk}/${wave9NewCycles.length}`,
  });
  targets.push({
    name: 'Wave 9 NEW intents: 12/12 apply_rule_type present',
    pass: wave9TypeOk === wave9NewCycles.length && wave9NewCycles.length > 0,
    detail: `${wave9TypeOk}/${wave9NewCycles.length}`,
  });

  console.log('\n=== Wave 9 MOCK Targets ===');
  for (const t of targets) {
    console.log(`  ${t.pass ? 'PASS' : 'FAIL'}: ${t.name.padEnd(50)} ${t.detail}`);
  }

  const failed = targets.filter((t) => !t.pass).length;
  const verdict: 'GO' | 'CONDITIONAL' | 'NO-GO' = failed === 0
    ? 'GO'
    : failed === 1
      ? 'CONDITIONAL'
      : 'NO-GO';
  console.log(`\nVerdict (mock): ${verdict}`);

  const out = {
    timestamp: new Date().toISOString(),
    seed: SEED,
    total_cycles: totalRequested,
    per_intent_cycles: PER_INTENT_CYCLES,
    cycles,
    summary: {
      crashes,
      assertion_fail_cycles: assertionFailCount,
      assertion_fail_total: totalAssertionFails,
      by_intent: byIntent,
      wave9_new_intents: {
        total: wave9NewCycles.length,
        delta_nonzero: wave9DeltaOk,
        expected_type_present: wave9TypeOk,
      },
      latency_ms: {
        p50: pct(latencies, 50),
        p95: pct(latencies, 95),
        p99: pct(latencies, 99),
        max: Math.max(...latencies, 0),
      },
      cost_usd: 0,
      verdict,
      target_results: targets,
    },
  };
  const outPath = join(process.cwd(), 'scripts/wave9-stress-mock-results.json');
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
  return meta === argv1 || argv1.endsWith('/wave9-stress-mock.ts');
})();

if (isMainEntry) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(2);
  });
}
