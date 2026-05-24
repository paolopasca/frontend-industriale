import { describe, it, expect, beforeEach } from 'vitest';
import { routeIntent, type BaselineFasi } from '../strategy-router';
import { loadCatalog, resetCatalogCache, type ConstraintCatalog } from '../catalog/loader';
import type { Intent } from '../intent-parser';

/**
 * F-W9-05 (devils-advocate Wave 9 2026-05-23) — BFF guard for the
 * `extra_capacity` rule key.
 *
 * Pre-guard, the catalog declared `operators: required: false,
 * positive_int`. `positive_int` accepts 0, and `required: false` means
 * undefined slips through validation. Either case produced a
 * `rule_addition` outcome with an extra_capacity payload that the
 * backend silently no-ops on (or, worse, the UI displays "1 vincolo
 * applicato" with zero real-world effect).
 *
 * The router now short-circuits to `unsupported` when `operators` is
 * not a positive integer, so the BFF can surface a clear "non
 * applicabile" warning instead of pretending the rule landed.
 *
 * These tests pin the contract independently of the main router suite
 * so a future relaxation of the guard fails loudly.
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
  ],
  horizon_end_min: 4320,
};

function makeIntent(entities: Record<string, unknown>): Intent {
  return { intent_id: 'capacity_addition', entities, confidence: 'high' };
}

describe('routeIntent — extra_capacity guard (F-W9-05)', () => {
  it('rejects zero operators as unsupported', () => {
    const out = routeIntent({
      intent: makeIntent({ operators: 0, shift: 'serale' }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('unsupported');
    if (out.kind !== 'unsupported') return;
    expect(out.intent_id).toBe('capacity_addition');
    expect(out.reason).toContain('invalid_extra_capacity_count');
    expect(out.reason).toContain('0');
  });

  it('rejects negative operators as unsupported', () => {
    const out = routeIntent({
      intent: makeIntent({ operators: -1, shift: 'serale' }),
      baseline,
      catalog,
    });
    // The catalog's positive_int validator catches negative values first
    // and routes to opus_translator. The guard here is for values that
    // pass the validator (0, non-integers) but still need rejection.
    // Either outcome — opus_translator or unsupported — is acceptable
    // because BOTH express "this is not a viable rule_addition". What
    // is NOT acceptable is `rule_addition`: that would emit a bogus
    // payload with operators=-1.
    expect(out.kind).not.toBe('rule_addition');
    expect(out.kind).not.toBe('data_modification');
  });

  it('rejects non-integer operators (1.5) as unsupported', () => {
    const out = routeIntent({
      intent: makeIntent({ operators: 1.5, shift: 'serale' }),
      baseline,
      catalog,
    });
    // positive_int validator already requires Integer, so non-integer
    // is filtered at validation stage → opus_translator. Either
    // opus_translator OR unsupported is acceptable; what matters is
    // we do NOT emit an extra_capacity payload with a fractional count.
    expect(out.kind).not.toBe('rule_addition');
    expect(out.kind).not.toBe('data_modification');
  });

  it('rejects undefined operators as unsupported', () => {
    // The catalog marks `operators` as required:false, so undefined
    // passes the entity validator. The guard catches it here.
    const out = routeIntent({
      intent: makeIntent({ shift: 'serale' }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('unsupported');
    if (out.kind !== 'unsupported') return;
    expect(out.intent_id).toBe('capacity_addition');
    expect(out.reason).toContain('invalid_extra_capacity_count');
    expect(out.reason).toContain('undefined');
  });

  it('passes through with a positive integer operators count', () => {
    const out = routeIntent({
      intent: makeIntent({ operators: 2, shift: 'serale' }),
      baseline,
      catalog,
    });
    expect(out.kind).toBe('rule_addition');
    if (out.kind !== 'rule_addition') return;
    expect(out.intent_id).toBe('capacity_addition');
    const ec = out.rules.extra_capacity as Record<string, unknown>;
    expect(ec).toBeDefined();
    expect(ec.operators).toBe(2);
    expect(ec.shift).toBe('serale');
  });
});
