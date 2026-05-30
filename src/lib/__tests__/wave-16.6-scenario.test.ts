import { describe, it, expect } from 'vitest';
import { resolveMachineAlias, resolveOrderAlias, resolveAgainstSet } from '@/lib/entityResolver';
import { canonicaliseId } from '@/lib/idCanon';
import { buildMachineAliases, type SolutionContext } from '@/lib/solutionContext';
import { mergeRuleSlots, mergeLedgerRules, type AppliedRule } from '@/lib/appliedRulesLedger';

/**
 * Wave 16.6 — deterministic end-to-end scenario coverage (e2e-tester, task #4).
 *
 * These tests exercise the SAME closed set the live demo-commesse plan exposes
 * (solved against the running backend on 2026-05-30):
 *   machines = M01..M05, orders = COM-001..COM-015, COM-007 baseline-routed to M02.
 *
 * They pin the anti-hallucination + cumulative-ledger contract at the pure-lib
 * layer so a regression is caught WITHOUT a live LLM call. The live MCP-Chrome
 * run verifies the same flow against the real solver + both Gantts.
 */

const DEMO_MACHINES = ['M01', 'M02', 'M03', 'M04', 'M05'];
const DEMO_ORDERS = [
  'COM-001', 'COM-002', 'COM-003', 'COM-004', 'COM-005',
  'COM-006', 'COM-007', 'COM-008', 'COM-009', 'COM-010',
  'COM-011', 'COM-012', 'COM-013', 'COM-014', 'COM-015',
];

function demoCtx(): SolutionContext {
  return {
    machines: DEMO_MACHINES,
    machine_aliases: buildMachineAliases(DEMO_MACHINES),
    orders: DEMO_ORDERS,
    shifts: ['mattina', 'pomeriggio'],
    time_config: { day_length_min: 960, start_date: '2026-04-01' },
    shift_types: { mattina: { start: 0, end: 480 }, pomeriggio: { start: 480, end: 960 } },
    order_deadlines: null,
  };
}

describe('Wave 16.6 — entity resolver against the real demo-commesse closed set', () => {
  const ctx = demoCtx();

  // ── Anti-hallucination: HIT path (m2 → M02) ─────────────────────────
  it.each([
    ['m2', 'M02'],
    ['M2', 'M02'],
    ['M-2', 'M02'],
    ['M 2', 'M02'],
    ['M02', 'M02'],
    ['m02', 'M02'],
    ['macchina 2', 'M02'],
    ['linea 2', 'M02'],
    ['macchina numero due'.replace('numero due', '2'), 'M02'], // verbose normalised upstream by Haiku to "M2"/"2"
  ])('resolves loose machine token "%s" → "%s"', (token, expected) => {
    expect(resolveMachineAlias(token, ctx)).toBe(expected);
  });

  it('resolves every canonical machine id to itself (idempotent)', () => {
    for (const m of DEMO_MACHINES) {
      expect(resolveMachineAlias(m, ctx)).toBe(m);
    }
  });

  // ── Anti-hallucination: REJECT path (M99 → null, never invents) ─────
  it.each(['M99', 'm99', 'M-99', 'macchina 99', 'linea 42', 'M6', 'macchina 6', 'XYZ', 'M0'])(
    'rejects off-set machine token "%s" → null (NEVER fabricates an id)',
    (token) => {
      const r = resolveMachineAlias(token, ctx);
      expect(r).toBeNull();
      // Hard contract: if it ever returns non-null, it MUST be a member of the set.
      if (r !== null) expect(DEMO_MACHINES).toContain(r);
    },
  );

  it('canonicaliseId never returns a non-member for an off-set token', () => {
    const known = new Set(DEMO_MACHINES);
    for (const bad of ['M99', 'M6', 'M00', 'Q1', '99']) {
      const r = canonicaliseId(bad, known);
      expect(r === null || known.has(r)).toBe(true);
    }
  });

  // ── Order resolution (COM-007 and loose forms) ──────────────────────
  it.each([
    ['COM-007', 'COM-007'],
    ['com-007', 'COM-007'],
    ['COM7', 'COM-007'],
    ['com7', 'COM-007'],
    ['COM-7', 'COM-007'],
  ])('resolves order token "%s" → "%s"', (token, expected) => {
    expect(resolveOrderAlias(token, ctx)).toBe(expected);
  });

  it.each(['COM-099', 'COM99', 'COM-042', 'ZZZ-001'])(
    'rejects off-set order token "%s" → null',
    (token) => {
      const r = resolveOrderAlias(token, ctx);
      expect(r).toBeNull();
      if (r !== null) expect(DEMO_ORDERS).toContain(r);
    },
  );

  // ── Ambiguity handling at the alias layer (collision → dropped) ─────
  it('the collision-safe alias builder DROPS an alias two machines would both claim', () => {
    // Two machines that would both claim the bare "m1" alias.
    const colliding = ['M-001', 'M1'];
    const aliases = buildMachineAliases(colliding);
    // The collision-safe builder must have DROPPED the shared "m1" key so the
    // alias-map step (resolver step 3) can never silently pick one of them.
    expect(aliases['m1']).toBeUndefined();
  });

  it('canonical-form preference: an exact uppercase member wins over a pad-variant sibling (NOT a fabrication)', () => {
    // With BOTH "M1" and "M-001" present, "m1" resolves to the exact
    // uppercase form "M1" via canonicaliseId. That is a real member of the
    // set, not an invented id — the hard contract (never fabricate) holds.
    // Documented so a future change to step ordering is a conscious choice.
    const set = ['M-001', 'M1'];
    const r = resolveAgainstSet('m1', set, buildMachineAliases(set));
    expect(set).toContain(r); // whatever it picks, it MUST be a member
    expect(r).toBe('M1');
  });

  it('empty closed set resolves nothing (no plan loaded yet)', () => {
    const empty: SolutionContext = { ...ctx, machines: [], machine_aliases: {}, orders: [] };
    expect(resolveMachineAlias('m2', empty)).toBeNull();
    expect(resolveOrderAlias('COM-007', empty)).toBeNull();
  });
});

