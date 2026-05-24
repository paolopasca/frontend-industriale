#!/usr/bin/env tsx
/**
 * Wave 8 — Stress test MOCK (no LLM, no backend).
 *
 * 50 cycles end-to-end through the BFF Wave 7 pipeline (intent →
 * strategy-router → data-modifier → frozen-window-builder → simulated
 * backend → INFEASIBLE recovery branch). Every external call is
 * replaced by a deterministic seedable mock so the run is reproducible
 * and free.
 *
 * What this script exercises (all the pure-TS BFF modules):
 *   - strategy-router.routeIntent
 *   - data-modifier.canApply / apply
 *   - frozen-window-builder.buildFrozenPhases
 *   - The apply-whatif.ts orchestration contract for the 5 intent ids
 *     in the constraint catalog, including the F-W7-02 INFEASIBLE retry
 *     branch (re-solve once without frozen phases when first solve fails).
 *
 * What this script does NOT exercise (live LLM / backend):
 *   - The Haiku JSON output parser (entirely bypassed — we synthesise a
 *     valid `Intent` directly).
 *   - The real Opus translator fallback.
 *   - The python solver (we emit synthetic solve outcomes per the
 *     50/30/20 FEASIBLE/INFEASIBLE/mixed distribution requested by the
 *     stress plan).
 *
 * Targets (Paolo direttiva):
 *   - 50/50 cycles complete (no crash)
 *   - retry success rate > 80% (i.e. of cycles that go INFEASIBLE on
 *     the first solve, at least 80% must recover on the soft retry)
 *   - cost_usd == 0 (no LLM, no backend)
 *
 * Usage:
 *   npx tsx scripts/wave7-stress-mock.ts
 *   SEED=42 STRESS_CYCLES=50 npx tsx scripts/wave7-stress-mock.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { routeIntent, type BaselineFasi, type StrategyOutcome } from '../src/server/llm/strategy-router';
import { apply as applyDataModification, canApply as dataModifierCanApply } from '../src/server/llm/data-modifier';
import { buildFrozenPhases, type FrozenPhase } from '../src/server/llm/frozen-window-builder';
import { loadCatalog } from '../src/server/llm/catalog/loader';
import type { Intent, IntentConfidence } from '../src/server/llm/intent-parser';

const TOTAL_CYCLES = Number(process.env.STRESS_CYCLES ?? 50);
const SEED = Number(process.env.SEED ?? 20260522);
// F-W8-08 (devils 2026-05-22): --diverse-slugs simulates onboarding
// multi-tenant where each cycle targets a different slug. In the mock
// this means we pretend each cycle has a fresh cache (so simulated
// Haiku cost is "cold" — i.e. cache_creation pricing). In our pure-TS
// mock there is no LLM cost to inflate, but we track which slug was
// used and surface it in the JSON so a future cost-bearing mock can
// derive per-tenant numbers from this signal.
const DIVERSE_SLUGS = process.env.DIVERSE_SLUGS === '1'
  || process.argv.includes('--diverse-slugs');
const SLUG_POOL = DIVERSE_SLUGS
  ? ['demo-commesse', 'demo-acme', 'demo-rossi', 'demo-bianchi', 'demo-gelato']
  : ['demo-commesse'];
function mockSlugForCycle(idx: number): string {
  return SLUG_POOL[idx % SLUG_POOL.length];
}

/** xorshift32 — deterministic, sufficient for distribution mock. */
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
    // Map to [0,1)
    return ((x >>> 0) % 1_000_003) / 1_000_003;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)];
  }
  /** Weighted pick: each entry is [item, weight]. */
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

// ---------------------------------------------------------------------------
// Synthetic baseline. 5 machines (M01..M05) × 3 orders (COM-001..003) × 3
// phases each, populated to give buildFrozenPhases something to chew on.
// horizon_end_min = 4320 (3 days, matches the demo-commesse template).
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Synthetic intent generator. For each of the 5 catalog intents, build
// an `Intent` object with plausible entities + a confidence draw.
// ---------------------------------------------------------------------------
type IntentId =
  | 'machine_unavailability'
  | 'order_priority'
  | 'deadline_change'
  | 'capacity_addition'
  | 'shift_window';

