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
    time_config: partial.time_config ?? null,
    shift_types: partial.shift_types ?? {
      turno_mattina: { start: 480, end: 840 },
      turno_pomeriggio: { start: 840, end: 1080 },
      turno_serale: { start: 1080, end: 1320 },
    },
    order_deadlines: partial.order_deadlines ?? { 'COM-001': 2880, 'COM-007': 4320 },
  };
}

// Wave 16.8: a 24h/midnight time_config makes the symbolic→resolver path
// reproduce the legacy absolute minutes (giorno N = N*1440, ore = h*60), so
// pre-16.8 expectations still hold. TC_DEMO mirrors a real 06:00–22:00 plant.
const TC_24H = { day_length_min: 1440, company_start_hour: 0, start_date: '2026-06-01' };
const TC_DEMO = { day_length_min: 960, company_start_hour: 6, start_date: '2026-04-01' };

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
    const ctx = ctxOf({ time_config: TC_24H });
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M02',
        day_ref: 'domani',
        start_hour: 14,
        end_hour: 18,
        confidence: 'high',
      },
      'blocca la linea 2 da domani pomeriggio fino a fine giornata',
      ctx,
    );
    expect(r.interpretation.result).toBe('hit');
    // Wave 16.8: symbolic {domani,14-18} resolved on 24h/midnight ctx → the
    // same absolute minutes the old hardcoded path produced.
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

  it('absurd day far past the horizon → reject (resolver sanity ceiling)', async () => {
    const ctx = ctxOf({ time_config: TC_24H });
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M02',
        day_ref: '100000',
        confidence: 'high',
      },
      'M02 rotta il giorno 100000',
      ctx,
    );
    expect(r.interpretation.result).toBe('reject');
  });
});

describe('interpretInstruction — gray (assumption / sub-high confidence)', () => {
  it('"m2 rotta" with start_min default + medium confidence + assumption → gray', async () => {
    const ctx = ctxOf({ time_config: TC_24H });
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M02',
        day_ref: 'oggi',
        confidence: 'medium',
        assumption: 'giorno non esplicito: assunto oggi, intera giornata',
      },
      'm2 rotta',
      ctx,
    );
    expect(r.interpretation.result).toBe('gray');
    expect(r.interpretation.confirmation_message).toMatch(/assun|giornata|oggi/i);
    // Wave 16.8: bare "rotta" with no time → whole day TODAY [0, day_length]
    // (resolver), not the whole horizon. More conservative; the manager extends
    // if the stop lasts longer. Gray still carries the payload to confirm-then-solve.
    expect(r.interpretation.payload).toEqual({
      unavailable_machines: { M02: [{ start_min: 0, end_min: 1440 }] },
    });
  });

  it('high confidence with NO assumption → hit (not gray)', async () => {
    const ctx = ctxOf({ time_config: TC_24H });
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M02',
        day_ref: 'oggi',
        start_hour: 14,
        end_hour: 18,
        confidence: 'high',
      },
      'M02 ferma dalle 14 alle 18 di oggi',
      ctx,
    );
    expect(r.interpretation.result).toBe('hit');
  });
});

describe('interpretInstruction — Wave 16.8 L-aware temporal grounding', () => {
  it('demo (960/06:00): "M3 domani dalle 14 alle 18" → giorno 2 14-18 = [1440,1680], NOT [2280,2520]', async () => {
    const ctx = ctxOf({ time_config: TC_DEMO });
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M03',
        day_ref: 'domani',
        start_hour: 14,
        end_hour: 18,
        confidence: 'high',
      },
      'M3 rotta domani dalle 14 alle 18',
      ctx,
    );
    expect(r.interpretation.result).toBe('hit');
    expect(r.interpretation.payload).toEqual({
      unavailable_machines: { M03: [{ start_min: 1440, end_min: 1680 }] },
    });
  });

  it('demo: "M3 dal giorno 2 al giorno 4" → giorni 2-3 = [960, 2880)', async () => {
    const ctx = ctxOf({ time_config: TC_DEMO });
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M03',
        day_ref: '2',
        day_ref_end: '4',
        confidence: 'high',
      },
      'M3 ferma dal giorno 2 al giorno 4',
      ctx,
    );
    expect(r.interpretation.result).toBe('hit');
    expect(r.interpretation.payload).toEqual({
      unavailable_machines: { M03: [{ start_min: 960, end_min: 2880 }] },
    });
  });

  it('demo: dayAnchor folds "oggi" — siamo al giorno 2, oggi 14-18 → [1440,1680]', async () => {
    const ctx = ctxOf({ time_config: TC_DEMO });
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M03',
        day_ref: 'oggi',
        start_hour: 14,
        end_hour: 18,
        confidence: 'high',
      },
      'siamo al giorno 2, ferma M3 dalle 14 alle 18',
      ctx,
      2,
    );
    expect(r.interpretation.result).toBe('hit');
    expect(r.interpretation.payload).toEqual({
      unavailable_machines: { M03: [{ start_min: 1440, end_min: 1680 }] },
    });
  });

  it('apply-both: "m2 e m3 rotte domani" → blocks M02 AND M03, same window', async () => {
    const ctx = ctxOf({ time_config: TC_DEMO });
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_ids: ['M02', 'M03'],
        day_ref: 'domani',
        confidence: 'high',
      },
      'm2 e m3 rotte domani',
      ctx,
    );
    expect(r.interpretation.result).toBe('hit');
    expect(r.interpretation.payload).toEqual({
      unavailable_machines: {
        M02: [{ start_min: 960, end_min: 1920 }],
        M03: [{ start_min: 960, end_min: 1920 }],
      },
    });
  });

  it('apply-both anti-hallucination: any off-set machine in machine_ids → reject', async () => {
    const ctx = ctxOf({ time_config: TC_DEMO });
    const r = await runInterpret(
      {
        intent_id: 'machine_unavailability',
        machine_ids: ['M02', 'M99'],
        day_ref: 'domani',
        confidence: 'high',
      },
      'm2 e m99 rotte domani',
      ctx,
    );
    expect(r.interpretation.result).toBe('reject');
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
