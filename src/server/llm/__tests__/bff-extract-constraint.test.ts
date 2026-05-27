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

  // ── Wave 16.3 retry-path tests (task #18) ───────────────────────────────────
  // After Wave 16.2 shipped the GRAY_ZONE confirmation modal, two retry
  // paths were added to the BFF orchestration. The translator gets one of
  // them (forceOpusFallback) directly; the other (userConfirmedGrayZone +
  // confirmedPayload) is handled at the route level which short-circuits
  // BEFORE invoking the translator — verified end-to-end here so both
  // sides of the contract stay in sync.

  it('forceOpusFallback=true: SKIPS the backend extractor and calls Opus directly', async () => {
    // Sentinel: if the translator mistakenly calls the backend extractor,
    // the fetch mock would record the call and the test would fail.
    createMock.mockResolvedValueOnce(makeOpusReply('force_priority'));

    const { translateWhatIfToConstraint } = await import('../constraint-translator');
    const result = await translateWhatIfToConstraint({
      ...baseInput,
      forceOpusFallback: true,
    });

    // Backend extractor MUST NOT be called.
    expect(fetchMock).not.toHaveBeenCalled();
    // Opus translator MUST be called exactly once.
    expect(createMock).toHaveBeenCalledOnce();
    expect(result.change.type).toBe('force_priority');
  });
});

// ── BFF route-level retry-path test (task #18, gray-zone confirmation) ────────
// userConfirmedGrayZone + confirmedPayload is consumed by the route at
// src/routes/api/apply-whatif.ts:597 — it bypasses translateWhatIfToConstraint
// entirely. That contract can only be tested at the route level, so we drive
// the SSE handler directly here.

interface SseChunk { event: string; data: unknown }

function parseSse(text: string): SseChunk[] {
  const chunks: SseChunk[] = [];
  for (const block of text.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = '';
    const dataLines: string[] = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    let data: unknown = null;
    if (dataLines.length > 0) {
      const raw = dataLines.join('\n');
      try { data = JSON.parse(raw); } catch { data = raw; }
    }
    if (event) chunks.push({ event, data });
  }
  return chunks;
}

async function streamToString(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe('Wave 16.3 BFF orchestration — gray-zone confirmation retry', () => {
  it('userConfirmedGrayZone+confirmedPayload: SKIPS both extractor and Opus, passes payload to solver', async () => {
    process.env.NODE_ENV = 'test';
    process.env.DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL = '1';

    // Mock the solver backend so the route can reach the `solved` event.
    // The fetch mock is also the sentinel for the extractor: if the BFF
    // calls /api/public/extract-constraint, we'd see a request with the
    // ExtractConstraintResponse shape — we assert below that the only
    // fetch call is to /solve-template.
    const solvePayload = {
      status: 'OPTIMAL',
      method: 'cp-sat',
      solution: { status: 'OPTIMAL', fasi: [] },
      kpis: { makespan_min: 480 },
      objective_value: 480,
      warnings: [],
      cost_usd: 0,
    };
    const fetchCalls: string[] = [];
    const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      fetchCalls.push(url);
      return new Response(JSON.stringify(solvePayload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const baseSolution = {
      status: 'OPTIMAL',
      fasi: [{ commessa: 'COM-001', macchina: 'M-1', start_min: 0, end_min: 60 }],
      machines: ['M-1'],
      orders: ['COM-001'],
    };
    const body = {
      slug: 'acme-spa',
      originalSolution: baseSolution,
      kpis: { makespan_min: 480 },
      whatifText: '## 1. Interpretazione\nAnticipa COM-001.\n## 4. Raccomandazione\nApplicabile.',
      consultationMd: '## Tipo problema: fjsp\n',
      userConfirmedGrayZone: true,
      confirmedPayload: { priority_orders: ['COM-001'] },
    };
    const request = new Request('http://localhost:8080/api/apply-whatif', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': '10.0.0.99',
        'content-length': String(JSON.stringify(body).length),
      },
      body: JSON.stringify(body),
    });

    const mod = await import('../../../routes/api/apply-whatif');
    const handler =
      (mod.Route as unknown as {
        options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
      }).options.server.handlers.POST;
    const res = await handler({ request });
    expect(res.status).toBe(200);

    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // Opus translator MUST NOT be called.
    expect(createMock).not.toHaveBeenCalled();
    // No `translating`/`translated` events — the translator was bypassed.
    expect(events).not.toContain('translating');
    expect(events).not.toContain('translated');
    // The only outbound HTTP call MUST be the solver — never the extractor.
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]).toMatch(/solve-template/);
    expect(fetchCalls.every((u) => !/extract-constraint/.test(u))).toBe(true);

    // The confirmed payload must round-trip into the solve request body.
    // Cast to unknown[] because the global fetch type only declares one
    // argument in its tuple even though fetch(url, init) accepts two.
    const solveCall = fetchSpy.mock.calls[0] as unknown as [unknown, RequestInit?];
    const initBody = solveCall[1]?.body;
    expect(typeof initBody).toBe('string');
    const solveReq = JSON.parse(initBody as string) as Record<string, unknown>;
    // resolveTemplate forwards the rules object somewhere in its body —
    // verify our confirmedPayload value made it through, regardless of
    // which top-level key the backend contract uses.
    expect(JSON.stringify(solveReq)).toContain('"priority_orders"');
    expect(JSON.stringify(solveReq)).toContain('"COM-001"');

    // The stream resolves to `solved` → `done` (the happy retry path).
    expect(events).toContain('solved');
    expect(events[events.length - 1]).toBe('done');
  });
});
