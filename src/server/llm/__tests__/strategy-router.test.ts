import { describe, it, expect, beforeEach } from 'vitest';
import { routeIntent, type BaselineFasi, type TryDataModificationFn } from '../strategy-router';
import { loadCatalog, resetCatalogCache, type ConstraintCatalog } from '../catalog/loader';
import type { Intent } from '../intent-parser';

/**
 * Wave 7 — Strategy router unit tests.
 *
 * Covers the A / B / C / unsupported decision matrix using the shipped
 * catalog. The router is pure TypeScript (no LLM) so each test feeds a
 * fixed Intent + baseline + tryDataModification stub and asserts the
 * resulting StrategyOutcome shape.
 */

let catalog: ConstraintCatalog;

beforeEach(() => {
  resetCatalogCache();
  catalog = loadCatalog();
});

const baseline: BaselineFasi = {
  fasi: [
    { commessa: 'COM-001', macchina: 'M01', operatore: 'OP-1', start_min: 0, end_min: 120 },
    { commessa: 'COM-002', macchina: 'M02', operatore: 'OP-2', start_min: 0, end_min: 90 },
    { commessa: 'COM-007', macchina: 'M01', operatore: 'OP-1', start_min: 120, end_min: 240 },
  ],
  horizon_end_min: 4320,
};

function makeIntent(intent_id: string, entities: Record<string, unknown>): Intent {
  return { intent_id, entities, confidence: 'high' };
}

