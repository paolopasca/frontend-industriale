import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 16.4 — A3 empty-dict guard + A4 cutoff auto-detect tests.
 *
 * A3: Reject underspecified rules (e.g. {deadline_changes: {COM-001: {}}})
 * BEFORE invoking the solver. Same failure class as F-W10-01 (silent no-op)
 * and Wave 16.3 CRITICAL-1 (sentinel "?" passthrough): a structurally valid
 * but actionless payload would round-trip through the solver and surface as
 * a "solved" SSE event with zero deltas, fooling the manager into thinking
 * a constraint was applied.
 *
 * A4: When the manager utterance contains "domani"/"giorno N"/"DD/MM",
 * derive the scenario start time and lift the frozen cutoff to that
 * boundary instead of the legacy `currentTimeMin + cushionMin`.
 */

const anthropicCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = { create: anthropicCreate };
    constructor(_: unknown) {
      void _;
    }
  }
  return { default: FakeAnthropic };
});

interface SseChunk {
  event: string;
  data: unknown;
}

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
      try { data = JSON.parse(raw); }
      catch { data = raw; }
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

const baseSolution = {
  status: 'OPTIMAL',
  fasi: [
    { commessa: 'COM-001', macchina: 'M-1', operatore: 'OP-1', start_min: 0, end_min: 60 },
    { commessa: 'COM-007', macchina: 'M-3', operatore: 'OP-2', start_min: 60, end_min: 120 },
  ],
  machines: ['M-1', 'M-3'],
  orders: ['COM-001', 'COM-007'],
};

const baseBody = {
  slug: 'acme-spa',
  originalSolution: baseSolution,
  kpis: { makespan_min: 2880, on_time_rate: 0.85, ritardo_totale_min: 120 },
  whatifText:
    '## 1. Interpretazione\n…\n## 4. Raccomandazione\nApplicabile.',
  consultationMd: '## Tipo problema: fjsp\n\nFabbrica acme.',
};

function makeRequest(body: unknown, ip = '127.0.0.1'): Request {
  return new Request('http://localhost:8080/api/apply-whatif', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': ip,
      'content-length': String(JSON.stringify(body).length),
    },
    body: JSON.stringify(body),
  });
}

async function invokeRoute(request: Request): Promise<Response> {
  const mod = await import('../../../routes/api/apply-whatif');
  const handler =
    (mod.Route as unknown as {
      options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
    }).options.server.handlers.POST;
  return handler({ request });
}

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL = '1';
  process.env.NODE_ENV = 'test';
  vi.resetModules();
  anthropicCreate.mockReset();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// A3 — empty-dict guard
// ─────────────────────────────────────────────────────────────────────────────

