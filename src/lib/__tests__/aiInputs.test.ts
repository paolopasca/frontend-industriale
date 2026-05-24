import { describe, it, expect } from 'vitest';
import {
  extractAiInputs,
  buildAiSolutionEnvelope,
  buildAiKpis,
  extractSolverStatus,
} from '../aiInputs';

const FJSP_BACKEND_RESPONSE = {
  status: 'FEASIBLE',
  method: 'template_solve',
  objective_value: 8131186,
  warnings: ['vincolo_X soft non rispettato'],
  kpis: {
    makespan: 1814,
    costo_totale_operatori: 1249.94,
    costo_totale_setup: 42,
    ritardo_pesato_totale: 303,
  },
  solution: {
    'COM-001': {
      ritardo_min: 303,
      scadenza_min: 1,
      fasi: [
        {
          operazione: 'OP-1',
          macchina: 'M05',
          operatore: 'OP-04',
          start_min: 120,
          end_min: 194,
          setup_min: 7,
          processing_min: 74,
        },
        {
          operazione: 'OP-2',
          macchina: 'M01',
          operatore: 'OP-01',
          start_min: 194,
          end_min: 304,
          setup_min: 10,
          processing_min: 100,
        },
      ],
    },
    'COM-002': {
      ritardo_min: 0,
      scadenza_min: 1000,
      fasi: [
        {
          operazione: 'OP-1',
          macchina: 'M02',
          operatore: 'OP-02',
          start_min: 0,
          end_min: 60,
          setup_min: 0,
          processing_min: 60,
        },
      ],
    },
  },
};

describe('buildAiSolutionEnvelope', () => {
  it('lifts status from the response top level', () => {
    const env = buildAiSolutionEnvelope(FJSP_BACKEND_RESPONSE);
    expect(env.status).toBe('FEASIBLE');
  });

  it('flattens commessa-keyed fasi into a single array with commessa injected', () => {
    const env = buildAiSolutionEnvelope(FJSP_BACKEND_RESPONSE);
    expect(env.fasi).toHaveLength(3);
    expect(env.fasi[0]).toMatchObject({
      commessa: 'COM-001',
      operazione: 'OP-1',
      macchina: 'M05',
      ritardo_min: 303,
      deadline_min: 1,
    });
    expect(env.fasi[2]).toMatchObject({
      commessa: 'COM-002',
      ritardo_min: 0,
      deadline_min: 1000,
    });
  });

  it('preserves warnings array', () => {
    const env = buildAiSolutionEnvelope(FJSP_BACKEND_RESPONSE);
    expect(env.warnings).toEqual(['vincolo_X soft non rispettato']);
  });

  it('keeps the original commesse map', () => {
    const env = buildAiSolutionEnvelope(FJSP_BACKEND_RESPONSE);
    expect(Object.keys(env.commesse)).toEqual(['COM-001', 'COM-002']);
  });

  it('defaults status to UNKNOWN when missing', () => {
    const env = buildAiSolutionEnvelope({ solution: {} });
    expect(env.status).toBe('UNKNOWN');
    expect(env.fasi).toEqual([]);
  });

  it('drops malformed fasi entries silently', () => {
    const env = buildAiSolutionEnvelope({
      status: 'FEASIBLE',
      solution: {
        'COM-X': { fasi: [null, 'garbage', { operazione: 'OP-1', macchina: 'M01' }] },
      },
    });
    expect(env.fasi).toHaveLength(1);
    expect(env.fasi[0]?.commessa).toBe('COM-X');
  });
});

describe('buildAiKpis', () => {
  it('adds alias keys for makespan and cost without dropping originals', () => {
    const env = buildAiSolutionEnvelope(FJSP_BACKEND_RESPONSE);
    const kpis = buildAiKpis(
      {
        makespan: 1814,
        costo_totale_operatori: 1249.94,
        costo_totale_setup: 42,
      },
      env,
    );
    expect(kpis.makespan).toBe(1814);
    expect(kpis.makespan_min).toBe(1814);
    expect(kpis.setup_cost_usd).toBe(42);
    expect(kpis.operator_cost_usd).toBe(1249.94);
    expect(kpis.cost_usd).toBeCloseTo(1291.94);
  });

  it('derives n_commesse and n_in_ritardo from the envelope', () => {
    const env = buildAiSolutionEnvelope(FJSP_BACKEND_RESPONSE);
    const kpis = buildAiKpis({}, env);
    expect(kpis.n_commesse).toBe(2);
    expect(kpis.n_in_ritardo).toBe(1);
    expect(kpis.on_time_rate).toBeCloseTo(0.5);
  });

  it('does not overwrite KPIs already provided by the backend', () => {
    const env = buildAiSolutionEnvelope(FJSP_BACKEND_RESPONSE);
    const kpis = buildAiKpis({ cost_usd: 999, n_in_ritardo: 7 }, env);
    expect(kpis.cost_usd).toBe(999);
    expect(kpis.n_in_ritardo).toBe(7);
  });
});

describe('extractAiInputs', () => {
  it('produces an envelope with FEASIBLE status and flat fasi for the FJSP template shape', () => {
    const { solution, kpis } = extractAiInputs(FJSP_BACKEND_RESPONSE);
    const env = solution as { status: string; fasi: unknown[] };
    expect(env.status).toBe('FEASIBLE');
    expect(env.fasi).toHaveLength(3);
    expect(kpis.makespan_min).toBe(1814);
    expect(kpis.n_commesse).toBe(2);
  });

  it('keeps the LLM-only legacy shape untouched', () => {
    const raw = {
      result: { piano: [{ commessa: 'C', macchina: 'M' }], kpi: { foo: 1 } },
    };
    const { solution, kpis } = extractAiInputs(raw);
    expect(solution).toEqual([{ commessa: 'C', macchina: 'M' }]);
    expect(kpis).toEqual({ foo: 1 });
  });

  it('returns empty inputs for non-object input', () => {
    expect(extractAiInputs(null)).toEqual({ solution: null, kpis: {} });
    expect(extractAiInputs('not an object')).toEqual({ solution: null, kpis: {} });
  });
});

describe('extractSolverStatus', () => {
  it('reads top-level status from the FJSP shape', () => {
    expect(extractSolverStatus(FJSP_BACKEND_RESPONSE)).toBe('FEASIBLE');
  });

  it('falls back through result.status', () => {
    expect(extractSolverStatus({ result: { status: 'optimal' } })).toBe('OPTIMAL');
  });

  it('falls back through solution.status as a last resort', () => {
    expect(extractSolverStatus({ solution: { status: 'infeasible' } })).toBe('INFEASIBLE');
  });

  it('returns null when no status is found', () => {
    expect(extractSolverStatus({})).toBeNull();
    expect(extractSolverStatus(null)).toBeNull();
  });
});
