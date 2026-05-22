import { describe, expect, it } from 'vitest';

import { buildFrozenPhases } from '../frozen-window-builder';

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
    expect(result[0]).toEqual({
      job_id: 'COM-001',
      seq: 0,
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
      seq: 1,
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
    expect(result[0].seq).toBe(0);
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
    expect(result[0].seq).toBe(0);
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
    expect(result[0].seq).toBe(0);
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
    expect(result[0].seq).toBe(0);
    expect(result[0].machine_id).toBe('M01');
    expect(result[1].seq).toBe(1);
  });
});