describe('Wave 16.4 A3 — empty-dict guard', () => {
  it('aborts when confirmedPayload contains deadline_changes with empty body', async () => {
    // Manager utterance "anticipa COM-001" without quantity. Backend
    // extractor HIT with deadline_changes:{COM-001:{}} — structurally valid
    // but actionless. The solver would no-op silently.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        deadline_changes: { 'COM-001': {} },
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.4'));
    expect(res.status).toBe(200);

    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).not.toContain('solving');
    expect(events).not.toContain('solved');
    expect(events).toContain('aborted_unsupported');

    const aborted = chunks.find((c) => c.event === 'aborted_unsupported')!.data as {
      reason: string;
      warnings: string[];
    };
    expect(aborted.reason).toBe('empty_or_underspecified_rules');
    expect(aborted.warnings).toContain('empty_or_underspecified_rules');
  });

  it('aborts when confirmedPayload has empty unavailable_machines window list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        unavailable_machines: { 'M-1': [] },
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.5'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chunks.find((c) => c.event === 'aborted_unsupported')).toBeTruthy();
  });

  it('aborts when confirmedPayload has empty operator_unavailability array (D1 contract)', async () => {
    // Wave 16.4 D1: operator_unavailability ships as ARRAY.
    // An empty array is meaningless and would silent no-op on solver.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        operator_unavailability: [],
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.51'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chunks.find((c) => c.event === 'aborted_unsupported')).toBeTruthy();
  });

  it('aborts when confirmedPayload operator_unavailability entry is missing windows (D1 contract)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        operator_unavailability: [
          { operator_id: 'OP-2', date: '2026-04-01' }, // no start_min/end_min
        ],
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.52'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chunks.find((c) => c.event === 'aborted_unsupported')).toBeTruthy();
  });

  it('passes through when confirmedPayload has a complete operator_unavailability entry (D1 contract)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL',
          method: 'cp-sat',
          solution: { status: 'OPTIMAL', fasi: [] },
          kpis: { makespan_min: 2700 },
          objective_value: 2700,
          warnings: [],
          cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        operator_unavailability: [
          { operator_id: 'OP-1', start_min: 840, end_min: 1080, date: '2026-04-01' },
        ],
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.53'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toContain('solving');
    expect(events).toContain('solved');
  });

  it('aborts when confirmedPayload has empty priority_orders array', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        priority_orders: [],
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.6'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chunks.find((c) => c.event === 'aborted_unsupported')).toBeTruthy();
  });

  it('passes through when confirmedPayload has a complete deadline_changes body', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL',
          method: 'cp-sat',
          solution: { status: 'OPTIMAL', fasi: [] },
          kpis: { makespan_min: 2700 },
          objective_value: 2700,
          warnings: [],
          cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        deadline_changes: { 'COM-001': { new_deadline_min: 1440 } },
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.7'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toContain('solving');
    expect(events).toContain('solved');
    expect(events).not.toContain('aborted_unsupported');
  });

  // Devil-advocate MEDIUM-1 (2026-05-27): combined rules where one key is
  // empty but another is meaningful must pass the guard. Pre-fix the early-
  // return pattern would reject this because the first empty key short-
  // circuited the function. OR-of-predicates refactor makes the guard
  // produce-the-disjunction semantics.

  it('passes through when combined rules have one empty key + one meaningful key (MEDIUM-1)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat',
          solution: { status: 'OPTIMAL', fasi: [] },
          kpis: { makespan_min: 2700 }, objective_value: 2700,
          warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        unavailable_machines: {}, // EMPTY
        priority_orders: ['COM-001'], // MEANINGFUL
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.81'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    // Combined rules: meaningful priority_orders key salvages the payload.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toContain('solving');
    expect(events).toContain('solved');
    expect(events).not.toContain('aborted_unsupported');
  });

  it('aborts when ALL keys are empty even if multiple are present (MEDIUM-1 inverse)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        unavailable_machines: {},
        priority_orders: [],
        deadline_changes: {},
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.82'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chunks.find((c) => c.event === 'aborted_unsupported')).toBeTruthy();
  });

  it('rejects sentinel "?" operator entry as not meaningful (defense-in-depth post-A2)', async () => {
    // Devil-advocate MEDIUM-2 note: if A2 sentinel early-return somehow
    // didn't fire (forceOpusFallback skips extractor entirely, then user
    // confirms a raw payload with sentinel), A3 must reject it as not
    // meaningful so the solver no-op illusion is prevented.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        operator_unavailability: [
          { operator_id: '?', start_min: 840, end_min: 1080, date: '2026-04-01' },
        ],
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.83'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chunks.find((c) => c.event === 'aborted_unsupported')).toBeTruthy();
  });

  it('aborts when extra_capacity is empty object (MEDIUM-3)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: { extra_capacity: {} },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.84'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chunks.find((c) => c.event === 'aborted_unsupported')).toBeTruthy();
  });

  it('aborts when shift_changes entry has empty body (MEDIUM-3)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: { shift_changes: { 'SHIFT-A': {} } },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.85'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chunks.find((c) => c.event === 'aborted_unsupported')).toBeTruthy();
  });

  it('passes through extra_capacity with shift+operators specified (MEDIUM-3 positive)', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat',
          solution: { status: 'OPTIMAL', fasi: [] },
          kpis: { makespan_min: 2700 }, objective_value: 2700,
          warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        extra_capacity: { operators: 1, shift: 'serale' },
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.16.86'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toContain('solved');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A4 — cutoff auto-detect from manager utterance
// ─────────────────────────────────────────────────────────────────────────────

describe('Wave 16.4 A4 — cutoff auto-detect from text', () => {
  // We exercise the helper directly from frozen-window-builder + assert the
  // route uses it when constructing cutoffMin. The route-level cutoffMin
  // appears on the wire as request.body.cutoff_min sent to /solve-template.

  function fakeHaikuOrderPriority() {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          intent_id: 'order_priority',
          entities: { order_ids: ['COM-001'] },
          confidence: 'high',
        }),
      }],
      usage: {
        input_tokens: 100, output_tokens: 30,
        cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      },
    };
  }

  it('default behaviour: no temporal phrase → cutoff = currentTimeMin + cushionMin', async () => {
    anthropicCreate.mockResolvedValueOnce(fakeHaikuOrderPriority());
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat', solution: {}, kpis: {},
          objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'priorità COM-001',
      currentTimeMin: 90,
      cushionMin: 30,
    }, '10.0.16.40'));
    expect(res.status).toBe(200);
    await streamToString(res.body!);

    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.cutoff_min).toBe(120);
  });

  it('"domani" in managerText: cutoff shifts to start of day 2 (1440 min)', async () => {
    anthropicCreate.mockResolvedValueOnce(fakeHaikuOrderPriority());
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat', solution: {}, kpis: {},
          objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'anticipa COM-001 a domani mattina',
      currentTimeMin: 90,
      cushionMin: 30,
    }, '10.0.16.41'));
    expect(res.status).toBe(200);
    await streamToString(res.body!);

    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.cutoff_min).toBe(1440);
  });

  it('"giorno 2" in managerText: cutoff = (2-1)*1440 = 1440', async () => {
    anthropicCreate.mockResolvedValueOnce(fakeHaikuOrderPriority());
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat', solution: {}, kpis: {},
          objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'sposta COM-001 al giorno 2',
      currentTimeMin: 90,
      cushionMin: 30,
    }, '10.0.16.42'));
    expect(res.status).toBe(200);
    await streamToString(res.body!);

    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.cutoff_min).toBe(1440);
  });

  it('"dopodomani" in managerText: cutoff = 2*1440 = 2880', async () => {
    anthropicCreate.mockResolvedValueOnce(fakeHaikuOrderPriority());
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat', solution: {}, kpis: {},
          objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'COM-001 va consegnata dopodomani',
      currentTimeMin: 90,
      cushionMin: 30,
    }, '10.0.16.43'));
    expect(res.status).toBe(200);
    await streamToString(res.body!);

    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.cutoff_min).toBe(2880);
  });

  // Devil-advocate LOW: cushionMin > 1440 is rejected by the Zod schema
  // at apply-whatif.ts:72 (z.number().int().min(0).max(1_440)). This
  // protects against a misconfigured UI pushing the cutoff past the
  // planning horizon.
  it('rejects cushionMin > 1440 as Zod validation error (LOW corner)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'priorità COM-001',
      currentTimeMin: 90,
      cushionMin: 2000, // exceeds the 1440 cap
    }, '10.0.16.44'));
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('invalid_body');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts cushionMin = 1440 exactly at the cap boundary (LOW corner)', async () => {
    anthropicCreate.mockResolvedValueOnce(fakeHaikuOrderPriority());
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat', solution: {}, kpis: {},
          objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'priorità COM-001', // no temporal phrase, default path
      currentTimeMin: 0,
      cushionMin: 1440,
    }, '10.0.16.45'));
    expect(res.status).toBe(200);
    await streamToString(res.body!);

    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.cutoff_min).toBe(1440);
  });

  // Devil-advocate MEDIUM-1 (2026-05-27): clamp pattern. When manager-elapsed
  // clock (currentTimeMin + cushionMin) is beyond the detected scenario start,
  // the legacy value wins so already-elapsed phases stay frozen.

  it('clamps cutoff to max(detected, legacy) when currentTime is past detected (MEDIUM-1)', async () => {
    anthropicCreate.mockResolvedValueOnce(fakeHaikuOrderPriority());
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat', solution: {}, kpis: {},
          objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Manager utterance "domani" → detected = 1440.
    // Manager is already on day 3: currentTimeMin = 4000, cushionMin = 30 → legacy = 4030.
    // Clamp: max(1440, 4030) = 4030 (legacy wins).
    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'ferma M-1 domani dalle 14',
      currentTimeMin: 4000,
      cushionMin: 30,
    }, '10.0.16.46'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));

    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.cutoff_min).toBe(4030);

    // Solved warning must surface the clamp event for audit.
    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      warnings: string[];
    };
    expect(solved.warnings).toContain('a4_cutoff_clamped_to_currentTime');
  });

  it('does NOT clamp when currentTime is before detected (MEDIUM-1 inverse)', async () => {
    anthropicCreate.mockResolvedValueOnce(fakeHaikuOrderPriority());
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat', solution: {}, kpis: {},
          objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Manager utterance "domani" → detected = 1440.
    // Manager is on hour 1.5: currentTimeMin = 90, cushionMin = 30 → legacy = 120.
    // Clamp: max(1440, 120) = 1440 (detected wins, no clamp marker).
    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'ferma M-1 domani dalle 14',
      currentTimeMin: 90,
      cushionMin: 30,
    }, '10.0.16.47'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));

    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.cutoff_min).toBe(1440);
    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      warnings: string[];
    };
    expect(solved.warnings).not.toContain('a4_cutoff_clamped_to_currentTime');
  });

  // Devil-advocate MEDIUM-2: ambiguous temporal phrases must surface a warning.

  it('emits ambiguity warning when manager utters multiple temporal phrases', async () => {
    anthropicCreate.mockResolvedValueOnce(fakeHaikuOrderPriority());
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat', solution: {}, kpis: {},
          objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'attenzione: dopodomani arriva il giorno 5, ferma M-1',
      currentTimeMin: 90,
      cushionMin: 30,
    }, '10.0.16.48'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      warnings: string[];
    };
    expect(solved.warnings.some((w) => w.startsWith('a4_ambiguous_temporal_picked_'))).toBe(true);
    // Priority order picks dopodomani first.
    expect(solved.warnings).toContain('a4_ambiguous_temporal_picked_dopodomani');

    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.cutoff_min).toBe(2880); // dopodomani winner
  });

  // Devil-advocate LOW-5: cutoff beyond horizon must surface a warning.

  it('emits horizon-overshoot warning when detected cutoff > max end_min in baseline', async () => {
    anthropicCreate.mockResolvedValueOnce(fakeHaikuOrderPriority());
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat', solution: {}, kpis: {},
          objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    // baseSolution.fasi has max end_min = 120. "fra 100 giorni" → 144000.
    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'fra 100 giorni anticipa COM-001',
      currentTimeMin: 90,
      cushionMin: 30,
    }, '10.0.16.49'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      warnings: string[];
    };
    expect(solved.warnings.some((w) => w.startsWith('a4_cutoff_beyond_horizon:'))).toBe(true);
  });

  it('does NOT emit horizon warning when detected cutoff fits inside baseline horizon', async () => {
    const longSolution = {
      status: 'OPTIMAL',
      fasi: [
        { commessa: 'COM-001', macchina: 'M-1', start_min: 0, end_min: 60 },
        { commessa: 'COM-007', macchina: 'M-3', start_min: 60, end_min: 5000 },
      ],
      machines: ['M-1', 'M-3'],
      orders: ['COM-001', 'COM-007'],
    };
    anthropicCreate.mockResolvedValueOnce(fakeHaikuOrderPriority());
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat', solution: {}, kpis: {},
          objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      originalSolution: longSolution,
      managerText: 'ferma M-1 domani', // detected = 1440 < 5000
      currentTimeMin: 90,
      cushionMin: 30,
    }, '10.0.16.50'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      warnings: string[];
    };
    expect(solved.warnings.some((w) => w.startsWith('a4_cutoff_beyond_horizon:'))).toBe(false);
  });
});
