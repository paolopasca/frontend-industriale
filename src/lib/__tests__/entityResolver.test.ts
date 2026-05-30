import { describe, expect, it } from 'vitest';
import {
  resolveMachineAlias,
  resolveOrderAlias,
  resolveShiftAlias,
  resolveAgainstSet,
} from '../entityResolver';
import { buildMachineAliases, type SolutionContext } from '../solutionContext';
import { canonicaliseId } from '../idCanon';

/**
 * Wave 16.6 — shared entity resolver unit tests (no LLM, no network).
 *
 * The resolver is the deterministic anti-hallucination primitive: a manager
 * token resolves to a CANONICAL id in the closed set or to null. It must never
 * fabricate an id and must refuse ambiguous tokens.
 */

function ctxOf(partial: Partial<SolutionContext>): SolutionContext {
  const machines = partial.machines ?? [];
  return {
    machines,
    machine_aliases: partial.machine_aliases ?? buildMachineAliases(machines),
    orders: partial.orders ?? [],
    shifts: partial.shifts ?? [],
    time_config: null,
    shift_types: partial.shift_types ?? null,
    order_deadlines: null,
  };
}

const PLAN = ctxOf({
  machines: ['M01', 'M02', 'M03', 'M04', 'M05'],
  orders: ['COM-001', 'COM-007'],
  shifts: ['turno_mattina', 'turno_pomeriggio', 'turno_serale'],
});

describe('resolveMachineAlias', () => {
  it('resolves "m2" → M02', () => {
    expect(resolveMachineAlias('m2', PLAN)).toBe('M02');
  });
  it('resolves "M2" → M02', () => {
    expect(resolveMachineAlias('M2', PLAN)).toBe('M02');
  });
  it('resolves "M-02" → M02', () => {
    expect(resolveMachineAlias('M-02', PLAN)).toBe('M02');
  });
  it('resolves exact "M02" → M02', () => {
    expect(resolveMachineAlias('M02', PLAN)).toBe('M02');
  });
  it('resolves "linea 2" → M02 via NL alias', () => {
    expect(resolveMachineAlias('linea 2', PLAN)).toBe('M02');
  });
  it('resolves "macchina 3" → M03', () => {
    expect(resolveMachineAlias('macchina 3', PLAN)).toBe('M03');
  });
  it('returns null for off-set "M99"', () => {
    expect(resolveMachineAlias('M99', PLAN)).toBeNull();
  });
  it('returns null for off-set "linea 42"', () => {
    expect(resolveMachineAlias('linea 42', PLAN)).toBeNull();
  });
  it('returns null for empty / whitespace token', () => {
    expect(resolveMachineAlias('', PLAN)).toBeNull();
    expect(resolveMachineAlias('   ', PLAN)).toBeNull();
  });
  it('returns null when the plan has no machines', () => {
    expect(resolveMachineAlias('m2', ctxOf({ machines: [] }))).toBeNull();
  });
  it('refuses an ambiguous alias (collision dropped) → null', () => {
    // Two machines whose compact form both want "m1": "M1" and "M-1" both
    // canonicalise toward each other's variants. buildMachineAliases drops the
    // colliding alias, so "linea 1" must NOT silently pick one.
    const ambiguous = ctxOf({ machines: ['M1', 'M001'] });
    // "linea 1" maps from both M1 and M001 → dropped → null.
    expect(resolveMachineAlias('linea 1', ambiguous)).toBeNull();
  });

  it('M-3: derived-tier ambiguity must NOT silently pick the wrong real id', () => {
    // devil-advocate Wave 16.6: canonicaliseId (step 2 of resolveAgainstSet)
    // pre-empted the collision-safe alias layer and returned the FIRST
    // padding-variant match by push-order. For a plan mixing padded+unpadded
    // ids for the same number (M1 + M-001), token "m1" derives BOTH → it used
    // to silently resolve to whichever pushed first. canonicaliseId now refuses
    // (>1 derived match → null), and the alias layer also dropped the colliding
    // "m1"/"linea 1" keys, so the genuinely-ambiguous token ends as null —
    // the resolver's published ambiguous→null contract, honoured end-to-end.
    const collide = ctxOf({ machines: ['M1', 'M-001', 'M02'] });
    // "linea 1" is the genuinely ambiguous NL token: it carries no literal
    // digits that pin one member, canonicaliseId's derived tier matches both
    // M1 and M-001 (→ null), and buildMachineAliases dropped the colliding
    // "linea 1" key. So it ends as null — ambiguous→null, honoured end-to-end.
    expect(resolveMachineAlias('linea 1', collide)).toBeNull();
    // Tokens whose digits uniquely identify ONE member still resolve correctly:
    // "m001" carries the literal "001" → only M-001 owns that alias.
    expect(resolveMachineAlias('m001', collide)).toBe('M-001');
    expect(resolveMachineAlias('m-001', collide)).toBe('M-001');
    // "m1" strips to the exact member M1 (exact tier wins before any guess).
    expect(resolveMachineAlias('m1', collide)).toBe('M1');
    // And a token only ONE member derives resolves even in a collision-prone
    // set (M02 is the sole padding match for "m2").
    expect(resolveMachineAlias('m2', collide)).toBe('M02');
  });

  it('M-3 (idCanon unit): ambiguous derived match → null at the probe itself', () => {
    // Direct guard on canonicaliseId so a future edit can't reintroduce the
    // first-by-push-order behaviour. Here there is NO alias layer to rescue it —
    // the probe alone must refuse the ambiguous "m001"→{M1,M-001} case.
    const collide = new Set(['M1', 'M-001', 'M02']);
    // "m001" has NO exact-tier member (M001 absent) and derives BOTH M1 and
    // M-001 → ambiguous → null. This is the precise M-3 breach, now fixed.
    expect(canonicaliseId('m001', collide)).toBeNull();
    // exact tier wins first: "m-001"/"m1"/"m-1" each strip to a literal member.
    expect(canonicaliseId('m-001', collide)).toBe('M-001');
    expect(canonicaliseId('m1', collide)).toBe('M1');
    expect(canonicaliseId('m-1', collide)).toBe('M1'); // alnum→"M1", exact member
    expect(canonicaliseId('m2', collide)).toBe('M02'); // sole derived match
  });
});

