import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeRuleSlots,
  mergeLedgerRules,
  loadLedger,
  appendRule,
  clearLedger,
  type AppliedRule,
} from '../appliedRulesLedger';

/**
 * Wave 16.6 §C — applied-rules ledger.
 *
 * Two behaviours under test:
 *  1. mergeRuleSlots / mergeLedgerRules — the NEW-WINS fold. A re-applied
 *     constraint for the same target must REPLACE the prior one; a constraint
 *     for a different target must ACCUMULATE; a contradicting newer rule must
 *     WIN over the prior.
 *  2. localStorage persistence (slug-scoped) — append/load/clear round-trip.
 */

const SLUG = 'acme-spa';

describe('appliedRulesLedger — mergeRuleSlots (new-wins)', () => {
  it('key-unions unavailable_machines across different machines', () => {
    const prior = {
      unavailable_machines: { M01: [{ start_min: 0, end_min: 480 }] },
    };
    const next = {
      unavailable_machines: { M02: [{ start_min: 960, end_min: 1440 }] },
    };
    const merged = mergeRuleSlots(prior, next);
    expect(merged.unavailable_machines).toEqual({
      M01: [{ start_min: 0, end_min: 480 }],
      M02: [{ start_min: 960, end_min: 1440 }],
    });
  });

  it('same machine, DISJOINT windows → BOTH survive (append, devil M-1)', () => {
    // Two separate downtimes ("M2 ferma giorno 2" + "M2 ferma giorno 4") must
    // BOTH be honoured. Dropping the earlier one would silently lose an
    // accepted constraint — the exact failure this wave fixes.
    const prior = { unavailable_machines: { M02: [{ start_min: 0, end_min: 480 }] } };
    const next = { unavailable_machines: { M02: [{ start_min: 960, end_min: 1440 }] } };
    const merged = mergeRuleSlots(prior, next) as { unavailable_machines: Record<string, unknown> };
    expect(merged.unavailable_machines.M02).toEqual([
      { start_min: 0, end_min: 480 },
      { start_min: 960, end_min: 1440 },
    ]);
  });

  it('same machine, OVERLAPPING window → newer REPLACES the prior (correction)', () => {
    // Re-issuing/correcting an overlapping downtime replaces it (no
    // double-count). "M2 ferma 0-480" corrected to "M2 ferma 0-600".
    const prior = { unavailable_machines: { M02: [{ start_min: 0, end_min: 480 }] } };
    const next = { unavailable_machines: { M02: [{ start_min: 0, end_min: 600 }] } };
    const merged = mergeRuleSlots(prior, next) as { unavailable_machines: Record<string, unknown> };
    expect(merged.unavailable_machines.M02).toEqual([{ start_min: 0, end_min: 600 }]);
  });

  it('same machine, IDENTICAL window → dedup (no-op re-issue)', () => {
    const prior = { unavailable_machines: { M02: [{ start_min: 0, end_min: 480 }] } };
    const next = { unavailable_machines: { M02: [{ start_min: 0, end_min: 480 }] } };
    const merged = mergeRuleSlots(prior, next) as { unavailable_machines: Record<string, unknown> };
    expect(merged.unavailable_machines.M02).toEqual([{ start_min: 0, end_min: 480 }]);
  });

  it('back-to-back windows (touching at an endpoint) are distinct, both kept', () => {
    // [0,480) and [480,960) touch but do not overlap → two distinct downtimes.
    const prior = { unavailable_machines: { M02: [{ start_min: 0, end_min: 480 }] } };
    const next = { unavailable_machines: { M02: [{ start_min: 480, end_min: 960 }] } };
    const merged = mergeRuleSlots(prior, next) as { unavailable_machines: Record<string, unknown> };
    expect(merged.unavailable_machines.M02).toEqual([
      { start_min: 0, end_min: 480 },
      { start_min: 480, end_min: 960 },
    ]);
  });

  it('dedup-unions priority_orders, prior ids first', () => {
    const merged = mergeRuleSlots(
      { priority_orders: ['COM-001', 'COM-002'] },
      { priority_orders: ['COM-002', 'COM-003'] },
    );
    expect(merged.priority_orders).toEqual(['COM-001', 'COM-002', 'COM-003']);
  });

  it('last-write per order key for deadline_changes', () => {
    const merged = mergeRuleSlots(
      { deadline_changes: { 'COM-001': { new_deadline_min: 1000 }, 'COM-002': { delta_min: 60 } } },
      { deadline_changes: { 'COM-001': { new_deadline_min: 2000 } } },
    ) as { deadline_changes: Record<string, unknown> };
    // COM-001 overwritten by the newer deadline; COM-002 carried forward.
    expect(merged.deadline_changes['COM-001']).toEqual({ new_deadline_min: 2000 });
    expect(merged.deadline_changes['COM-002']).toEqual({ delta_min: 60 });
  });

  it('carries unknown slots through with new-wins fallback', () => {
    const merged = mergeRuleSlots(
      { some_future_slot: 'old', kept_slot: 'A' },
      { some_future_slot: 'new' },
    );
    expect(merged.some_future_slot).toBe('new');
    expect(merged.kept_slot).toBe('A');
  });

  it('handles null / empty inputs without throwing', () => {
    expect(mergeRuleSlots(null, null)).toEqual({});
    expect(mergeRuleSlots({ priority_orders: ['COM-001'] }, null)).toEqual({
      priority_orders: ['COM-001'],
    });
    expect(mergeRuleSlots(null, { priority_orders: ['COM-001'] })).toEqual({
      priority_orders: ['COM-001'],
    });
  });

  it('does not mutate its inputs', () => {
    const prior = { unavailable_machines: { M01: [{ start_min: 0, end_min: 480 }] } };
    const next = { unavailable_machines: { M02: [{ start_min: 0, end_min: 480 }] } };
    const priorCopy = JSON.parse(JSON.stringify(prior));
    const nextCopy = JSON.parse(JSON.stringify(next));
    mergeRuleSlots(prior, next);
    expect(prior).toEqual(priorCopy);
    expect(next).toEqual(nextCopy);
  });
});

