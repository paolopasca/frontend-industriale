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
