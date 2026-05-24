import { describe, it, expect } from 'vitest';
import { extractAiInputs } from '../aiInputs';
import {
  normalizeForTools,
  executeManagerTool,
} from '@/server/llm/manager-chat-tools';

const FJSP_BACKEND_RESPONSE = {
  status: 'FEASIBLE',
  warnings: ['vincolo soft non rispettato'],
  kpis: {
    makespan: 1814,
    costo_totale_operatori: 1249.94,
    costo_totale_setup: 0,
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
      ],
    },
    'COM-002': {
      ritardo_min: 0,
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

describe('F-W11-LIVE-03 — backend status reaches AI surfaces', () => {
  it('manager-chat normalizer sees FEASIBLE (not UNKNOWN) for a real backend payload', () => {
    const { solution, kpis } = extractAiInputs(FJSP_BACKEND_RESPONSE);
    const norm = normalizeForTools(solution, kpis);
    expect(norm.status).toBe('FEASIBLE');
    expect(norm.fasi.length).toBeGreaterThan(0);
    expect(norm.warnings).toEqual(['vincolo soft non rispettato']);
  });

  it('get_status_diagnosis surfaces FEASIBLE + has_plan=true', async () => {
    const { solution, kpis } = extractAiInputs(FJSP_BACKEND_RESPONSE);
    const diag = (await executeManagerTool('get_status_diagnosis', {}, { solution, kpis })) as {
      status: string;
      has_plan: boolean;
      n_fasi: number;
    };
    expect(diag.status).toBe('FEASIBLE');
    expect(diag.has_plan).toBe(true);
    expect(diag.n_fasi).toBe(2);
  });

  it('get_kpi_summary surfaces concrete numbers (no longer empty)', async () => {
    const { solution, kpis } = extractAiInputs(FJSP_BACKEND_RESPONSE);
    const summary = (await executeManagerTool('get_kpi_summary', {}, { solution, kpis })) as {
      status: string;
      kpis: Record<string, number>;
      n_fasi: number;
      n_commesse: number;
    };
    expect(summary.status).toBe('FEASIBLE');
    expect(summary.n_fasi).toBe(2);
    expect(summary.n_commesse).toBe(2);
    expect(summary.kpis.makespan_min).toBe(1814);
    expect(summary.kpis.cost_usd).toBe(1249.94);
    expect(summary.kpis.n_in_ritardo).toBe(1);
  });

  it('get_late_orders pinpoints the delayed commessa with the right ritardo', async () => {
    const { solution, kpis } = extractAiInputs(FJSP_BACKEND_RESPONSE);
    const late = (await executeManagerTool('get_late_orders', {}, { solution, kpis })) as {
      total: number;
      totale_ritardo_min: number;
      orders: Array<{ commessa: string; ritardo_min: number }>;
    };
    expect(late.total).toBe(1);
    expect(late.totale_ritardo_min).toBe(303);
    expect(late.orders[0]?.commessa).toBe('COM-001');
    expect(late.orders[0]?.ritardo_min).toBe(303);
  });

  it('query_phase returns timing details for an existing commessa', async () => {
    const { solution, kpis } = extractAiInputs(FJSP_BACKEND_RESPONSE);
    const q = (await executeManagerTool(
      'query_phase',
      { commessa: 'COM-001' },
      { solution, kpis },
    )) as { commessa: string; found: boolean; n_fasi: number; ritardo_min: number };
    expect(q.found).toBe(true);
    expect(q.n_fasi).toBe(1);
    expect(q.ritardo_min).toBe(303);
  });
});