describe('appliedRulesLedger — mergeLedgerRules fold (the carry-state property)', () => {
  it('folds chronologically: prior accepted constraint PERSISTS into the next', () => {
    // The canonical Wave 16.6 scenario: manager accepted "M2 ferma day 2",
    // then issues a SECOND what-if "priority COM-007". The fold must carry
    // BOTH — the M2 downtime is not lost when the new priority is applied.
    const ledger: AppliedRule[] = [
      { id: 'a', ts: 1, source: 'whatif', rules: { unavailable_machines: { M02: [{ start_min: 960, end_min: 1440 }] } } },
      { id: 'b', ts: 2, source: 'whatif', rules: { priority_orders: ['COM-007'] } },
    ];
    const folded = mergeLedgerRules(ledger);
    expect(folded.unavailable_machines).toEqual({ M02: [{ start_min: 960, end_min: 1440 }] });
    expect(folded.priority_orders).toEqual(['COM-007']);
  });

  it('a contradicting (OVERLAPPING) newer window WINS over the prior (same machine)', () => {
    // Overlapping windows = the manager corrected the same downtime → newer
    // replaces. (Disjoint windows would instead accumulate — see the merge
    // tests above.)
    const ledger: AppliedRule[] = [
      { id: 'a', ts: 1, source: 'whatif', rules: { unavailable_machines: { M02: [{ start_min: 0, end_min: 480 }] } } },
      { id: 'b', ts: 2, source: 'reschedule', rules: { unavailable_machines: { M02: [{ start_min: 240, end_min: 720 }] } } },
    ];
    const folded = mergeLedgerRules(ledger) as { unavailable_machines: Record<string, unknown> };
    expect(folded.unavailable_machines.M02).toEqual([{ start_min: 240, end_min: 720 }]);
  });

  it('carry-state: same machine, TWO disjoint accepted downtimes both persist across folds', () => {
    // Devil M-1 scenario: "M2 ferma giorno 2" then "M2 ferma giorno 4" — the
    // fold must keep BOTH, not silently drop day 2.
    const ledger: AppliedRule[] = [
      { id: 'a', ts: 1, source: 'whatif', rules: { unavailable_machines: { M02: [{ start_min: 1440, end_min: 2880 }] } } },
      { id: 'b', ts: 2, source: 'whatif', rules: { unavailable_machines: { M02: [{ start_min: 4320, end_min: 5760 }] } } },
    ];
    const folded = mergeLedgerRules(ledger) as { unavailable_machines: Record<string, unknown> };
    expect(folded.unavailable_machines.M02).toEqual([
      { start_min: 1440, end_min: 2880 },
      { start_min: 4320, end_min: 5760 },
    ]);
  });

  it('empty ledger folds to {}', () => {
    expect(mergeLedgerRules([])).toEqual({});
  });
});

