import { describe, it, expect, beforeEach } from 'vitest';
import {
  mergeRuleSlots,
  mergeLedgerRules,
  loadLedger,
  appendRule,
  clearLedger,
  describeLedgerRules,
  removeConstraintFromLedger,
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

describe('describeLedgerRules — per-constraint labels (Option A / Wave 16.7)', () => {
  const labelsOf = (
    rules: Record<string, unknown> | null | undefined,
    opts?: { dayLengthMin?: number },
  ) => describeLedgerRules(rules, opts).map((x) => x.label);

  it('summarizes the EXACT merged priorRules that caused the "tutto a G2" bug', () => {
    // The real folded ledger captured live from Paolo's browser: a stale
    // M01-down-day1 + M02-down-day2 + COM-012 priority, silently merged into
    // "anticipo COM-007". The panel must spell each one out (day_anchor is
    // meta → ignored). No dayLengthMin → calendar-day (1440) fallback.
    const rules = {
      unavailable_machines: {
        M02: [{ start_min: 1440, end_min: 2880 }],
        M01: [{ start_min: 0, end_min: 960, date: '2026-04-01' }],
      },
      day_anchor: 1,
      priority_orders: ['COM-012', 'COM-007'],
    };
    expect(labelsOf(rules)).toEqual([
      'M01 ferma (giorno 1)',
      'M02 ferma (giorno 2)',
      'COM-012 prioritaria',
      'COM-007 prioritaria',
    ]);
  });

  it('uses the real working-day length so "giorno N" is correct (the "giorno 1-2" bug)', () => {
    // demo-commesse day_length_min = 960; window [960,1920] IS day 2 (not 1-2).
    expect(
      labelsOf({ unavailable_machines: { M03: [{ start_min: 960, end_min: 1920 }] } }, { dayLengthMin: 960 }),
    ).toEqual(['M03 ferma (giorno 2)']);
    // Without the real day length, the same window mislabels as "giorno 1-2".
    expect(
      labelsOf({ unavailable_machines: { M03: [{ start_min: 960, end_min: 1920 }] } }),
    ).toEqual(['M03 ferma (giorno 1-2)']);
  });

  it('tags each label with the (slot,key) needed to remove it individually', () => {
    const out = describeLedgerRules({
      unavailable_machines: { M03: [{ start_min: 960, end_min: 1920 }] },
      priority_orders: ['COM-007'],
      deadline_changes: { 'COM-001': { new_deadline_min: 100 } },
      shift_changes: [{ x: 1 }],
    });
    expect(out).toContainEqual(expect.objectContaining({ slot: 'unavailable_machines', key: 'M03' }));
    expect(out).toContainEqual(expect.objectContaining({ slot: 'priority_orders', key: 'COM-007' }));
    expect(out).toContainEqual(expect.objectContaining({ slot: 'deadline_changes', key: 'COM-001' }));
    expect(out).toContainEqual(expect.objectContaining({ slot: 'shift_changes', key: '*' }));
  });

  it('returns [] for empty / null / meta-only input', () => {
    expect(describeLedgerRules({})).toEqual([]);
    expect(describeLedgerRules(null)).toEqual([]);
    expect(describeLedgerRules(undefined)).toEqual([]);
    expect(describeLedgerRules({ day_anchor: 2, status: 'ok' })).toEqual([]);
  });

  it('falls back to the date field when a window has no numeric bounds', () => {
    expect(
      labelsOf({ unavailable_machines: { M04: [{ date: '2026-04-05' }] } }),
    ).toEqual(['M04 ferma (2026-04-05)']);
  });

  it('summarizes deadline_changes per order and other slots generically', () => {
    expect(labelsOf({ deadline_changes: { 'COM-001': { new_deadline_min: 100 } } }))
      .toEqual(['scadenza COM-001 modificata']);
    expect(labelsOf({ shift_changes: [{ x: 1 }] })).toEqual(['turni modificati']);
    expect(labelsOf({ extra_capacity: [{ y: 2 }] })).toEqual(['capacità extra']);
  });

  // Wave 16.8 — `describeWindow` must label days by the company's REAL
  // working-day length. The 1440 fallback is the LAST RESORT (only when
  // dayLengthMin is absent). These cases pin both ends so the 1440 stays a
  // fallback, not a baked-in assumption (feedback_no_assertion_relaxation).
  describe('Wave 16.8 — "giorno N" label honours dayLengthMin (1440 = last resort)', () => {
    const W = { unavailable_machines: { M03: [{ start_min: 960, end_min: 1920 }] } };

    it('dayLengthMin ABSENT → falls back to the 1440 calendar day (mislabels as "giorno 1-2")', () => {
      // The pre-fix behaviour, kept ONLY as the no-day-length fallback: a
      // [960,1920) window spans two calendar days at 1440 → "giorno 1-2".
      expect(labelsOf(W)).toEqual(['M03 ferma (giorno 1-2)']);
      expect(labelsOf(W, {})).toEqual(['M03 ferma (giorno 1-2)']);
      expect(labelsOf(W, { dayLengthMin: undefined })).toEqual(['M03 ferma (giorno 1-2)']);
    });

    it('dayLengthMin=960 (demo plant) → correct single "giorno 2"', () => {
      // [960,1920) with a 960-min day is exactly day 2 (end exclusive).
      expect(labelsOf(W, { dayLengthMin: 960 })).toEqual(['M03 ferma (giorno 2)']);
      // And it is NOT the wrong calendar-day label.
      expect(labelsOf(W, { dayLengthMin: 960 })).not.toEqual(['M03 ferma (giorno 1-2)']);
    });

    it('day boundaries align for both day lengths (start of day 1, start of day 2)', () => {
      const day1 = { unavailable_machines: { M01: [{ start_min: 0, end_min: 960 }] } };
      // 960-day: [0,960) is day 1; 1440-day: [0,960) is still day 1 (within it).
      expect(labelsOf(day1, { dayLengthMin: 960 })).toEqual(['M01 ferma (giorno 1)']);
      expect(labelsOf(day1, { dayLengthMin: 1440 })).toEqual(['M01 ferma (giorno 1)']);
      // 960-day: [960,1920) is day 2; 1440-day: spans days 1-2.
      const day2 = { unavailable_machines: { M01: [{ start_min: 960, end_min: 1920 }] } };
      expect(labelsOf(day2, { dayLengthMin: 960 })).toEqual(['M01 ferma (giorno 2)']);
      expect(labelsOf(day2, { dayLengthMin: 1440 })).toEqual(['M01 ferma (giorno 1-2)']);
    });

    it('non-positive dayLengthMin is ignored → 1440 last-resort fallback', () => {
      expect(labelsOf(W, { dayLengthMin: 0 })).toEqual(['M03 ferma (giorno 1-2)']);
      expect(labelsOf(W, { dayLengthMin: -100 })).toEqual(['M03 ferma (giorno 1-2)']);
    });
  });
});

describe('removeConstraintFromLedger — per-chip × (Wave 16.7)', () => {
  const SLUG2 = 'acme-spa';
  beforeEach(() => {
    localStorage.clear();
  });

  it('removes only the targeted machine, keeping the others', () => {
    appendRule(SLUG2, { source: 'reschedule', rules: { unavailable_machines: { M03: [{ start_min: 960, end_min: 1920 }] } } });
    appendRule(SLUG2, { source: 'reschedule', rules: { unavailable_machines: { M02: [{ start_min: 960, end_min: 1920 }] } } });
    removeConstraintFromLedger(SLUG2, 'unavailable_machines', 'M03');
    const merged = mergeLedgerRules(SLUG2) as { unavailable_machines: Record<string, unknown> };
    expect(merged.unavailable_machines.M02).toBeDefined();
    expect(merged.unavailable_machines.M03).toBeUndefined();
  });

  it('removes a single priority order from the array', () => {
    appendRule(SLUG2, { source: 'whatif', rules: { priority_orders: ['COM-012'] } });
    appendRule(SLUG2, { source: 'whatif', rules: { priority_orders: ['COM-007'] } });
    removeConstraintFromLedger(SLUG2, 'priority_orders', 'COM-012');
    expect(mergeLedgerRules(SLUG2)).toEqual({ priority_orders: ['COM-007'] });
  });

  it('prunes an entry left with only meta keys after removal', () => {
    appendRule(SLUG2, {
      source: 'reschedule',
      rules: { unavailable_machines: { M03: [{ start_min: 0, end_min: 960 }] }, day_anchor: 2 },
    });
    removeConstraintFromLedger(SLUG2, 'unavailable_machines', 'M03');
    expect(loadLedger(SLUG2)).toEqual([]);
  });

  it('is a no-op for null slug / empty ledger and never throws', () => {
    expect(() => removeConstraintFromLedger(null, 'unavailable_machines', 'M03')).not.toThrow();
    expect(() => removeConstraintFromLedger('empty-co', 'priority_orders', 'X')).not.toThrow();
  });
});
