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

  it('rejects negative start_min via positive_int validator', () => {
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', { machine_id: 'M01', start_min: -50, end_min: 100 }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('opus_translator');
    if (out.kind !== 'opus_translator') return;
    expect(out.reason).toContain('entity_validation_failed:start_min:not_a_positive_int');
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

  it('F-W8-01: shift_window short-circuits to unsupported (not_implemented in catalog)', () => {
    // Before F-W8-01 the router built a shift_changes rules payload, but
    // f_apply_rules.py only logged a passthrough warning, so the rule had
    // no real effect on the schedule. The catalog now flags this intent
    // not_implemented and the router returns `unsupported` with an
    // Italian reason the UI surfaces as a toast.
    const out = routeIntent({
      intent: makeIntent('shift_window', { shift_id: 'turno_mattina', start_min: 360, end_min: 720 }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('unsupported');
    if (out.kind !== 'unsupported') return;
    expect(out.warnings).toContain('not_implemented:shift_window');
    expect(out.reason).toMatch(/non ancora supportato/i);
  });

  it('F-W8-01: capacity_addition short-circuits to unsupported (not_implemented in catalog)', () => {
    // Same rationale as shift_window: extra_capacity rules were a
    // passthrough at the backend. Router stops the request before the
    // BFF wastes a solve call.
    const out = routeIntent({
      intent: makeIntent('capacity_addition', { operators: 1, shift: 'serale' }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('unsupported');
    if (out.kind !== 'unsupported') return;
    expect(out.warnings).toContain('not_implemented:capacity_addition');
    expect(out.reason).toMatch(/non ancora supportato/i);
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
});
