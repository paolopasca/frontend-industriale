import { describe, it, expect, beforeEach } from 'vitest';
import { routeIntent, type BaselineFasi } from '../strategy-router';
import { loadCatalog, resetCatalogCache, type ConstraintCatalog } from '../catalog/loader';
import type { Intent } from '../intent-parser';

/**
 * F-W10-04 — `positive_int` validator now means strict positivity
 * (`v > 0`). Fields where 0 is a legit start-of-horizon value (start_min,
 * new_deadline_min) declare `non_negative_int` (`v >= 0`).
 *
 * Pre-W10, the validator name was mis-named: it accepted `0` for ALL
 * `positive_int` fields, so the explicit guard in `routeIntent`
 * compensated for `operators: 0`. This test suite pins the new semantic
 * so a future relaxation regresses loudly.
 */

let catalog: ConstraintCatalog;

beforeEach(() => {
  resetCatalogCache();
  catalog = loadCatalog();
});

const baseline: BaselineFasi = {
  fasi: [
    { commessa: 'COM-001', macchina: 'M01', operatore: 'OP-1', start_min: 0, end_min: 120 },
  ],
  horizon_end_min: 4320,
};

function makeIntent(intent_id: string, entities: Record<string, unknown>): Intent {
  return { intent_id, entities, confidence: 'high' };
}

describe('positive_int validator — strictly > 0 (F-W10-04)', () => {
  it('rejects operators=0 at the catalog validator (capacity_addition)', () => {
    const out = routeIntent({
      intent: makeIntent('capacity_addition', { operators: 0, shift: 'serale' }),
      baseline,
      catalog,
    });
    // Strict positive_int catches 0 → opus_translator fallback.
    expect(out.kind).toBe('opus_translator');
    if (out.kind !== 'opus_translator') return;
    expect(out.reason).toContain('entity_validation_failed:operators:not_a_positive_int');
  });

  it('accepts operators=1 at the catalog validator (capacity_addition)', () => {
    const out = routeIntent({
      intent: makeIntent('capacity_addition', { operators: 1, shift: 'serale' }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
  });

  it('rejects duration_min=0 at the catalog validator (capacity_addition)', () => {
    const out = routeIntent({
      intent: makeIntent('capacity_addition', { operators: 1, duration_min: 0, shift: 'serale' }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('opus_translator');
    if (out.kind !== 'opus_translator') return;
    expect(out.reason).toContain('entity_validation_failed:duration_min:not_a_positive_int');
  });
});

describe('non_negative_int validator — >= 0 (F-W10-04)', () => {
  it('accepts start_min=0 (start-of-horizon) for machine_unavailability', () => {
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', {
        machine_id: 'M01',
        start_min: 0,
        end_min: 60,
      }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
  });

  it('rejects start_min=-1 for machine_unavailability', () => {
    const out = routeIntent({
      intent: makeIntent('machine_unavailability', {
        machine_id: 'M01',
        start_min: -1,
        end_min: 60,
      }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('opus_translator');
    if (out.kind !== 'opus_translator') return;
    expect(out.reason).toContain('entity_validation_failed:start_min:not_a_non_negative_int');
  });

  it('accepts new_deadline_min=0 (deadline at start-of-horizon) for deadline_change', () => {
    const out = routeIntent({
      intent: makeIntent('deadline_change', {
        order_id: 'COM-001',
        new_deadline_min: 0,
      }),
      baseline,
      catalog,
    });
    // deadline_change has strategy=data_modification → falls through to
    // rule_addition because no data-modifier callback was provided here.
    expect(out.kind).toBe('rule_addition');
  });

  it('accepts shift_window start_min=0 (midnight start)', () => {
    const out = routeIntent({
      intent: makeIntent('shift_window', {
        shift_id: 'turno_mattina',
        start_min: 0,
        end_min: 60,
      }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
  });
});
