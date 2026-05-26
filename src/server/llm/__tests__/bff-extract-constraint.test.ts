import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExtractConstraintResponse } from '../extract-constraint-client';

/**
 * Wave 16.2 BFF integration tests.
 *
 * Verifies that the orchestration layer in translateWhatIfToConstraint():
 * - Skips Opus when the backend returns HIT (confidence ≥ 0.85)
 * - Skips Opus and returns requiresConfirmation=true when backend returns GRAY_ZONE
 * - Falls back to Opus when backend returns MISS
 * - Falls back to Opus when backend times out or returns 5xx (no throw)
 */

// ── Anthropic SDK mock ────────────────────────────────────────────────────────
const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = { create: createMock };
    constructor(_: unknown) { void _; }
  }
  return { default: FakeAnthropic };
});

// ── fetch mock ────────────────────────────────────────────────────────────────
const fetchMock = vi.spyOn(globalThis, 'fetch');

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.VITE_API_BASE_URL = 'http://localhost:8001';
  process.env.DAINO_INTERNAL_SECRET = 'test-secret';
  vi.resetModules();
  createMock.mockReset();
  fetchMock.mockReset();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.VITE_API_BASE_URL;
  delete process.env.DAINO_INTERNAL_SECRET;
});

function makeBackendResponse(r: ExtractConstraintResponse): Response {
  return {
    ok: true,
    status: 200,
    json: async () => r,
    text: async () => JSON.stringify(r),
  } as unknown as Response;
}

function makeOpusReply(type = 'force_priority') {
  const payload =
    type === 'force_priority'
      ? { priority_orders: ['COM-001'] }
      : { unavailable_machines: { 'M-1': [{ start_min: 0, end_min: 60 }] } };
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          type,
          rules: payload,
          rationale: 'test',
          confidence: 'high',
          warnings: [],
        }),
      },
    ],
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

const baseInput = {
  whatifText: 'Il manager chiede di anticipare COM-001.',
  originalSolution: {
    status: 'OPTIMAL',
    fasi: [{ commessa: 'COM-001', macchina: 'M-1', start_min: 0, end_min: 60 }],
    orders: ['COM-001'],
    machines: ['M-1'],
  },
  kpis: { makespan_min: 480 },
};

// ─────────────────────────────────────────────────────────────────────────────

describe('Wave 16.2 BFF orchestration', () => {
  it('HIT: does not call Opus, returns ConstraintChange with correct type and rules', async () => {
    const hitResponse: ExtractConstraintResponse = {
      result: 'hit',
      confidence: 0.92,
      payload: { priority_orders: ['COM-001'] },
      rationale: 'Commessa COM-001 deve essere anticipata.',
      pattern_id: 'P-001',
      confirmation_message: null,
    };

    fetchMock.mockResolvedValueOnce(makeBackendResponse(hitResponse));

    const { translateWhatIfToConstraint } = await import('../constraint-translator');
    const result = await translateWhatIfToConstraint(baseInput);

    expect(createMock).not.toHaveBeenCalled();
    expect(result.change.type).toBe('force_priority');
    expect(result.change.rules).toMatchObject({ priority_orders: ['COM-001'] });
    expect(result.change.confidence).toBe('high');
    expect(result.change.requiresConfirmation).toBeFalsy();
  });

  it('GRAY_ZONE: does not call Opus, returns requiresConfirmation=true with confirmationMessage', async () => {
    const grayResponse: ExtractConstraintResponse = {
      result: 'gray_zone',
      confidence: 0.65,
      payload: { priority_orders: ['COM-001'] },
      rationale: 'Possibile richiesta di priorità.',
      pattern_id: null,
      confirmation_message: 'Vuoi davvero anticipare COM-001?',
    };

    fetchMock.mockResolvedValueOnce(makeBackendResponse(grayResponse));

    const { translateWhatIfToConstraint } = await import('../constraint-translator');
    const result = await translateWhatIfToConstraint(baseInput);

    expect(createMock).not.toHaveBeenCalled();
    expect(result.change.requiresConfirmation).toBe(true);
    expect(result.change.confirmationMessage).toBe('Vuoi davvero anticipare COM-001?');
    expect(result.change.confidence).toBe('medium');
  });

  it('MISS: falls back to Opus', async () => {
    const missResponse: ExtractConstraintResponse = {
      result: 'miss',
      confidence: 0.3,
      payload: null,
      rationale: '',
      pattern_id: null,
      confirmation_message: null,
    };

    fetchMock.mockResolvedValueOnce(makeBackendResponse(missResponse));
    createMock.mockResolvedValueOnce(makeOpusReply('force_priority'));

    const { translateWhatIfToConstraint } = await import('../constraint-translator');
    const result = await translateWhatIfToConstraint(baseInput);

    expect(createMock).toHaveBeenCalledOnce();
    expect(result.change.type).toBe('force_priority');
  });

  it('Backend network error/timeout: falls back to Opus, does not throw', async () => {
    fetchMock.mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'));
    createMock.mockResolvedValueOnce(makeOpusReply('force_priority'));

    const { translateWhatIfToConstraint } = await import('../constraint-translator');
    const result = await translateWhatIfToConstraint(baseInput);

    expect(createMock).toHaveBeenCalledOnce();
    expect(result.change.type).toBe('force_priority');
  });

  it('Backend 500: falls back to Opus, does not throw', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as unknown as Response);
    createMock.mockResolvedValueOnce(makeOpusReply('force_priority'));

    const { translateWhatIfToConstraint } = await import('../constraint-translator');
    const result = await translateWhatIfToConstraint(baseInput);

    expect(createMock).toHaveBeenCalledOnce();
    expect(result.change.type).toBe('force_priority');
  });
});
