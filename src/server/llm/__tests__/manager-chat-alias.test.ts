import { describe, it, expect } from 'vitest';
import {
  executeManagerTool,
  buildManagerTools,
  MANAGER_TOOLS,
  type ManagerToolContext,
} from '../manager-chat-tools';
import { buildSolutionContext } from '@/lib/solutionContext';
import { extractAiInputs } from '@/lib/aiInputs';

/**
 * Wave 16.6 §B — chat-manager alias resolution.
 *
 * The manager chat used to be "too deterministic": asking about "m2" returned
 * found:false because the tool exact-matched against the canonical "M02".
 * The tools now canonicalize a *sanitized* id via the shared entityResolver
 * (resolveMachineAlias / resolveOrderAlias / resolveAgainstSet) BEFORE the
 * exact-match filter, while keeping sanitizeId as the prompt-injection guard.
 */

// Realistic FJSP backend payload: canonical ids are M01/M02 + OP-01/OP-02,
// orders COM-001 / COM-007 — exactly the shape buildSolutionContext consumes.
const BACKEND_RESPONSE = {
  status: 'FEASIBLE',
  kpis: { makespan: 1814, costo_totale_operatori: 1249.94 },
  solution: {
    'COM-001': {
      ritardo_min: 303,
      scadenza_min: 1,
      fasi: [
        {
          operazione: 'OP-1',
          macchina: 'M02',
          operatore: 'OP-02',
          start_min: 0,
          end_min: 240,
          setup_min: 30,
          processing_min: 210,
        },
      ],
    },
    'COM-007': {
      ritardo_min: 0,
      fasi: [
        {
          operazione: 'OP-1',
          macchina: 'M01',
          operatore: 'OP-01',
          start_min: 0,
          end_min: 120,
          setup_min: 0,
          processing_min: 120,
        },
      ],
    },
  },
};

// Mirror the REAL chat BFF path: extractAiInputs() produces the
// AiSolutionEnvelope (flat fasi[] + commesse map) that runManagerChat hands to
// the tools, and buildSolutionContext() derives the closed set from it. Using
// a hand-rolled envelope here would diverge from production (it did, and hid a
// fixture-shape bug behind the resolver).
function buildCtx(): ManagerToolContext {
  const { solution, kpis } = extractAiInputs(BACKEND_RESPONSE);
  return {
    solution,
    kpis,
    solutionContext: buildSolutionContext(solution, kpis),
  };
}

interface MachineStatusResult {
  machines: Array<{ machine_id: string; util_ratio: number | null; busy_min: number }>;
  total: number;
  found?: boolean;
  machine_id?: string;
  error?: string;
}

describe('get_machine_status — alias resolution', () => {
  it('"m2" resolves to M02 and returns the real machine data', async () => {
    const ctx = buildCtx();
    const res = (await executeManagerTool(
      'get_machine_status',
      { machine_id: 'm2' },
      ctx,
    )) as MachineStatusResult;
    expect(res.total).toBe(1);
    expect(res.machines[0]?.machine_id).toBe('M02');
    expect(res.machines[0]?.busy_min).toBe(240);
    expect(res.found).not.toBe(false);
  });

  it('compact forms ("M-2", "M02", "m02") all resolve to M02', async () => {
    const ctx = buildCtx();
    for (const token of ['M-2', 'M02', 'm02']) {
      const res = (await executeManagerTool(
        'get_machine_status',
        { machine_id: token },
        ctx,
      )) as MachineStatusResult;
      expect(res.machines[0]?.machine_id).toBe('M02');
    }
  });

  it('space-bearing NL aliases ("linea 2") are rejected by sanitizeId, NOT silently resolved', async () => {
    // sanitizeId (the injection guard) forbids spaces, so NL forms never reach
    // the resolver via the chat path. The Haiku model is steered toward a
    // compact id ("M02") by the enum hints + system-prompt examples instead.
    // We assert the boundary explicitly so a future widening of sanitizeId is
    // a conscious decision, not an accidental injection-surface regression.
    const ctx = buildCtx();
    for (const token of ['linea 2', 'macchina 2']) {
      const res = (await executeManagerTool(
        'get_machine_status',
        { machine_id: token },
        ctx,
      )) as MachineStatusResult;
      expect(res.error).toBeDefined();
      expect(res.machines).toBeUndefined();
    }
  });

  it('an off-set machine ("M99") still yields found:false (resolver returns null)', async () => {
    const ctx = buildCtx();
    const res = (await executeManagerTool(
      'get_machine_status',
      { machine_id: 'M99' },
      ctx,
    )) as MachineStatusResult;
    expect(res.found).toBe(false);
    // Falls through to the sanitized token unchanged (no fabrication).
    expect(res.machine_id).toBe('M99');
  });

  it("an injection-y id (\"M' 3\") is rejected by sanitizeId BEFORE the resolver", async () => {
    const ctx = buildCtx();
    const res = (await executeManagerTool(
      'get_machine_status',
      { machine_id: "M' 3" },
      ctx,
    )) as MachineStatusResult;
    // The injection guard fires first: structured error, never a lookup.
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/alfanumerico/);
    expect(res.machines).toBeUndefined();
  });

  it('without a solutionContext, the exact-match behaviour is unchanged ("m2" → found:false)', async () => {
    const ctx = buildCtx();
    delete ctx.solutionContext;
    const res = (await executeManagerTool(
      'get_machine_status',
      { machine_id: 'm2' },
      ctx,
    )) as MachineStatusResult;
    expect(res.found).toBe(false);
    expect(res.machine_id).toBe('m2');
  });
});