describe('appliedRulesLedger — slug-scoped persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('appendRule round-trips through loadLedger', () => {
    appendRule(SLUG, { source: 'whatif', rules: { priority_orders: ['COM-001'] } });
    const ledger = loadLedger(SLUG);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].rules).toEqual({ priority_orders: ['COM-001'] });
    expect(ledger[0].source).toBe('whatif');
    expect(typeof ledger[0].id).toBe('string');
    expect(typeof ledger[0].ts).toBe('number');
  });

  it('appends accumulate in order', () => {
    appendRule(SLUG, { source: 'whatif', rules: { unavailable_machines: { M01: [{ start_min: 0, end_min: 1 }] } } });
    appendRule(SLUG, { source: 'reschedule', rules: { priority_orders: ['COM-007'] } });
    const ledger = loadLedger(SLUG);
    expect(ledger).toHaveLength(2);
    expect(mergeLedgerRules(ledger)).toEqual({
      unavailable_machines: { M01: [{ start_min: 0, end_min: 1 }] },
      priority_orders: ['COM-007'],
    });
  });

  it('appendRule is a no-op for empty rules (no log bloat)', () => {
    appendRule(SLUG, { source: 'whatif', rules: {} });
    expect(loadLedger(SLUG)).toHaveLength(0);
  });

  it('appendRule is a no-op when slug is null', () => {
    expect(appendRule(null, { source: 'whatif', rules: { priority_orders: ['X'] } })).toEqual([]);
  });

  it('clearLedger wipes the slug, leaving other slugs intact', () => {
    appendRule(SLUG, { source: 'whatif', rules: { priority_orders: ['COM-001'] } });
    appendRule('other-co', { source: 'whatif', rules: { priority_orders: ['COM-999'] } });
    clearLedger(SLUG);
    expect(loadLedger(SLUG)).toHaveLength(0);
    expect(loadLedger('other-co')).toHaveLength(1);
  });

  it('persists under the daino:<slug>: namespace (cleared by clearSlugScoped)', () => {
    appendRule(SLUG, { source: 'whatif', rules: { priority_orders: ['COM-001'] } });
    const key = `daino:${SLUG}:applied_rules_ledger`;
    expect(localStorage.getItem(key)).not.toBeNull();
  });

  it('loadLedger tolerates corrupt JSON', () => {
    localStorage.setItem(`daino:${SLUG}:applied_rules_ledger`, '{not json');
    expect(loadLedger(SLUG)).toEqual([]);
  });

  it('mergeLedgerRules accepts a slug and loads the ledger', () => {
    appendRule(SLUG, { source: 'whatif', rules: { priority_orders: ['COM-001'] } });
    appendRule(SLUG, { source: 'whatif', rules: { priority_orders: ['COM-002'] } });
    expect(mergeLedgerRules(SLUG)).toEqual({ priority_orders: ['COM-001', 'COM-002'] });
  });
});