describe('routeIntent', () => {
  it('routes to data_modification (A) when data-modifier accepts the intent', () => {
    const tryFn: TryDataModificationFn = (id) => id === 'machine_unavailability';
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', { machine_id: 'M02', start_min: 2160, end_min: 2520 }),
      baseline,
      catalog,
      tryDataModification: tryFn,
    });
    expect(out.kind).toBe('data_modification');
    if (out.kind !== 'data_modification') return;
    expect(out.intent_id).toBe('machine_unavailability');
    expect(out.entities.machine_id).toBe('M02');
    expect(out.data_modification_applied).toBe(true);
  });

  it('falls back to rule_addition (B) when data-modifier rejects the intent', () => {
    const tryFn: TryDataModificationFn = () => false;
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', { machine_id: 'M02', start_min: 2160, end_min: 2520 }),
      baseline,
      catalog,
      tryDataModification: tryFn,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    const um = (out.rules.unavailable_machines as Record<string, Array<Record<string, unknown>>>)['M02'];
    expect(um).toBeDefined();
    expect(um[0]).toMatchObject({ start_min: 2160, end_min: 2520 });
    expect(out.warnings.some((w) => w.includes('data_modifier_rejected'))).toBe(true);
  });

  it('falls back to rule_addition when no tryDataModification callback is provided', () => {
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', { machine_id: 'M01', start_min: 100, end_min: 200 }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.warnings.some((w) => w.includes('data_modifier_no_implementation'))).toBe(true);
  });

  it('routes order_priority directly to rule_addition (catalog declares rule_addition as primary)', () => {
    const out = routeIntent({
      intent: makeIntent('order_priority', { order_ids: ['COM-007'] }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.rules.priority_orders).toEqual(['COM-007']);
  });

  it('routes intent_id="unknown" to opus_translator (C)', () => {
    const out = routeIntent({
      intent: { intent_id: 'unknown', entities: {}, confidence: 'high', fallback_reasoning: 'parser saw garbage' },
      baseline,
      catalog,
    });
    expect(out.kind).toBe('opus_translator');
    if (out.kind !== 'opus_translator') return;
    expect(out.reason).toContain('parser saw garbage');
  });

  it('routes an id not in the catalog to opus_translator (C)', () => {
    const out = routeIntent({
      intent: makeIntent('quantum_teleportation', { foo: 'bar' }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('opus_translator');
    if (out.kind !== 'opus_translator') return;
    expect(out.reason).toContain('intent_id_not_in_catalog');
  });

  it('falls through to opus_translator when entity validation fails (unknown order id)', () => {
    const out = routeIntent({
      intent: makeIntent('order_priority', { order_ids: ['COM-999'] }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('opus_translator');
    if (out.kind !== 'opus_translator') return;
    expect(out.reason).toContain('unknown_order:COM-999');
  });

  it('applies horizon_end default when end_min is missing on a data_modification intent', () => {
    // No tryDataModification → falls through to rule_addition, which is
    // where the default surfaces in the rules payload.
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', { machine_id: 'M01', start_min: 100 }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    const window = (out.rules.unavailable_machines as Record<string, Array<Record<string, unknown>>>)['M01'][0];
    expect(window.start_min).toBe(100);
    expect(window.end_min).toBe(4320);
    expect(out.warnings.some((w) => w.includes('default_applied:end_min=horizon_end(4320)'))).toBe(true);
  });

  it('rejects negative start_min via non_negative_int validator', () => {
    // F-W10-04: machine_unavailability.start_min now uses `non_negative_int`
    // (0 = start-of-horizon is legit). Negative values are still rejected.
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', { machine_id: 'M01', start_min: -50, end_min: 100 }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('opus_translator');
    if (out.kind !== 'opus_translator') return;
    expect(out.reason).toContain('entity_validation_failed:start_min:not_a_non_negative_int');
  });

  it('rejects end_min <= start_min via gt_start validator', () => {
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', { machine_id: 'M01', start_min: 500, end_min: 500 }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('opus_translator');
    if (out.kind !== 'opus_translator') return;
    expect(out.reason).toContain('end_min_not_greater_than_start_min');
  });

  it('rejects unknown machine id when baseline has known machines', () => {
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', { machine_id: 'M99', start_min: 100, end_min: 200 }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('opus_translator');
    if (out.kind !== 'opus_translator') return;
    expect(out.reason).toContain('unknown_machine:M99');
  });

  it('Wave 9 T1: shift_window routes to rule_addition (backend consumer now exists)', () => {
    // Wave 9 (w9-backend-rules-consumer 2026-05-23): backend now has a
    // real `shift_window_modified` consumer in f_apply_rules.py with
    // explicit skip reasons on apply_rules[]. The catalog's
    // not_implemented flag was removed, so the router builds a
    // shift_changes rules payload instead of short-circuiting.
    const out = routeIntent({
      intent: makeIntent('shift_window', { shift_id: 'turno_mattina', start_min: 360, end_min: 720 }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.warnings.some((w) => w.startsWith('not_implemented'))).toBe(false);
    expect(out.rules).toBeDefined();
    expect(out.rules.shift_changes).toBeDefined();
  });

  it('Wave 9 T1: capacity_addition routes to rule_addition (backend consumer now exists)', () => {
    // Wave 9 (w9-backend-rules-consumer 2026-05-23): backend now has a
    // real `extra_capacity_added` consumer in f_apply_rules.py. The
    // not_implemented flag was removed and the router builds an
    // extra_capacity rules payload.
    const out = routeIntent({
      intent: makeIntent('capacity_addition', { operators: 1, shift: 'serale' }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.warnings.some((w) => w.startsWith('not_implemented'))).toBe(false);
    expect(out.rules).toBeDefined();
    expect(out.rules.extra_capacity).toBeDefined();
  });

  // === F-W8-01 regression guards (devils-advocate R3 symmetric) ===
  // The `not_implemented` flag is per-intent. A future catalog mutation
  // that accidentally widens the flag to a fully-implemented intent must
  // fail loud and fast — these two negative tests are the trip-wire.

  it('F-W8-01 regression guard: deadline_change is NOT marked unsupported', () => {
    const tryFn: TryDataModificationFn = (id) => id === 'deadline_change';
    const out = routeIntent({
      intent: makeIntent('deadline_change', { order_id: 'COM-002', new_deadline_min: 3960 }),
      baseline,
      catalog,
      tryDataModification: tryFn,
    });
    expect(out.kind).toBe('data_modification');
    if (out.kind !== 'data_modification') return;
    expect(out.warnings.some((w) => /not_implemented/.test(w))).toBe(false);
  });

  it('F-W8-01 regression guard: machine_unavailability is NOT marked unsupported', () => {
    // canApply is false for machine_unavailability today (data-modifier
    // excludes it) so the router cascades to rule_addition via the
    // catalog's fallback_strategy. Either kind is acceptable — what
    // matters is "NOT unsupported".
    const tryFn: TryDataModificationFn = () => null;
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', { machine_id: 'M01', start_min: 600, end_min: 1200 }),
      baseline,
      catalog,
      tryDataModification: tryFn,
    });
    expect(out.kind).not.toBe('unsupported');
    expect(out.warnings.some((w) => /not_implemented/.test(w))).toBe(false);
  });

  it('F-W8-01 regression guard: order_priority is NOT marked unsupported', () => {
    const out = routeIntent({
      intent: makeIntent('order_priority', { order_ids: ['COM-007'] }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.warnings.some((w) => /not_implemented/.test(w))).toBe(false);
  });

  // === B-W8-S-01 canonicalise machine/order IDs (stress-engineer 2026-05-22) ===
  // Pre-fix the strict validator rejected Haiku's natural output like "M2"
  // (vs baseline "M02"), cascading to the Opus translator at ~$0.25/call.
  // Canonicalisation runs deterministically in the router with zero LLM cost.

  it('B-W8-S-01: canonicalises M2 → M02 when baseline has zero-padded machines', () => {
    const tryFn: TryDataModificationFn = () => false;
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', {
        machine_id: 'M2', // Haiku natural output, baseline has M01/M02/...
        start_min: 720,
        end_min: 1080,
      }),
      baseline,
      catalog,
      tryDataModification: tryFn,
    });
    // Routes to B (rule_addition) instead of falling through to opus_translator.
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.entities.machine_id).toBe('M02');
    expect(out.warnings).toContain('canonicalised:machine_id:M2->M02');
    // The wire payload uses the canonical id so the backend's machine
    // lookup hits.
    expect(out.rules.unavailable_machines).toEqual({ M02: [{ start_min: 720, end_min: 1080 }] });
  });

  it('B-W8-S-01: canonicalises M-2 → M02 (handles hyphens / separators)', () => {
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', {
        machine_id: 'M-2',
        start_min: 100,
        end_min: 200,
      }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.entities.machine_id).toBe('M02');
    expect(out.warnings).toContain('canonicalised:machine_id:M-2->M02');
  });

  it('B-W8-S-01: canonicalises lowercase m02 → M02', () => {
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', {
        machine_id: 'm02',
        start_min: 100,
        end_min: 200,
      }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.entities.machine_id).toBe('M02');
  });

  it('B-W8-S-01: canonicalises order ids in array (each_must_exist_in_solution_orders)', () => {
    // order_priority takes order_ids:string[] — each entry is canonicalised
    // independently so a mixed-form input ["COM-1", "COM-002"] becomes
    // ["COM-001", "COM-002"].
    const out = routeIntent({
      intent: makeIntent('order_priority', { order_ids: ['COM-1', 'COM-002'] }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.entities.order_ids).toEqual(['COM-001', 'COM-002']);
    expect(out.warnings).toContain('canonicalised:order_ids:COM-1->COM-001');
  });

  it('B-W8-S-01: leaves the value alone when no canonical variant matches (no false positive)', () => {
    // M99 is genuinely unknown — canonicalisation must NOT invent a
    // match. The router falls through to opus_translator as before.
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', {
        machine_id: 'M99',
        start_min: 100,
        end_min: 200,
      }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('opus_translator');
    if (out.kind !== 'opus_translator') return;
    expect(out.reason).toContain('unknown_machine:M99');
  });

  it('B-W8-S-01: already-canonical M02 passes through without a canonicalised warning', () => {
    // Regression guard: don't add a noise warning when the input already
    // matches a known id verbatim.
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', {
        machine_id: 'M02',
        start_min: 100,
        end_min: 200,
      }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.entities.machine_id).toBe('M02');
    const canonWarnings = out.warnings.filter((w) => w.startsWith('canonicalised:'));
    expect(canonWarnings).toEqual([]);
  });

  it('B-W8-S-06 (false-alarm post-mortem): empty baseline → no canonicalisation, raw M2 passes through', () => {
    // B-W8-S-06 was reported as a real bug but turned out to be a probe
    // setup issue: the team-lead's curl sent `originalSolution: {}`, so
    // `deriveIds` returned an empty machines set. With `ids.machines.size
    // === 0`, two things happen by design:
    //   1. `canonicaliseId(raw, knownEmpty)` returns null at line 197 →
    //      the canonicalise branch falls through and `normalised[name] = raw`.
    //   2. `validateField` for `must_exist_in_solution_machines` skips
    //      the existence check (line 251 `ids.machines.size > 0 &&`) →
    //      the validator accepts ANY string.
    //
    // Net effect: empty baseline → "M2" passes through to the rules
    // payload as "M2" (not "M02"), and the backend later marks the rule
    // as `unavailable_machine_skipped` because "M2" is not in the
    // dataset. The real-world UI never hits this path (it always sends
    // the baseline from the previous solve), but if a caller forgets to
    // populate originalSolution, the silent-canonicalisation-skip
    // behaviour is the explanation.
    //
    // This test pins that behaviour so a future regression that, say,
    // hard-fails on empty baseline (cascading to Opus translator and
    // burning $0.20) shows up loudly here.
    const emptyBaseline: BaselineFasi = { fasi: [] };
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', {
        machine_id: 'M2',
        start_min: 480,
        end_min: 1080,
      }),
      baseline: emptyBaseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    // The canonicalise path didn't fire (no machines to match against),
    // so the raw "M2" reaches the rules payload unchanged.
    expect(out.entities.machine_id).toBe('M2');
    const canonWarnings = out.warnings.filter((w) => w.startsWith('canonicalised:'));
    expect(canonWarnings).toEqual([]);
    // The rules payload mirrors entities — the backend will reject this
    // with `unavailable_machine_skipped` because "M2" is not in the
    // dataset, but that's the documented degraded behaviour for an
    // empty-baseline caller, not a router bug.
    expect(out.rules.unavailable_machines).toEqual({
      M2: [{ start_min: 480, end_min: 1080 }],
    });
  });
});
