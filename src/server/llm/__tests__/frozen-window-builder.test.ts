import { describe, expect, it } from 'vitest';

import {
  buildFrozenPhases,
  detectScenarioStartMin,
  detectScenarioPhraseMatches,
} from '../frozen-window-builder';

describe('buildFrozenPhases', () => {
  it('returns empty list when baseline is empty', () => {
    expect(buildFrozenPhases({}, 1000)).toEqual([]);
  });

  it('returns empty list when cutoffMin is zero (no past to freeze)', () => {
    const baseline = {
      'COM-001': { fasi: [{ operazione: 'op1', macchina: 'M-1', start_min: 0, end_min: 60 }] },
    };
    expect(buildFrozenPhases(baseline, 0)).toEqual([]);
  });

  it('freezes only phases entirely before the cutoff', () => {
    const baseline = {
      'COM-001': {
        fasi: [
          { operazione: 'op1', macchina: 'M-1', operatore: 'OP-A', start_min: 0, end_min: 60 },
          { operazione: 'op2', macchina: 'M-1', operatore: 'OP-A', start_min: 60, end_min: 120 },
          { operazione: 'op3', macchina: 'M-2', operatore: 'OP-B', start_min: 120, end_min: 240 },
        ],
      },
    };
    const result = buildFrozenPhases(baseline, 120);
    expect(result).toHaveLength(2);
    // F-W8-09: seq is 1-based (matches backend op["sequenza"] convention).
    expect(result[0]).toEqual({
      job_id: 'COM-001',
      seq: 1,
      start_min: 0,
      end_min: 60,
      machine_id: 'M-1',
      worker_id: 'OP-A',
      commessa: 'COM-001',
      operazione: 'op1',
      operatore: 'OP-A',
    });
    expect(result[1]).toEqual({
      job_id: 'COM-001',
      seq: 2,
      start_min: 60,
      end_min: 120,
      machine_id: 'M-1',
      worker_id: 'OP-A',
      commessa: 'COM-001',
      operazione: 'op2',
      operatore: 'OP-A',
    });
  });

  it('does NOT freeze a phase that straddles the cutoff (edge case)', () => {
    const baseline = {
      'COM-001': {
        fasi: [
          { operazione: 'op1', macchina: 'M-1', operatore: 'OP-A', start_min: 0, end_min: 60 },
          // straddles cutoff=100: start=60 < 100, end=180 > 100 → must be left to solver
          { operazione: 'op2', macchina: 'M-1', operatore: 'OP-A', start_min: 60, end_min: 180 },
        ],
      },
    };
    const result = buildFrozenPhases(baseline, 100);
    expect(result).toHaveLength(1);
    // F-W8-09: positional fallback is 1-based to match backend convention.
    expect(result[0].seq).toBe(1);
    expect(result[0].job_id).toBe('COM-001');
  });

  it('handles multi-commessa baselines', () => {
    const baseline = {
      'COM-001': {
        fasi: [{ operazione: 'op1', macchina: 'M-1', operatore: 'OP-A', start_min: 0, end_min: 60 }],
      },
      'COM-002': {
        fasi: [{ operazione: 'op1', macchina: 'M-2', operatore: 'OP-B', start_min: 0, end_min: 90 }],
      },
    };
    const result = buildFrozenPhases(baseline, 100);
    expect(result).toHaveLength(2);
    expect(result.map((p) => p.job_id).sort()).toEqual(['COM-001', 'COM-002']);
  });

  it('accepts machine_id field as alternative to macchina', () => {
    const baseline = {
      'COM-001': {
        fasi: [
          { operazione: 'op1', machine_id: 'M-7', operatore: 'OP-A', start_min: 0, end_min: 50 },
        ],
      },
    };
    const result = buildFrozenPhases(baseline, 100);
    expect(result).toHaveLength(1);
    expect(result[0].machine_id).toBe('M-7');
  });

  it('skips phases with missing or malformed fields without crashing', () => {
    const baseline = {
      'COM-001': {
        fasi: [
          { operazione: 'op1', macchina: 'M-1', start_min: 0, end_min: 60 },
          // missing macchina/machine_id → skip
          { operazione: 'op2', start_min: 60, end_min: 120 },
          // missing start_min → skip
          { operazione: 'op3', macchina: 'M-1', end_min: 60 },
          // end <= start → skip
          { operazione: 'op4', macchina: 'M-1', start_min: 100, end_min: 100 },
          // non-object → skip
          'garbage',
          null,
        ],
      },
    };
    const result = buildFrozenPhases(baseline, 1000);
    expect(result).toHaveLength(1);
    // F-W8-09: 1-based positional fallback.
    expect(result[0].seq).toBe(1);
    expect(result[0].operazione).toBe('op1');
  });

  it('returns empty list for non-object baseline', () => {
    expect(buildFrozenPhases(null, 1000)).toEqual([]);
    expect(buildFrozenPhases(undefined, 1000)).toEqual([]);
    expect(buildFrozenPhases([1, 2, 3], 1000)).toEqual([]);
    expect(buildFrozenPhases('not an object', 1000)).toEqual([]);
  });

  it('freezes phase that ends exactly at the cutoff (inclusive boundary)', () => {
    const baseline = {
      'COM-001': {
        fasi: [
          { operazione: 'op1', macchina: 'M-1', operatore: 'OP-A', start_min: 0, end_min: 100 },
        ],
      },
    };
    const result = buildFrozenPhases(baseline, 100);
    expect(result).toHaveLength(1);
    expect(result[0].operazione).toBe('op1');
    // F-W8-09: 1-based.
    expect(result[0].seq).toBe(1);
  });

  it('emits the backend-required job_id + seq fields', () => {
    const baseline = {
      'COM-001': {
        fasi: [
          { operazione: 'OP-1', macchina: 'M01', operatore: 'OP-A', start_min: 0, end_min: 50 },
          { operazione: 'OP-2', macchina: 'M02', operatore: 'OP-A', start_min: 50, end_min: 90 },
        ],
      },
    };
    const result = buildFrozenPhases(baseline, 200);
    expect(result).toHaveLength(2);
    expect(result[0].job_id).toBe('COM-001');
    // F-W8-09: 1-based — was 0/1 (bug), is now 1/2.
    expect(result[0].seq).toBe(1);
    expect(result[0].machine_id).toBe('M01');
    expect(result[1].seq).toBe(2);
  });

  // === F-W8-09 regression cases (devils 2026-05-22) ===
  // Pre-fix the builder emitted 0-based seq, but the backend keys its
  // alternatives dict on op["sequenza"] which is 1-based positional in
  // every shipped fixture (the warm-start parser at fjsp.py:1978 uses
  // enumerate(fasi, start=1) as the same fallback). The off-by-one made
  // every (jid, 0) lookup miss → 100% of frozen phases skipped silently
  // → "production-invariant" guarantee of Wave 7 was a no-op.

  it('F-W8-09: positional fallback emits 1-based seq matching backend convention', () => {
    // The live `solve-template` solution does not carry `sequenza` on
    // each fase (verified empirically on demo-commesse 2026-05-22), so
    // the positional fallback is the hot path in production. Keep it
    // 1-based.
    const baseline = {
      'COM-001': {
        fasi: [
          { operazione: 'OP-1', macchina: 'M01', start_min: 0, end_min: 60 },
          { operazione: 'OP-2', macchina: 'M02', start_min: 60, end_min: 120 },
          { operazione: 'OP-3', macchina: 'M03', start_min: 120, end_min: 180 },
        ],
      },
    };
    const result = buildFrozenPhases(baseline, 200);
    expect(result.map((p) => p.seq)).toEqual([1, 2, 3]);
  });

  it('F-W8-09: explicit fase.sequenza is preferred over positional fallback', () => {
    // If a future caller supplies `sequenza` directly (e.g. a persisted
    // plan with explicit ids that don't match list order — gap-tolerant
    // backend), pass it through verbatim.
    const baseline = {
      'COM-001': {
        fasi: [
          { operazione: 'OP-1', macchina: 'M01', sequenza: 3, start_min: 0, end_min: 60 },
          { operazione: 'OP-2', macchina: 'M02', sequenza: 7, start_min: 60, end_min: 120 },
        ],
      },
    };
    const result = buildFrozenPhases(baseline, 200);
    expect(result.map((p) => p.seq)).toEqual([3, 7]);
  });

  it('F-W8-09: explicit fase.seq is accepted as alias for sequenza', () => {
    const baseline = {
      'COM-001': {
        fasi: [
          { operazione: 'OP-1', macchina: 'M01', seq: 5, start_min: 0, end_min: 60 },
        ],
      },
    };
    const result = buildFrozenPhases(baseline, 200);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(5);
  });

  it('F-W8-09: sequenza=0 is treated as missing (zero is not a valid backend key)', () => {
    // Defensive: a caller serialising 0-based ids would hit the same bug
    // we're fixing. Treat sequenza <= 0 as missing and fall back to the
    // 1-based positional index instead of accepting a guaranteed-miss key.
    const baseline = {
      'COM-001': {
        fasi: [
          { operazione: 'OP-1', macchina: 'M01', sequenza: 0, start_min: 0, end_min: 60 },
        ],
      },
    };
    const result = buildFrozenPhases(baseline, 200);
    expect(result).toHaveLength(1);
    expect(result[0].seq).toBe(1);
  });
});

