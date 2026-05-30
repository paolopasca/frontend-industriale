import { describe, it, expect } from 'vitest';
import { buildMachineAliases, buildSolutionContext } from '../solutionContext';

/**
 * Wave 16.5 (devil / be-temporal-extractor) — machine alias resolution.
 *
 * The backend extractor resolves an entity ("m1") only via an exact
 * case-insensitive match in `machines` OR a key in `machine_aliases`. Real
 * demo machine ids are zero-padded with a separator ("M-001"), so the manager
 * typing "m1" / "m01" / "macchina 1" must map back to the canonical string —
 * otherwise the utterance falls to a GRAY "?" sentinel and the HIT path dies.
 */

describe('buildMachineAliases', () => {
  it('maps compact/padded/separator forms of "M-001" to the canonical id', () => {
    const a = buildMachineAliases(['M-001']);
    for (const key of ['m-001', 'm1', 'm001', 'm-1', 'm 1', 'linea 1', 'macchina 1', 'machine 1']) {
      expect(a[key]).toBe('M-001');
    }
  });

  it('maps single-digit "M-1" forms', () => {
    const a = buildMachineAliases(['M-1']);
    expect(a['m-1']).toBe('M-1');
    expect(a['m1']).toBe('M-1');
    expect(a['macchina 1']).toBe('M-1');
  });

  it('keeps distinct machines separate (no cross-talk)', () => {
    const a = buildMachineAliases(['M-001', 'M-002']);
    expect(a['m1']).toBe('M-001');
    expect(a['m2']).toBe('M-002');
    expect(a['macchina 1']).toBe('M-001');
    expect(a['macchina 2']).toBe('M-002');
  });

  it('DROPS an ambiguous alias rather than fabricating a wrong resolution', () => {
    // "M-001" and "M1" both want the compact "m1" → must be dropped, not
    // last-write-wins. An ambiguous alias is worse than a GRAY "?".
    const a = buildMachineAliases(['M-001', 'M1']);
    expect('m1' in a).toBe(false);
    // The unambiguous case-folded forms still resolve.
    expect(a['m-001']).toBe('M-001');
    // "M1".toLowerCase() === "m1" is the collision source; its lowercase is
    // the same ambiguous key, so it too is absent.
  });

  it('handles non-numeric machine ids gracefully', () => {
    const a = buildMachineAliases(['Tornio', 'CNC']);
    expect(a['tornio']).toBe('Tornio');
    expect(a['cnc']).toBe('CNC');
  });

  it('does not emit a self-alias when the id is already lowercase', () => {
    const a = buildMachineAliases(['saldatrice']);
    // lower === original → no case-fold alias; NL forms only if numbered.
    expect(a['saldatrice']).toBeUndefined();
  });
});

describe('buildSolutionContext — alias integration', () => {
  it('exposes compact aliases for padded ids recovered from the baseline', () => {
    const baseline = {
      fasi: [
        { macchina: 'M-001', start_min: 0, end_min: 120 },
        { macchina: 'M-002', start_min: 120, end_min: 300 },
      ],
    };
    const ctx = buildSolutionContext(baseline, {});
    expect(ctx.machines).toEqual(expect.arrayContaining(['M-001', 'M-002']));
    expect(ctx.machine_aliases['m1']).toBe('M-001');
    expect(ctx.machine_aliases['m2']).toBe('M-002');
  });
});

describe('buildSolutionContext — closed-set populates for EVERY originalSolution shape', () => {
  // Wave 16.6: the what-if route hands buildSolutionContext one of three shapes.
  // The interpreter's machine/order ENUMS come from ctx.machines / ctx.orders,
  // so the closed set MUST populate regardless of shape — otherwise the enum is
  // omitted and every machine/order instruction silently fails the gate. These
  // pin all three so a future refactor can't quietly starve the interpreter.
  it('FLAT envelope {fasi:[...]} → machines from the flat fasi[]', () => {
    const flat = {
      fasi: [
        { commessa: 'COM-001', macchina: 'M01', start_min: 0, end_min: 100 },
        { commessa: 'COM-002', macchina: 'M02', start_min: 0, end_min: 200 },
      ],
    };
    const ctx = buildSolutionContext(flat, {});
    expect([...ctx.machines].sort()).toEqual(['M01', 'M02']);
  });

  it('BARE-NESTED map {COM-001:{fasi:[...]}} → BOTH machines and orders', () => {
    const nested = {
      'COM-001': { fasi: [{ macchina: 'M01' }], scadenza_min: 2880 },
      'COM-002': { fasi: [{ macchina: 'M02' }], scadenza_min: 4320 },
    };
    const ctx = buildSolutionContext(nested, {});
    expect([...ctx.machines].sort()).toEqual(['M01', 'M02']);
    expect([...ctx.orders].sort()).toEqual(['COM-001', 'COM-002']);
    expect(ctx.order_deadlines).toEqual({ 'COM-001': 2880, 'COM-002': 4320 });
  });

  it('RAW backend {status, solution:{COM-001:{fasi}}} → machines and orders', () => {
    const raw = {
      status: 'OPTIMAL',
      solution: { 'COM-001': { fasi: [{ macchina: 'M01' }], scadenza_min: 2880 } },
    };
    const ctx = buildSolutionContext(raw, {});
    expect(ctx.machines).toEqual(['M01']);
    expect(ctx.orders).toEqual(['COM-001']);
  });

  it('GUARD: a flat envelope with time_config does NOT treat time_config as a commessa', () => {
    const flatWithCfg = {
      fasi: [{ commessa: 'COM-001', macchina: 'M01', start_min: 0, end_min: 100 }],
      time_config: { day_length_min: 1440, start_date: '2026-01-01' },
    };
    const ctx = buildSolutionContext(flatWithCfg, {});
    expect(ctx.machines).toEqual(['M01']);
    // time_config has no `fasi`, so the bare-nested fallback must skip it.
    expect(ctx.orders).toEqual([]);
  });
});