interface PhaseResult {
  commessa: string;
  found: boolean;
  n_fasi?: number;
  error?: string;
}

describe('query_phase — order alias resolution', () => {
  it('"com7" resolves to COM-007 and returns its phases', async () => {
    const ctx = buildCtx();
    const res = (await executeManagerTool(
      'query_phase',
      { commessa: 'com7' },
      ctx,
    )) as PhaseResult;
    expect(res.found).toBe(true);
    expect(res.commessa).toBe('COM-007');
    expect(res.n_fasi).toBe(1);
  });

  it('an off-set order ("COM-999") yields found:false with the canonical-or-sanitized id', async () => {
    const ctx = buildCtx();
    const res = (await executeManagerTool(
      'query_phase',
      { commessa: 'COM-999' },
      ctx,
    )) as PhaseResult;
    expect(res.found).toBe(false);
    expect(res.commessa).toBe('COM-999');
  });

  it("an injection-y commessa is rejected by sanitizeId", async () => {
    const ctx = buildCtx();
    const res = (await executeManagerTool(
      'query_phase',
      { commessa: 'COM; DROP' },
      ctx,
    )) as PhaseResult;
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/alfanumerica/);
  });
});

interface OperatorResult {
  operators: Array<{ operator_id: string; busy_min: number }>;
  total: number;
  found?: boolean;
  operator_id?: string;
  error?: string;
}

describe('get_operator_assignments — operator alias resolution', () => {
  it('"op2" resolves to OP-02 and returns the real workload', async () => {
    const ctx = buildCtx();
    const res = (await executeManagerTool(
      'get_operator_assignments',
      { operator_id: 'op2' },
      ctx,
    )) as OperatorResult;
    expect(res.total).toBe(1);
    expect(res.operators[0]?.operator_id).toBe('OP-02');
    expect(res.operators[0]?.busy_min).toBe(240);
  });

  it("an injection-y operator id is rejected by sanitizeId", async () => {
    const ctx = buildCtx();
    const res = (await executeManagerTool(
      'get_operator_assignments',
      { operator_id: "OP' 2" },
      ctx,
    )) as OperatorResult;
    expect(res.error).toBeDefined();
    expect(res.operators).toBeUndefined();
  });
});

describe('buildManagerTools — enum hints', () => {
  it('inlines the real machine/order/operator ids into the relevant tool descriptions', () => {
    const tools = buildManagerTools({
      machines: ['M01', 'M02'],
      orders: ['COM-001', 'COM-007'],
      operators: ['OP-01', 'OP-02'],
    });
    const byName = (n: string) => tools.find((t) => t.name === n)!;
    expect(byName('get_machine_status').description).toContain('M02');
    expect(byName('query_phase').description).toContain('COM-007');
    expect(byName('get_operator_assignments').description).toContain('OP-02');
  });

  it('returns the static tool list unchanged when no ids are known', () => {
    expect(buildManagerTools()).toBe(MANAGER_TOOLS);
    expect(buildManagerTools({ machines: [], orders: [], operators: [] })).toBe(
      MANAGER_TOOLS,
    );
  });
});