const CONFIDENCE_DRAW: ReadonlyArray<readonly [IntentConfidence, number]> = [
  ['high', 0.70],
  ['medium', 0.20],
  ['low', 0.10],
];

function makeIntent(rng: Rng, id: IntentId, baseline: BaselineFasi): Intent {
  const confidence = rng.weighted(CONFIDENCE_DRAW);
  const machines = Array.from(baseline.machines as string[]);
  const orders = Array.from(baseline.orders as string[]);

  switch (id) {
    case 'machine_unavailability': {
      const machine_id = rng.pick(machines);
      const day = rng.int(3); // 0..2
      const hour = 8 + rng.int(8); // 8..15
      const span = 3 + rng.int(4); // 3..6
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

// ---------------------------------------------------------------------------
// Mock backend. Emits a fake solve outcome aligned with the apply-whatif.ts
// envelope (`{status, kpis, solution, warnings, wave7: {locked_count, ...}}`).
// First-solve outcome distribution: 50% FEASIBLE, 30% INFEASIBLE, 20% mixed.
//   - "mixed" = FEASIBLE but with warnings ("apply_rules_skipped:…")
// On the retry call (no frozen phases) the mock recovers with 90% success
// to keep the >80% retry success target measurable.
// ---------------------------------------------------------------------------
type SolveOutcome = 'FEASIBLE' | 'INFEASIBLE' | 'MIXED';
const PRIMARY_OUTCOME_DRAW: ReadonlyArray<readonly [SolveOutcome, number]> = [
  ['FEASIBLE', 0.50],
  ['INFEASIBLE', 0.30],
  ['MIXED', 0.20],
];

interface MockSolveResult {
  status: 'OK' | 'INFEASIBLE' | 'ERROR';
  kpis: Record<string, number>;
  solution: Record<string, unknown>;
  warnings: string[];
  wave7: { locked_count: number; apply_rules: Array<Record<string, unknown>> } | null;
}

function mockSolve(
  rng: Rng,
  baseline: ReturnType<typeof buildBaseline>,
  rules: Record<string, unknown>,
  frozenPhases: FrozenPhase[],
  isRetry: boolean,
): MockSolveResult {
  const outcome: SolveOutcome = isRetry
    ? rng.next() < 0.9 ? 'FEASIBLE' : 'INFEASIBLE'
    : rng.weighted(PRIMARY_OUTCOME_DRAW);

  if (outcome === 'INFEASIBLE') {
    return {
      status: 'INFEASIBLE',
      kpis: {},
      solution: {},
      warnings: ['solver_returned_infeasible'],
      wave7: {
        locked_count: frozenPhases.length,
        apply_rules: Object.keys(rules).map((k) => ({ type: `${k}_attempted`, key: k })),
      },
    };
  }

  // FEASIBLE / MIXED — return a perturbed copy of the baseline.
  const newSolution: Record<string, unknown> = {};
  for (const [commessa, job] of Object.entries(baseline.nested)) {
    newSolution[commessa] = {
      fasi: job.fasi.map((f) => ({
        ...f,
        start_min: (f.start_min as number) + rng.int(60), // small shift
        end_min: (f.end_min as number) + rng.int(60),
      })),
    };
  }
  const warnings: string[] = [];
  const applyRules: Array<Record<string, unknown>> = [];
  for (const key of Object.keys(rules)) {
    if (outcome === 'MIXED' && rng.next() < 0.5) {
      // Some rule entry skipped (matches isAppliedEntry false branches).
      applyRules.push({ type: `${key}_skipped`, reason: 'mock_skipped' });
      warnings.push(`apply_rules_skipped:${key}`);
    } else {
      applyRules.push({ type: key, key });
    }
  }
  return {
    status: 'OK',
    kpis: { makespan: 2000 + rng.int(800), tardiness: rng.int(120) },
    solution: newSolution,
    warnings,
    wave7: {
      locked_count: frozenPhases.length,
      apply_rules: applyRules,
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline simulator — calls routeIntent + (data-modifier|rule) + frozen-window
// + mockSolve + INFEASIBLE recovery, matching apply-whatif.ts's behaviour.
// Returns a Cycle record with all observed signals.
// ---------------------------------------------------------------------------
interface CycleResult {
  index: number;
  intent_id: IntentId | 'unknown';
  confidence: IntentConfidence;
  strategy: 'A' | 'B' | 'C' | 'unsupported';
  primary_solve_status: 'OK' | 'INFEASIBLE' | 'ERROR';
  retry_triggered: boolean;
  retry_solve_status: 'OK' | 'INFEASIBLE' | 'ERROR' | null;
  recovery_success: boolean | null;
  frozen_count: number;
  locked_count: number;
  modified_count: number;
  skipped_rules_count: number;
  has_dataset_overrides: boolean;
  unsupported_reason?: string;
  warnings: string[];
  pipeline_latency_ms: number;
  assertion_failures: string[];
  slug: string;
  /** F-W8-07: tag the 2 forced low-confidence scenarios. */
  forced_kind?: 'low_conf_incomplete' | 'low_conf_complete';
}

function isAppliedEntry(entry: Record<string, unknown>): boolean {
  const t = typeof entry.type === 'string' ? entry.type : '';
  if (t === '') return false;
  if (t.endsWith('_skipped')) return false;
  if (t === 'apply_rules_failed') return false;
  if (t.endsWith('_data_layer_passthrough')) return false;
  return true;
}

function runCycle(
  rng: Rng,
  index: number,
  forced?: {
    intent: Intent;
    intentId: IntentId;
    kind: NonNullable<CycleResult['forced_kind']>;
  },
): CycleResult {
  const t0 = Date.now();
  const baseline = buildBaseline();
  const catalog = loadCatalog();
  const intentIds: IntentId[] = [
    'machine_unavailability',
    'order_priority',
    'deadline_change',
    'capacity_addition',
    'shift_window',
  ];
  const intentId = forced?.intentId ?? intentIds[index % intentIds.length];
  const intent = forced?.intent ?? makeIntent(rng, intentId, baseline);
  const slug = mockSlugForCycle(index);
  const forcedKind = forced?.kind;

  const assertion_failures: string[] = [];

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
  let unsupportedReason: string | undefined;

  // Intents flagged not_implemented in the catalog (capacity_addition,
  // shift_window per F-W8-01) MUST land in `unsupported` — that's the
  // correct product behaviour, not a bug.
  const NOT_IMPLEMENTED: ReadonlySet<IntentId> = new Set(['capacity_addition', 'shift_window']);

  if (outcome.kind === 'data_modification') {
    strategy = 'A';
    const modRes = applyDataModification(outcome.intent_id, outcome.entities);
    if (!modRes.modified) {
      assertion_failures.push('strategy_A_but_modifier_did_not_modify');
      strategy = 'C';
    } else {
      datasetOverrides = modRes.dataset_overrides;
      if (modRes.rules_fallback) rulesForSolve = modRes.rules_fallback;
      // Strategy A is currently reserved for deadline_change only.
      if (intentId !== 'deadline_change') {
        assertion_failures.push(`strategy_A_unexpected_for:${intentId}`);
      }
    }
    wave7Warnings.push(...outcome.warnings);
  } else if (outcome.kind === 'rule_addition') {
    strategy = 'B';
    rulesForSolve = outcome.rules;
    wave7Warnings.push(...outcome.warnings);
    // The catalog should drive every known intent through B (or A→B fallback)
    // unless the entities failed validation. machine_unavailability MUST land
    // in B because data-modifier rejects it (the catalog comment is explicit).
    if (intentId === 'machine_unavailability' && rulesForSolve.unavailable_machines === undefined) {
      assertion_failures.push('B_for_machine_unavailability_missing_unavailable_machines');
    }
  } else if (outcome.kind === 'unsupported') {
    strategy = 'unsupported';
    unsupportedReason = outcome.reason;
    wave7Warnings.push(...outcome.warnings);
    // For NOT_IMPLEMENTED intents this is the expected outcome — record
    // it but do not flag as an assertion failure.
    if (!NOT_IMPLEMENTED.has(intentId)) {
      assertion_failures.push(`unsupported_unexpected_for:${intentId}`);
    }
  } else {
    strategy = 'C';
    wave7Warnings.push(...outcome.warnings, `route_reason:${outcome.reason}`);
  }

  // If we landed in unsupported / C, we still simulate the rest of the
  // pipeline so the cycle counts cleanly — but with empty rules/overrides
  // we mirror apply-whatif.ts (the Opus translator would fill them in).
  // For the mock we treat C/unsupported as no-solve cycles.
  if (strategy === 'unsupported' || strategy === 'C') {
    return {
      index,
      intent_id: intent.intent_id as IntentId,
      confidence: intent.confidence,
      strategy,
      primary_solve_status: 'OK', // never solved
      retry_triggered: false,
      retry_solve_status: null,
      recovery_success: null,
      frozen_count: 0,
      locked_count: 0,
      modified_count: 0,
      skipped_rules_count: 0,
      has_dataset_overrides: false,
      unsupported_reason: unsupportedReason,
      warnings: wave7Warnings,
      pipeline_latency_ms: Date.now() - t0,
      assertion_failures,
      slug,
      forced_kind: forcedKind,
    };
  }

  // Frozen-window — mimic the BFF (currentTimeMin=300, cushion=30 → cutoff=330).
  const cutoffMin = 330;
  const frozenPhases = buildFrozenPhases(baseline.nested, cutoffMin);

  // Primary solve.
  const primary = mockSolve(rng, baseline, rulesForSolve, frozenPhases, false);
  let final = primary;
  let retryTriggered = false;
  let retryStatus: MockSolveResult['status'] | null = null;
  let recoverySuccess: boolean | null = null;

  // INFEASIBLE recovery: F-W7-02. Only fires when there were frozen phases.
  if (primary.status === 'INFEASIBLE' && frozenPhases.length > 0) {
    retryTriggered = true;
    const retry = mockSolve(rng, baseline, rulesForSolve, [], true);
    retryStatus = retry.status;
    recoverySuccess = retry.status === 'OK';
    final = {
      ...retry,
      warnings: ['lock_relaxed_to_soft', ...retry.warnings],
    };
  } else if (primary.status === 'INFEASIBLE') {
    // INFEASIBLE without frozen phases — no recovery branch fires.
    recoverySuccess = false;
  }

  // Mirror the modified_count split logic from apply-whatif.ts.
  const applyRules = final.wave7?.apply_rules ?? [];
  const modifiedCount = applyRules.filter(isAppliedEntry).length;
  const skippedRulesCount = applyRules.length - modifiedCount;

  // Contract checks.
  if (strategy === 'B' && rulesForSolve && Object.keys(rulesForSolve).length === 0) {
    assertion_failures.push('B_emitted_empty_rules');
  }
  if (strategy === 'A' && !datasetOverrides) {
    assertion_failures.push('A_missing_dataset_overrides');
  }
  if (retryTriggered && !final.warnings.includes('lock_relaxed_to_soft')) {
    assertion_failures.push('retry_did_not_emit_lock_relaxed_warning');
  }

  return {
    index,
    intent_id: intent.intent_id as IntentId,
    confidence: intent.confidence,
    strategy,
    primary_solve_status: primary.status,
    retry_triggered: retryTriggered,
    retry_solve_status: retryStatus,
    recovery_success: recoverySuccess,
    frozen_count: frozenPhases.length,
    locked_count: final.wave7?.locked_count ?? 0,
    modified_count: modifiedCount,
    skipped_rules_count: skippedRulesCount,
    has_dataset_overrides: datasetOverrides !== null,
    warnings: [...wave7Warnings, ...final.warnings],
    pipeline_latency_ms: Date.now() - t0,
    assertion_failures,
    slug,
    forced_kind: forcedKind,
  };
}

/**
 * F-W8-07 (devils 2026-05-22): emit 2 forced low-confidence scenarios
 * at the END of the cycle list so the assertion machinery can verify
 * the BFF contract for ambiguous parser outputs.
 *
 * Scenario A — low_conf_incomplete: confidence='low' AND a required
 *   entity is missing (start_min absent on machine_unavailability).
 *   The strategy-router falls through to opus_translator (Strategy C)
 *   because entity validation fails. Mock contract: strategy MUST be
 *   'C' (not 'unsupported').
 *
 * Scenario B — low_conf_complete: confidence='low' but all required
 *   entities are present and valid. The router routes normally
 *   (B for machine_unavailability). Mock contract: a NEW warning
 *   `low_confidence_classification` should be emitted by the BFF;
 *   the warning does not exist yet (it's a request to apply-whatif
 *   owner), so the mock records its ABSENCE as a non-fatal warning
 *   rather than an assertion failure. The team-lead can decide
 *   whether to wire the warning into apply-whatif.ts.
 */
function buildForcedLowConfidenceCycles(): Array<NonNullable<Parameters<typeof runCycle>[2]>> {
  return [
    {
      kind: 'low_conf_incomplete',
      intentId: 'machine_unavailability',
      intent: {
        intent_id: 'machine_unavailability',
        // start_min missing — required field. Router cascades to C.
        entities: { machine_id: 'M02' },
        confidence: 'low',
        fallback_reasoning: 'parser fired low-confidence with incomplete entities',
      },
    },
    {
      kind: 'low_conf_complete',
      intentId: 'machine_unavailability',
      intent: {
        intent_id: 'machine_unavailability',
        entities: { machine_id: 'M02', start_min: 600, end_min: 1200 },
        confidence: 'low',
        fallback_reasoning: 'parser low-confidence but entities complete',
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Main entry.
// ---------------------------------------------------------------------------
function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(Math.max(Math.ceil((p / 100) * s.length) - 1, 0), s.length - 1);
  return s[i];
}

async function main(): Promise<void> {
  console.log(`Wave 8 stress MOCK — ${TOTAL_CYCLES} cycles, seed=${SEED}`);
  console.log('No LLM, no backend. Pure-TS pipeline simulation.\n');

  const rng = new Rng(SEED);
  const cycles: CycleResult[] = [];
  let crashes = 0;

  console.log('idx | intent                  | conf   | strat | primary    | retry  | recov | frozen | mod | skip | warns');
  console.log('-'.repeat(125));

  const forcedCycles = buildForcedLowConfidenceCycles();
  const totalIterations = TOTAL_CYCLES + forcedCycles.length;

  for (let i = 0; i < totalIterations; i++) {
    const forced = i >= TOTAL_CYCLES ? forcedCycles[i - TOTAL_CYCLES] : undefined;
    let res: CycleResult;
    try {
      res = runCycle(rng, i, forced);
    } catch (err) {
      crashes++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`${String(i).padStart(3)} | CRASH                                                                ${msg.slice(0, 60)}`);
      cycles.push({
        index: i,
        intent_id: 'unknown',
        confidence: 'low',
        strategy: 'unsupported',
        primary_solve_status: 'ERROR',
        retry_triggered: false,
        retry_solve_status: null,
        recovery_success: null,
        frozen_count: 0,
        locked_count: 0,
        modified_count: 0,
        skipped_rules_count: 0,
        has_dataset_overrides: false,
        warnings: [],
        pipeline_latency_ms: 0,
        assertion_failures: [`crash:${msg.slice(0, 100)}`],
        slug: mockSlugForCycle(i),
        forced_kind: forced?.kind,
      });
      continue;
    }

    // F-W8-07 assertions on the 2 forced low-confidence cycles.
    if (forced?.kind === 'low_conf_incomplete') {
      // Expected outcome: strategy = 'C' (Opus translator cascade), NOT
      // 'unsupported'. The router emits `kind:'opus_translator'` when
      // entity validation fails; the mock maps that to strategy='C'.
      if (res.strategy !== 'C') {
        res.assertion_failures.push(`low_conf_incomplete_should_route_C:got_${res.strategy}`);
      }
    }
    if (forced?.kind === 'low_conf_complete') {
      // Expected outcome: strategy = 'B' (route normally, entities are valid).
      // The BFF should emit `low_confidence_classification` warning — that
      // warning DOES NOT EXIST yet in apply-whatif.ts. The mock records
      // absence as a soft-warning (in res.warnings), not an assertion fail,
      // since adding the warning is a request to apply-whatif owner.
      if (res.strategy !== 'B' && res.strategy !== 'A') {
        res.assertion_failures.push(`low_conf_complete_should_route_B_or_A:got_${res.strategy}`);
      }
      if (!res.warnings.some((w) => w.includes('low_confidence_classification'))) {
        res.warnings.push('TODO_low_confidence_classification_warning_missing_from_BFF');
      }
    }

    cycles.push(res);
    const recov = res.recovery_success === null ? '-' : res.recovery_success ? 'OK ' : 'NO ';
    const warnPreview = res.warnings.length === 0
      ? '-'
      : res.warnings.slice(0, 2).join(';').slice(0, 30);
    const tag = forced ? `[${forced.kind}] ` : '';
    console.log(
      `${String(i).padStart(3)} | ${tag}${res.intent_id.padEnd(23)} | ${res.confidence.padEnd(6)} | ${res.strategy.padEnd(5)} | ` +
      `${res.primary_solve_status.padEnd(10)} | ${(res.retry_triggered ? 'YES' : 'no ').padEnd(6)} | ${recov.padEnd(5)} | ` +
      `${String(res.frozen_count).padStart(6)} | ${String(res.modified_count).padStart(3)} | ${String(res.skipped_rules_count).padStart(4)} | ${warnPreview}`,
    );
  }

  // Aggregates.
  const byStrategy = { A: 0, B: 0, C: 0, unsupported: 0 };
  for (const c of cycles) byStrategy[c.strategy] += 1;

  const infeasibleFirst = cycles.filter((c) => c.primary_solve_status === 'INFEASIBLE');
  const recovered = cycles.filter((c) => c.recovery_success === true);
  const recoveryRate = infeasibleFirst.length > 0 ? recovered.length / infeasibleFirst.length : null;

  const completed = cycles.filter((c) => c.assertion_failures.length === 0 && c.strategy !== 'unsupported' || c.strategy === 'unsupported');
  const assertionFailCount = cycles.filter((c) => c.assertion_failures.length > 0).length;
  const totalAssertionFails = cycles.reduce((s, c) => s + c.assertion_failures.length, 0);

  const latencies = cycles.map((c) => c.pipeline_latency_ms);

  console.log('\n=== Wave 8 MOCK Summary ===');
  console.log(`Total cycles:        ${cycles.length}/${TOTAL_CYCLES + 2} (DIVERSE_SLUGS=${DIVERSE_SLUGS ? 'on' : 'off'})`);
  console.log(`Crashes:             ${crashes}`);
  console.log(`Assertion failures:  ${assertionFailCount} cycles, ${totalAssertionFails} total failures`);
  console.log(`Strategy A:          ${byStrategy.A} (${((byStrategy.A / cycles.length) * 100).toFixed(0)}%)`);
  console.log(`Strategy B:          ${byStrategy.B} (${((byStrategy.B / cycles.length) * 100).toFixed(0)}%)`);
  console.log(`Strategy C:          ${byStrategy.C} (${((byStrategy.C / cycles.length) * 100).toFixed(0)}%)`);
  console.log(`Strategy unsupp.:    ${byStrategy.unsupported} (${((byStrategy.unsupported / cycles.length) * 100).toFixed(0)}%)`);
  console.log(`INFEASIBLE first:    ${infeasibleFirst.length}`);
  console.log(`Retry triggered:     ${cycles.filter((c) => c.retry_triggered).length}`);
  console.log(`Recovery success:    ${recovered.length}/${infeasibleFirst.length} (${recoveryRate !== null ? ((recoveryRate) * 100).toFixed(0) + '%' : 'n/a'})`);
  // F-W8-08: report p50/p95/p99 latency (cost stays $0 by construction).
  console.log(`Pipeline latency:    p50=${pct(latencies, 50)}ms p95=${pct(latencies, 95)}ms p99=${pct(latencies, 99)}ms max=${Math.max(...latencies, 0)}ms`);

  // F-W8-07 explicit sub-report on the 2 forced low-confidence cycles.
  const lowConfCycles = cycles.filter((c) => c.forced_kind !== undefined);
  if (lowConfCycles.length > 0) {
    console.log('\n=== Wave 8 MOCK — F-W8-07 low-confidence handling ===');
    for (const c of lowConfCycles) {
      console.log(`  ${c.forced_kind}: strategy=${c.strategy}, warnings=[${c.warnings.slice(0, 3).join(', ')}], assertion_fails=[${c.assertion_failures.join(', ')}]`);
    }
  }

  // Targets.
  const targets: Array<{ name: string; pass: boolean; detail: string }> = [];
  targets.push({
    name: 'Complete (no crash, no assertion fail)',
    pass: crashes === 0 && assertionFailCount === 0,
    detail: `crashes=${crashes} assertion_failures=${assertionFailCount}`,
  });
  targets.push({
    name: 'Retry success rate > 80%',
    pass: recoveryRate === null || recoveryRate > 0.80,
    detail: `${recovered.length}/${infeasibleFirst.length} = ${recoveryRate !== null ? ((recoveryRate) * 100).toFixed(0) + '%' : 'no INFEASIBLE in run'}`,
  });
  targets.push({
    name: 'Cost == 0',
    pass: true, // by construction (no LLM, no backend)
    detail: '$0.00 by construction',
  });
  // F-W8-07: low_conf_incomplete must cascade to C; low_conf_complete
  // must route normally (B or A). Both checks live in assertion_failures.
  const lowConfIncomplete = cycles.find((c) => c.forced_kind === 'low_conf_incomplete');
  const lowConfComplete = cycles.find((c) => c.forced_kind === 'low_conf_complete');
  targets.push({
    name: 'F-W8-07: low_conf_incomplete cascades to C',
    pass: lowConfIncomplete !== undefined && lowConfIncomplete.strategy === 'C',
    detail: lowConfIncomplete ? `strategy=${lowConfIncomplete.strategy}` : 'cycle missing',
  });
  targets.push({
    name: 'F-W8-07: low_conf_complete routes normally',
    pass: lowConfComplete !== undefined && (lowConfComplete.strategy === 'B' || lowConfComplete.strategy === 'A'),
    detail: lowConfComplete ? `strategy=${lowConfComplete.strategy}` : 'cycle missing',
  });

  console.log('\n=== Wave 8 MOCK Targets ===');
  for (const t of targets) {
    console.log(`  ${t.pass ? 'PASS' : 'FAIL'}: ${t.name.padEnd(40)} ${t.detail}`);
  }

  const verdict: 'GO' | 'CONDITIONAL' | 'NO-GO' = targets.every((t) => t.pass)
    ? 'GO'
    : targets.filter((t) => !t.pass).length === 1
      ? 'CONDITIONAL'
      : 'NO-GO';
  console.log(`\nVerdict (mock): ${verdict}`);

  const out = {
    timestamp: new Date().toISOString(),
    seed: SEED,
    total_cycles: TOTAL_CYCLES,
    forced_cycles: forcedCycles.length,
    diverse_slugs: DIVERSE_SLUGS,
    slug_pool: SLUG_POOL,
    cycles,
    summary: {
      crashes,
      assertion_fail_cycles: assertionFailCount,
      assertion_fail_total: totalAssertionFails,
      by_strategy: byStrategy,
      infeasible_first_count: infeasibleFirst.length,
      retry_triggered_count: cycles.filter((c) => c.retry_triggered).length,
      recovery_success_count: recovered.length,
      recovery_success_rate: recoveryRate,
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
  const outPath = join(process.cwd(), 'scripts/wave7-stress-mock-results.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nResults: ${outPath}`);
  process.exit(targets.every((t) => t.pass) ? 0 : 1);
}

// Safety guard: only auto-run main() when this file is the entry point.
const isMainEntry = (() => {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  const argv1 = process.argv[1].replace(/\\/g, '/');
  const meta = typeof import.meta !== 'undefined' && import.meta.url
    ? import.meta.url.replace(/^file:\/\//, '')
    : '';
  return meta === argv1 || argv1.endsWith('/wave7-stress-mock.ts');
})();

if (isMainEntry) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(2);
  });
}