describe('resolveOrderAlias', () => {
  it('resolves exact "COM-007" → COM-007', () => {
    expect(resolveOrderAlias('COM-007', PLAN)).toBe('COM-007');
  });
  it('resolves "com-007" (case) → COM-007', () => {
    expect(resolveOrderAlias('com-007', PLAN)).toBe('COM-007');
  });
  it('resolves "COM7" (no pad/sep) → COM-007', () => {
    expect(resolveOrderAlias('COM7', PLAN)).toBe('COM-007');
  });
  it('resolves "com007" → COM-007', () => {
    expect(resolveOrderAlias('com007', PLAN)).toBe('COM-007');
  });
  it('returns null for off-set "COM-999"', () => {
    expect(resolveOrderAlias('COM-999', PLAN)).toBeNull();
  });
  it('returns null when the plan has no orders', () => {
    expect(resolveOrderAlias('COM-007', ctxOf({ orders: [] }))).toBeNull();
  });
});

describe('resolveShiftAlias', () => {
  it('resolves exact canonical "turno_mattina"', () => {
    expect(resolveShiftAlias('turno_mattina', PLAN)).toBe('turno_mattina');
  });
  it('resolves bare "mattina" → turno_mattina', () => {
    expect(resolveShiftAlias('mattina', PLAN)).toBe('turno_mattina');
  });
  it('resolves case "Pomeriggio" → turno_pomeriggio', () => {
    expect(resolveShiftAlias('Pomeriggio', PLAN)).toBe('turno_pomeriggio');
  });
  it('returns null for off-set "notte" when not in plan', () => {
    expect(resolveShiftAlias('notte', PLAN)).toBeNull();
  });
  it('returns null when the plan exposes no shifts', () => {
    expect(resolveShiftAlias('mattina', ctxOf({ shifts: [] }))).toBeNull();
  });
});

describe('resolveAgainstSet (generic core)', () => {
  it('resolves exact membership without aliases', () => {
    expect(resolveAgainstSet('M02', ['M01', 'M02'])).toBe('M02');
  });
  it('canonicalises padding against the set', () => {
    expect(resolveAgainstSet('m2', ['M01', 'M02'])).toBe('M02');
  });
  it('returns null on empty set', () => {
    expect(resolveAgainstSet('M02', [])).toBeNull();
  });
  it('uses an explicit alias map when provided', () => {
    expect(resolveAgainstSet('linea 9', ['M09'], { 'linea 9': 'M09' })).toBe('M09');
  });
  it('never returns an id outside the set even via alias', () => {
    // A poisoned alias pointing outside the set must be ignored.
    expect(resolveAgainstSet('x', ['M01'], { x: 'M99' })).toBeNull();
  });
});