describe('Wave 16.4 A4 — detectScenarioStartMin', () => {
  it('returns null when no temporal phrase is present', () => {
    expect(detectScenarioStartMin('ferma M-1 dalle 14 alle 18')).toBeNull();
    expect(detectScenarioStartMin('anticipa COM-001')).toBeNull();
    expect(detectScenarioStartMin('')).toBeNull();
  });

  it('detects "domani" → 1440', () => {
    expect(detectScenarioStartMin('ferma M-1 domani dalle 14')).toBe(1440);
    expect(detectScenarioStartMin('Domani la linea M-2 non lavora')).toBe(1440);
  });

  it('detects "dopodomani" → 2880 (and does not match plain "domani")', () => {
    expect(detectScenarioStartMin('ferma M-1 dopodomani dalle 14')).toBe(2880);
  });

  it('detects "giorno N" for N>=2 → (N-1) * 1440', () => {
    expect(detectScenarioStartMin('sposta COM-001 al giorno 2')).toBe(1440);
    expect(detectScenarioStartMin('GIORNO 3 ferma M-2')).toBe(2880);
  });

  it('returns null for "giorno 1" (devil-advocate LOW-3 2026-05-27)', () => {
    // "giorno 1" == horizon start == minute 0. The legacy cushion path
    // is correct here (manager is already past the boundary), so the
    // helper returns null and lets the caller fall back.
    expect(detectScenarioStartMin('giorno 1 inizio orizzonte')).toBeNull();
  });

  it('detects "fra/tra/in N giorni" for N>=1 → N * 1440', () => {
    expect(detectScenarioStartMin('fra 3 giorni anticipa COM-001')).toBe(3 * 1440);
    expect(detectScenarioStartMin('tra 2 giorni ferma M-1')).toBe(2 * 1440);
    expect(detectScenarioStartMin('in 5 giorni nuova capacita')).toBe(5 * 1440);
  });

  it('returns null for "fra 0 giorni" (LOW-4 standardize N range)', () => {
    // "fra 0 giorni" == now == legacy cushion path.
    expect(detectScenarioStartMin('fra 0 giorni qualcosa')).toBeNull();
  });

  it('does not match nonsense like "domanichi" or "giorno cento"', () => {
    expect(detectScenarioStartMin('domanichi non esiste')).toBeNull();
    expect(detectScenarioStartMin('giorno cento di pioggia')).toBeNull();
  });

  it('clamps to safety: rejects ranges > 365 days (LOW-4 standardized cap)', () => {
    expect(detectScenarioStartMin('giorno 999 lontano nel tempo')).toBeNull();
    expect(detectScenarioStartMin('fra 999 giorni qualcosa')).toBeNull();
  });

  it('LOW-4: 3-digit N consistent across patterns', () => {
    // "fra 100 giorni" used to be rejected by \d{1,2}; now accepted up to 365.
    expect(detectScenarioStartMin('fra 100 giorni anticipa COM-001')).toBe(100 * 1440);
    expect(detectScenarioStartMin('giorno 200 ferma M-2')).toBe(199 * 1440);
  });
});

