import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SolutionContext } from '@/lib/solutionContext';
import { buildMachineAliases } from '@/lib/solutionContext';

/**
 * Wave 16.6 — instruction-interpreter unit tests.
 *
 * The Anthropic SDK is mocked (no network). Each test feeds a deterministic
 * Haiku tool_use block and asserts:
 *   - enum pick → hit with canonical rules payload,
 *   - off-set "M99" → reject + unresolved_target (anti-hallucination gate),
 *   - verbose phrasing → resolves to the right intent,
 *   - the deterministic gate rejects/grays correctly.
 *
 * Real Haiku behaviour is covered by the integration tests owned by the tester.
 */

const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = { create: createMock };
    constructor(_: unknown) {
      void _;
    }
  }
  return { default: FakeAnthropic };
});

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  vi.resetModules();
  createMock.mockReset();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

function ctxOf(partial: Partial<SolutionContext>): SolutionContext {
  const machines = partial.machines ?? ['M01', 'M02', 'M03', 'M04', 'M05'];
  return {
    machines,
    machine_aliases: partial.machine_aliases ?? buildMachineAliases(machines),
    orders: partial.orders ?? ['COM-001', 'COM-007'],
    shifts: partial.shifts ?? ['turno_mattina', 'turno_pomeriggio', 'turno_serale'],
    time_config: null,
    shift_types: partial.shift_types ?? {
      turno_mattina: { start: 480, end: 840 },
      turno_pomeriggio: { start: 840, end: 1080 },
      turno_serale: { start: 1080, end: 1320 },
    },
    order_deadlines: partial.order_deadlines ?? { 'COM-001': 2880, 'COM-007': 4320 },
  };
}

interface FakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function fakeToolReply(input: Record<string, unknown>, usage?: FakeUsage) {
  return {
    content: [{ type: 'tool_use', name: 'emit_constraint', id: 'tool_1', input }],
    usage: {
      input_tokens: usage?.input_tokens ?? 1200,
      output_tokens: usage?.output_tokens ?? 40,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

async function runInterpret(
  toolInput: Record<string, unknown>,
  message: string,
  ctx: SolutionContext,
  dayAnchor?: number,
) {
  createMock.mockResolvedValueOnce(fakeToolReply(toolInput));
  const mod = await import('../instruction-interpreter');
  return mod.interpretInstruction(message, ctx, dayAnchor);
}

describe('interpretInstruction — enum pick → hit', () => {
  it('"blocca la linea 2 da domani pomeriggio fino a fine giornata" → hit, unavailable_machines[M02]', async () => {
    const ctx = ctxOf({});
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M02',
        start_min: 2280,
        end_min: 2520,
        confidence: 'high',
      },
      'blocca la linea 2 da domani pomeriggio fino a fine giornata',
      ctx,
    );
    expect(r.interpretation.result).toBe('hit');
    expect(r.interpretation.payload).toEqual({
      unavailable_machines: { M02: [{ start_min: 2280, end_min: 2520 }] },
    });
    expect(r.interpretation.intent_id).toBe('machine_unavailability');
    expect(r.interpretation.unresolved_target).toBeUndefined();
    expect(r.cost_usd).toBeGreaterThan(0);
  });

  it('"anticipa la commessa 7" → hit, priority_orders[COM-007] (verbose alias resolves)', async () => {
    const ctx = ctxOf({});
    const r = await runInterpret(
      { intent_id: 'order_priority', order_ids: ['COM-007'], confidence: 'high' },
      'anticipa la commessa 7',
      ctx,
    );
    expect(r.interpretation.result).toBe('hit');
    expect(r.interpretation.payload).toEqual({ priority_orders: ['COM-007'] });
  });

  it('canonicalises a non-padded enum echo "COM7" → COM-007 in the gate', async () => {
    const ctx = ctxOf({});
    const r = await runInterpret(
      { intent_id: 'order_priority', order_ids: ['COM7'], confidence: 'high' },
      'priorità a COM7',
      ctx,
    );
    expect(r.interpretation.result).toBe('hit');
    expect(r.interpretation.payload).toEqual({ priority_orders: ['COM-007'] });
  });
});

describe('interpretInstruction — anti-hallucination gate', () => {
  it('off-set "M99" via unresolved_target → reject, no payload', async () => {
    const ctx = ctxOf({});
    const r = await runInterpret(
      { intent_id: 'machine_unavailability', unresolved_target: 'M99', confidence: 'high' },
      'blocca M99 alle 14',
      ctx,
    );
    expect(r.interpretation.result).toBe('reject');
    expect(r.interpretation.unresolved_target).toBe('M99');
    expect(r.interpretation.payload).toEqual({});
    expect(r.interpretation.confirmation_message).toMatch(/M99/);
  });

  it('off-set machine_id that slips past the enum → reject (gate re-resolves)', async () => {
    const ctx = ctxOf({});
    // Simulate a misbehaving model that ignored the enum and emitted M99 in the id.
    const r = await runInterpret(
      { intent_id: 'machine_unavailability', machine_id: 'M99', start_min: 840, confidence: 'high' },
      'blocca M99 alle 14',
      ctx,
    );
    expect(r.interpretation.result).toBe('reject');
    expect(r.interpretation.unresolved_target).toBe('M99');
    expect(r.interpretation.payload).toEqual({});
  });

  it('intent_id "unknown" → reject with clarify message', async () => {
    const ctx = ctxOf({});
    const r = await runInterpret(
      { intent_id: 'unknown', confidence: 'high' },
      'quanto costa comprare una macchina nuova?',
      ctx,
    );
    expect(r.interpretation.result).toBe('reject');
    expect(r.interpretation.payload).toEqual({});
    expect(r.interpretation.confirmation_message).toBeTruthy();
  });

  it('missing required entity (no start_min) → reject', async () => {
    const ctx = ctxOf({});
    const r = await runInterpret(
      { intent_id: 'machine_unavailability', machine_id: 'M02', confidence: 'high' },
      'M02 rotta',
      ctx,
    );
    expect(r.interpretation.result).toBe('reject');
  });

  it('out-of-bounds minute → reject', async () => {
    const ctx = ctxOf({});
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M02',
        start_min: 999_999_999,
        confidence: 'high',
      },
      'M02 rotta',
      ctx,
    );
    expect(r.interpretation.result).toBe('reject');
  });
});