describe('Wave 16.6 — cumulative applied-rules ledger (What-If carries state)', () => {
  // Models the live scenario:
  //   1) Ripianifica "giorno 2, M2 rotta" → accepted → ledger entry #1.
  //   2) What-If "COM-007 giorno 2 dalle 12 prima di tutte" → accepted → entry #2.
  //   3) A SECOND What-If must STILL see M2 broken (carried from the ledger).
  const M2_BROKEN: Record<string, unknown> = {
    unavailable_machines: { M02: [{ start_min: 960, end_min: 1812 }] },
  };
  const COM007_PRIORITY: Record<string, unknown> = {
    priority_orders: ['COM-007'],
  };

  it('mergeRuleSlots unions distinct slots (M2 downtime + COM-007 priority coexist)', () => {
    const merged = mergeRuleSlots(M2_BROKEN, COM007_PRIORITY);
    expect(merged.unavailable_machines).toEqual({ M02: [{ start_min: 960, end_min: 1812 }] });
    expect(merged.priority_orders).toEqual(['COM-007']);
  });

  it('folding the ledger keeps M2-broken present for the SECOND What-If', () => {
    const ledger: AppliedRule[] = [
      { id: 'ar-1', ts: 1, source: 'reschedule', rules: M2_BROKEN, cutoffMin: 960 },
      { id: 'ar-2', ts: 2, source: 'whatif', rules: COM007_PRIORITY, cutoffMin: 960 },
    ];
    const folded = mergeLedgerRules(ledger);
    // Prior accepted M2 downtime is STILL in the folded payload — the second
    // What-If solve will receive it, so the candidate cannot silently re-use M2.
    expect(folded.unavailable_machines).toEqual({ M02: [{ start_min: 960, end_min: 1812 }] });
    expect(folded.priority_orders).toEqual(['COM-007']);

    // A brand-new (second) What-If scenario merged ON TOP must still carry M2.
    const secondScenario: Record<string, unknown> = { priority_orders: ['COM-003'] };
    const forSolve = mergeRuleSlots(folded, secondScenario);
    expect(forSolve.unavailable_machines).toEqual({ M02: [{ start_min: 960, end_min: 1812 }] });
    expect(forSolve.priority_orders).toEqual(['COM-007', 'COM-003']);
  });

  it('NEW-WINS: re-issuing M2 downtime replaces the prior window (no double downtime)', () => {
    const earlier: Record<string, unknown> = {
      unavailable_machines: { M02: [{ start_min: 960, end_min: 1200 }] },
    };
    const later: Record<string, unknown> = {
      unavailable_machines: { M02: [{ start_min: 960, end_min: 1812 }] },
    };
    const merged = mergeRuleSlots(earlier, later);
    // The newer window wins wholesale for M02 — not two disjoint downtimes.
    expect(merged.unavailable_machines).toEqual({ M02: [{ start_min: 960, end_min: 1812 }] });
  });

  it('different machines accumulate (M02 broken AND M03 broken both survive)', () => {
    const m2: Record<string, unknown> = { unavailable_machines: { M02: [{ start_min: 0, end_min: 100 }] } };
    const m3: Record<string, unknown> = { unavailable_machines: { M03: [{ start_min: 0, end_min: 100 }] } };
    const merged = mergeRuleSlots(m2, m3);
    expect(Object.keys(merged.unavailable_machines as object).sort()).toEqual(['M02', 'M03']);
  });

  it('empty / null payloads fold to nothing (no spurious slots)', () => {
    expect(mergeLedgerRules([])).toEqual({});
    expect(mergeRuleSlots(null, null)).toEqual({});
    expect(mergeRuleSlots({}, COM007_PRIORITY)).toEqual({ priority_orders: ['COM-007'] });
  });
});
