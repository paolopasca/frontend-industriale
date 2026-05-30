import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-W8-07 — low_confidence_classification warning (Wave 9 w9-bff-frontend).
 *
 * When the Haiku intent parser returns `confidence: 'low'` the BFF still
 * applies the classified intent (no short-circuit) but tags
 * `low_confidence_classification` on the solved.warnings array AND emits
 * a structured server-side log entry. The UI then renders a yellow,
 * informative banner ("verify the result matches your intent").
 *
 * This is intentionally DIFFERENT from B-W8-S-04 (`unknown + high`) which
 * short-circuits straight to aborted_unsupported.
 *
 * Coverage:
 *   - Happy path: low + machine_unavailability still solves, warning present.
 *   - Negative: confidence='medium' does NOT emit the warning.
 *   - Negative: confidence='high' does NOT emit the warning.
 *   - Negative: confidence='low' on unknown intent_id still goes to
 *     Strategy C (Opus translator cascade), warning still tagged.
 *   - Log channel: console.warn invoked with structured payload.
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

function fakeHaikuReply(payload: object) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: {
      input_tokens: 180,
      output_tokens: 25,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const nestedSolution = {
  'COM-001': {
    fasi: [
      { operazione: 'OP-1', macchina: 'M01', operatore: 'OP-A', start_min: 0, end_min: 60 },
      { operazione: 'OP-2', macchina: 'M02', operatore: 'OP-A', start_min: 60, end_min: 120 },
    ],
  },
  'COM-007': {
    fasi: [
      { operazione: 'OP-1', macchina: 'M03', operatore: 'OP-B', start_min: 0, end_min: 80 },
    ],
  },
};

const baseBody = {
  slug: 'acme-spa',
  originalSolution: nestedSolution,
  kpis: { makespan_min: 2880 },
  whatifText: '## 1. Interpretazione\n…',
  consultationMd: '## Tipo problema: fjsp\n',
};

function makeRequest(body: unknown, ip: string): Request {
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

describe('F-W8-07 — low_confidence_classification warning', () => {
  it('confidence=low + supported intent → solve completes with low_confidence_classification warning', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'machine_unavailability',
        entities: { machine_id: 'M02', start_min: 720, end_min: 1080 },
        confidence: 'low',
        fallback_reasoning: "evento passato ('ieri sera'), assunzione su finestra",
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        status: 'OPTIMAL',
        method: 'cp-sat',
        solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } },
        kpis: { makespan_min: 2900 },
        objective_value: 2900,
        warnings: [],
        cost_usd: 0,
        wave7: { cutoff_min: null, locked_count: 0, frozen_phases: [], apply_rules: [] },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'M2 in panne ieri sera' },
        '10.0.97.1',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // Stream must complete normally — NO short-circuit on low confidence.
    expect(events).toContain('parsing_intent');
    expect(events).toContain('intent_parsed');
    expect(events).toContain('routed');
    expect(events).toContain('solving');
    expect(events).toContain('solved');
    expect(events).toContain('done');
    expect(events).not.toContain('aborted_unsupported');
    expect(events).not.toContain('error');

    // The warning must appear in solved.warnings so the SolutionDiff
    // banner lights up.
    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      status: string;
      warnings: string[];
    };
    expect(solved.warnings).toContain('low_confidence_classification');

    // Backend was called exactly once — the constraint was still applied.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('confidence=medium does NOT emit low_confidence_classification', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'machine_unavailability',
        entities: { machine_id: 'M02', start_min: 2880, end_min: 4320 },
        confidence: 'medium',
        fallback_reasoning: 'whole_day_default_no_explicit_time',
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        status: 'OPTIMAL',
        method: 'cp-sat',
        solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } },
        kpis: { makespan_min: 2900 },
        objective_value: 2900,
        warnings: [],
        cost_usd: 0,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'M02 in panne gg3' },
        '10.0.97.2',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      warnings: string[];
    };
    expect(solved.warnings).not.toContain('low_confidence_classification');
  });

  it('confidence=high does NOT emit low_confidence_classification', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'order_priority',
        entities: { order_ids: ['COM-001'] },
        confidence: 'high',
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        status: 'OPTIMAL',
        method: 'cp-sat',
        solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } },
        kpis: { makespan_min: 2900 },
        objective_value: 2900,
        warnings: [],
        cost_usd: 0,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'priorità COM-001' },
        '10.0.97.3',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      warnings: string[];
    };
    expect(solved.warnings).not.toContain('low_confidence_classification');
  });

  it('confidence=low on unknown intent_id still emits warning AND still falls back to Strategy C (Opus translator)', async () => {
    // Haiku returns unknown + low → B-W8-S-04 short-circuit does NOT
    // fire (it only fires on unknown + HIGH). The router still cascades
    // to the Opus translator (strategy C). The warning must travel
    // through that path too, ending up on the solved.warnings.
    //
    // Sequence: 1st anthropic call = Haiku (unknown+low). 2nd anthropic
    // call = Opus translator returning a force_priority constraint
    // payload (the constraint-translator's expected wire schema).
    anthropicCreate
      .mockResolvedValueOnce(
        fakeHaikuReply({
          intent_id: 'unknown',
          entities: {},
          confidence: 'low',
          fallback_reasoning: 'incerto, richiede translator',
        }),
      )
      .mockResolvedValueOnce({
        content: [{
          type: 'text',
          text: JSON.stringify({
            type: 'force_priority',
            rules: { priority_orders: ['COM-001'] },
            rationale: 'Manager wants COM-001 anticipated.',
            confidence: 'high',
            warnings: [],
          }),
        }],
        usage: {
          input_tokens: 800,
          output_tokens: 60,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      });

    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        status: 'OPTIMAL',
        method: 'cp-sat',
        solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } },
        kpis: { makespan_min: 2900 },
        objective_value: 2900,
        warnings: [],
        cost_usd: 0,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'qualcosa di un po incerto su COM-001' },
        '10.0.97.4',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // Must NOT short-circuit (B-W8-S-04 fires only on unknown+high).
    expect(events).not.toContain('aborted_unsupported');
    expect(events).toContain('solved');

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      warnings: string[];
    };
    // The low_confidence marker must survive the Strategy C detour and
    // reach the UI.
    expect(solved.warnings).toContain('low_confidence_classification');
  });

  it('logs a structured server-side warning when low_confidence triggers (audit channel)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      anthropicCreate.mockResolvedValueOnce(
        fakeHaikuReply({
          intent_id: 'machine_unavailability',
          entities: { machine_id: 'M2', start_min: 0 },
          confidence: 'low',
          fallback_reasoning: 'evento passato',
        }),
      );
      const fetchMock = vi.fn().mockResolvedValueOnce(
        jsonResponse({
          status: 'OPTIMAL',
          method: 'cp-sat',
          solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } },
          kpis: { makespan_min: 2900 },
          objective_value: 2900,
          warnings: [],
          cost_usd: 0,
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      await invokeRoute(
        makeRequest(
          { ...baseBody, managerText: 'M2 in panne ieri sera' },
          '10.0.97.5',
        ),
      );

      // Drain stream to ensure the route fully completed.
      // (Already awaited via invokeRoute → handler returns the stream;
      // we re-read below.)

      // console.warn must have been called at least once with a payload
      // tagged "low_confidence_classification" so production logs are
      // greppable for audit.
      const lowConfidenceLog = warnSpy.mock.calls.find((call) =>
        call.some(
          (arg) =>
            typeof arg === 'string' && arg.includes('low_confidence_classification'),
        ),
      );
      expect(lowConfidenceLog).toBeDefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