describe('interpretInstruction — gray (assumption / sub-high confidence)', () => {
  it('"m2 rotta" with start_min default + medium confidence + assumption → gray', async () => {
    const ctx = ctxOf({});
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M02',
        start_min: 0,
        confidence: 'medium',
        assumption: 'nessun orario esplicito: blocco da inizio orizzonte',
      },
      'm2 rotta',
      ctx,
    );
    expect(r.interpretation.result).toBe('gray');
    expect(r.interpretation.confirmation_message).toMatch(/assunzione|inizio orizzonte/i);
    // Even gray carries the canonical payload so the caller can confirm-then-solve.
    // end_min is materialised by the router's default_to:horizon_end (the max
    // deadline in ctx.order_deadlines = 4320) since the manager gave no end.
    expect(r.interpretation.payload).toEqual({
      unavailable_machines: { M02: [{ start_min: 0, end_min: 4320 }] },
    });
  });

  it('high confidence with NO assumption → hit (not gray)', async () => {
    const ctx = ctxOf({});
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M02',
        start_min: 840,
        end_min: 1080,
        confidence: 'high',
      },
      'M02 ferma dalle 14 alle 18 di oggi',
      ctx,
    );
    expect(r.interpretation.result).toBe('hit');
  });
});

describe('interpretInstruction — deadline + capacity + shift payload shapes', () => {
  it('deadline_change → deadline_changes payload', async () => {
    const ctx = ctxOf({});
    const r = await runInterpret(
      { intent_id: 'deadline_change', order_id: 'COM-001', new_deadline_min: 2520, confidence: 'high' },
      'sposta la scadenza di COM-001 a fine giornata di domani',
      ctx,
    );
    expect(r.interpretation.result).toBe('hit');
    expect(r.interpretation.payload).toEqual({
      deadline_changes: { 'COM-001': { new_deadline_min: 2520 } },
    });
  });

  it('capacity_addition (operators+shift) → extra_capacity payload', async () => {
    const ctx = ctxOf({});
    const r = await runInterpret(
      { intent_id: 'capacity_addition', operators: 1, shift: 'serale', confidence: 'high' },
      'aggiungi un operatore in turno serale',
      ctx,
    );
    expect(r.interpretation.result).toBe('hit');
    expect(r.interpretation.payload).toEqual({ extra_capacity: { operators: 1, shift: 'serale' } });
  });

  it('shift_window → shift_changes payload (bare "mattina" resolves)', async () => {
    const ctx = ctxOf({});
    const r = await runInterpret(
      { intent_id: 'shift_window', shift_id: 'mattina', start_min: 420, end_min: 720, confidence: 'high' },
      'anticipa il turno mattina',
      ctx,
    );
    expect(r.interpretation.result).toBe('hit');
    expect(r.interpretation.payload).toEqual({
      shift_changes: { turno_mattina: { start_min: 420, end_min: 720 } },
    });
  });
});

describe('interpretToolOutput — pure gate (no network)', () => {
  it('null tool input → reject', async () => {
    const ctx = ctxOf({});
    const mod = await import('../instruction-interpreter');
    const r = mod.interpretToolOutput(null, ctx);
    expect(r.result).toBe('reject');
    expect(r.payload).toEqual({});
  });

  it('drops optional capacity machine_id when off-set rather than rejecting', async () => {
    const ctx = ctxOf({});
    const mod = await import('../instruction-interpreter');
    const r = mod.interpretToolOutput(
      { intent_id: 'capacity_addition', operators: 2, machine_id: 'M99', confidence: 'high' },
      ctx,
    );
    expect(r.result).toBe('hit');
    expect(r.payload).toEqual({ extra_capacity: { operators: 2 } });
  });
});

describe('interpretInstruction — abort', () => {
  it('pre-aborted signal → reject + aborted, zero cost, no LLM call', async () => {
    const ctx = ctxOf({});
    const mod = await import('../instruction-interpreter');
    const controller = new AbortController();
    controller.abort();
    const r = await mod.interpretInstruction('M02 rotta', ctx, undefined, { signal: controller.signal });
    expect(r.aborted).toBe(true);
    expect(r.interpretation.result).toBe('reject');
    expect(r.cost_usd).toBe(0);
    expect(createMock).not.toHaveBeenCalled();
  });
});