describe('Wave 16.4 A4 — detectScenarioPhraseMatches (devil-advocate MEDIUM-2)', () => {
  it('returns empty array when no temporal phrase present', () => {
    expect(detectScenarioPhraseMatches('ferma M-1 dalle 14 alle 18')).toEqual([]);
    expect(detectScenarioPhraseMatches('')).toEqual([]);
  });

  it('returns single match for single phrase', () => {
    expect(detectScenarioPhraseMatches('domani ferma M-1')).toEqual(['domani']);
    expect(detectScenarioPhraseMatches('dopodomani ferma M-2')).toEqual(['dopodomani']);
    expect(detectScenarioPhraseMatches('giorno 3 manutenzione')).toEqual(['giorno_n']);
    expect(detectScenarioPhraseMatches('fra 5 giorni nuovo turno')).toEqual(['fra_n_giorni']);
  });

  it('returns multiple matches when manager combines phrases', () => {
    // Devil-advocate MEDIUM-2: ambiguity must be detectable.
    const matches = detectScenarioPhraseMatches(
      'attenzione: dopodomani arriva il giorno 5',
    );
    expect(matches.length).toBeGreaterThan(1);
    expect(matches[0]).toBe('dopodomani'); // priority winner
    expect(matches).toContain('giorno_n');
  });

  it('does NOT double-count "domani" inside "dopodomani"', () => {
    // Regression: pre-fix, "dopodomani" would trigger both 'dopodomani'
    // and 'domani' (substring match), inflating ambiguity warnings.
    expect(detectScenarioPhraseMatches('dopodomani ferma M-1')).toEqual(['dopodomani']);
  });

  it('detects both "domani" and "giorno N" when manager says both', () => {
    const matches = detectScenarioPhraseMatches('domani ferma M-1, oppure giorno 3');
    expect(matches).toContain('domani');
    expect(matches).toContain('giorno_n');
  });
});
