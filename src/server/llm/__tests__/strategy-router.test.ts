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

  it('builds shift_changes rules when shift_window provides start and end', () => {
    const out = routeIntent({
      intent: makeIntent('shift_window', { shift_id: 'turno_mattina', start_min: 360, end_min: 720 }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.rules.shift_changes).toEqual({ turno_mattina: { start_min: 360, end_min: 720 } });
  });

  it('builds extra_capacity rules for capacity_addition with shift only', () => {
    const out = routeIntent({
      intent: makeIntent('capacity_addition', { operators: 1, shift: 'serale' }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.rules.extra_capacity).toEqual({ operators: 1, shift: 'serale' });
  });
});
