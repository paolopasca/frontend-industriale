import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 4.1 — BFF apply-whatif route tests.
 *
 * Strategy:
 *   - Mock `@anthropic-ai/sdk` so the translator never hits the network.
 *   - Mock `globalThis.fetch` so resolveTemplate() never hits the
 *     backend; the test supplies the fake solve response inline.
 *   - Drive the route by importing the file route's POST handler and
 *     calling it with a synthetic Request.
 *   - Parse the streamed SSE body into a list of { event, data } pairs
 *     and assert on the sequence + payloads.
 *
 * Covered scenarios (task #8 requirement):
 *   1. Happy path: translator + solve OK.
 *   2. Unsupported: translator returns type='unsupported' → no solve.
 *   3. Backend 500 → error event with detail.
 *   4. Client disconnect during solve → AbortController propagates.
 *
 * Two extra defensive tests live below:
 *   5. Concurrent request from same IP → 409 conflict.
 *   6. Invalid body → 400 invalid_body.
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

function fakeAnthropicReply(payload: object, usage?: Partial<{
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}>) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: {
      input_tokens: usage?.input_tokens ?? 100,
      output_tokens: usage?.output_tokens ?? 40,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    },
  };
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
    '## 1. Interpretazione\nFermo di M-3 dalle 14 alle 18.\n## 4. Raccomandazione\nApplicabile.',
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
  // Disable rate-limit bypass even for "local" IPs so each test starts
  // with a clean slate but doesn't accidentally trip the limiter — we
  // use unique IPs per test instead.
  process.env.DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL = '1';
  process.env.NODE_ENV = 'test';
  vi.resetModules();
  anthropicCreate.mockReset();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
  vi.unstubAllGlobals();
});

describe('POST /api/apply-whatif', () => {
  it('happy path: streams translating → translated → solving → solved → done', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeAnthropicReply({
        type: 'block_machine',
        rules: {
          unavailable_machines: {
            'M-3': [{ start_min: 840, end_min: 1080, label: 'manutenzione' }],
          },
        },
        rationale: 'Fermo M-3 14-18.',
        confidence: 'high',
        warnings: [],
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL',
          method: 'cp-sat',
          // Non-empty solution so the Wave 16.6 §D empty-solution guard does
          // not (correctly) demote this to aborted_unsupported — this test
          // exercises the solved path.
          solution: {
            'COM-001': { fasi: [{ macchina: 'M-1', operatore: 'OP-1', start_min: 0, end_min: 60 }] },
            'COM-007': { fasi: [{ macchina: 'M-3', operatore: 'OP-2', start_min: 1080, end_min: 1140 }] },
          },
          kpis: { makespan_min: 3120, on_time_rate: 0.78, ritardo_totale_min: 180 },
          objective_value: 3120,
          warnings: ['M-3 fermo: makespan peggiorato di 240 min'],
          cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest(baseBody, '10.0.0.1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const body = await streamToString(res.body!);
    const chunks = parseSse(body);
    const events = chunks.map((c) => c.event);
    expect(events).toEqual(['translating', 'translated', 'solving', 'solved', 'done']);

    const translated = chunks.find((c) => c.event === 'translated')!.data as {
      change: { type: string; rules: { unavailable_machines?: Record<string, unknown> } };
    };
    expect(translated.change.type).toBe('block_machine');
    expect(translated.change.rules.unavailable_machines).toBeDefined();

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      newKpis: Record<string, number>;
      deltaKpis: Record<string, number>;
      warnings: string[];
    };
    expect(solved.newKpis.makespan_min).toBe(3120);
    expect(solved.deltaKpis.makespan_min).toBe(240); // 3120 - 2880
    expect(solved.deltaKpis.on_time_rate).toBeCloseTo(-0.07, 5);
    expect(solved.warnings).toContain('M-3 fermo: makespan peggiorato di 240 min');

    const done = chunks.find((c) => c.event === 'done')!.data as { cost_usd: number };
    expect(done.cost_usd).toBeGreaterThan(0);

    // Verify the backend was called exactly once with the translated rules.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchUrl = fetchMock.mock.calls[0][0] as string;
    expect(fetchUrl).toMatch(/\/api\/public\/solve-template$/);
    const fetchInit = fetchMock.mock.calls[0][1] as RequestInit;
    const sentBody = JSON.parse(fetchInit.body as string);
    expect(sentBody.slug).toBe('acme-spa');
    expect(sentBody.problem_type).toBe('fjsp');
    expect(sentBody.rules.unavailable_machines).toBeDefined();
  });

  it('unsupported scenario: closes after aborted_unsupported without calling backend', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeAnthropicReply({
        type: 'unsupported',
        rules: {},
        rationale: 'Richiesta finanziaria fuori scope.',
        confidence: 'high',
        warnings: ['out_of_scope'],
        unsupportedReason: 'Valutazione finanziaria non e un vincolo applicabile dal solver.',
      }),
    );

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        {
          ...baseBody,
          whatifText:
            '## 1. Interpretazione\nIl manager chiede valutazione ROI.\n## 4. Raccomandazione\nFuori scope.',
        },
        '10.0.0.2',
      ),
    );
    expect(res.status).toBe(200);

    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    expect(events).toEqual(['translating', 'translated', 'aborted_unsupported', 'done']);
    expect(events).not.toContain('solving');
    expect(events).not.toContain('solved');

    const aborted = chunks.find((c) => c.event === 'aborted_unsupported')!.data as {
      reason: string;
      warnings: string[];
    };
    expect(aborted.reason).toMatch(/finanziaria/i);
    expect(aborted.warnings).toContain('out_of_scope');

    // Backend NEVER called for unsupported scenarios.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('backend 500: emits error event with detail message', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeAnthropicReply({
        type: 'force_priority',
        rules: { priority_orders: ['COM-007'] },
        rationale: 'Priorita COM-007.',
        confidence: 'high',
        warnings: [],
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ detail: 'solver crashed: infeasible after priority bump' }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest(baseBody, '10.0.0.3'));
    expect(res.status).toBe(200); // SSE response still 200; error is inside the stream.

    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    expect(events).toContain('translating');
    expect(events).toContain('translated');
    expect(events).toContain('solving');
    expect(events).toContain('error');
    expect(events).not.toContain('solved');

    const err = chunks.find((c) => c.event === 'error')!.data as {
      code: string;
      message: string;
    };
    expect(err.code).toBe('apply_failed');
    expect(err.message).toMatch(/solver crashed|infeasible/);
  });

  it('client disconnect during solve: abort propagates and solve never resolves', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeAnthropicReply({
        type: 'block_machine',
        rules: {
          unavailable_machines: { 'M-3': [{ start_min: 840, end_min: 1080 }] },
        },
        rationale: 'Fermo M-3.',
        confidence: 'high',
        warnings: [],
      }),
    );

    // Backend fetch that hangs until aborted.
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          // apiFetch in src/lib/api.ts does NOT forward an AbortSignal to
          // fetch (it just uses the default options + headers), so the
          // abort here is the one fired by the route's 60s timeout +
          // client abort listener — which causes the route's
          // timeoutPromise to reject with new Error('aborted'). The
          // simplest way to model "fetch hangs" is to never resolve.
          if (signal) {
            signal.addEventListener('abort', () => reject(new Error('fetch_aborted')));
          }
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Build a request whose signal we can abort.
    const ac = new AbortController();
    const req = new Request('http://localhost:8080/api/apply-whatif', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': '10.0.0.4',
        'content-length': String(JSON.stringify(baseBody).length),
      },
      body: JSON.stringify(baseBody),
      signal: ac.signal,
    });

    const resPromise = invokeRoute(req);
    const res = await resPromise;
    expect(res.status).toBe(200);

    // Start reading the stream so the route progresses through
    // translating → translated → solving, then abort before solve
    // resolves (it never will — fetch hangs).
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    let sawSolving = false;
    const readUntilSolving = (async () => {
      while (!sawSolving) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) acc += decoder.decode(value, { stream: true });
        if (acc.includes('event: solving')) sawSolving = true;
      }
    })();
    await readUntilSolving;
    expect(sawSolving).toBe(true);

    // Now abort the client.
    ac.abort('test_disconnect');

    // Drain the remainder. The route should write an error event
    // (code=aborted) and close.
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) acc += decoder.decode(value, { stream: true });
    }
    acc += decoder.decode();

    const chunks = parseSse(acc);
    const events = chunks.map((c) => c.event);
    expect(events).toContain('solving');
    // Either an error or aborted terminal — never solved.
    const terminal = chunks.find((c) => c.event === 'error' || c.event === 'aborted');
    expect(terminal).toBeDefined();
    expect(events).not.toContain('solved');
  });

  it('rejects concurrent request from the same IP with 409 conflict', async () => {
    // First request: translator OK, but the backend fetch hangs so the
    // in-flight slot stays taken while we send a second request.
    anthropicCreate.mockResolvedValueOnce(
      fakeAnthropicReply({
        type: 'force_priority',
        rules: { priority_orders: ['COM-007'] },
        rationale: 'Priorita COM-007.',
        confidence: 'high',
        warnings: [],
      }),
    );

    let abortBackend!: () => void;
    const fetchMock = vi.fn().mockImplementationOnce(
      () =>
        new Promise<Response>((_resolve, reject) => {
          abortBackend = () => reject(new Error('test_cleanup'));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const ac = new AbortController();
    const req1 = new Request('http://localhost:8080/api/apply-whatif', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': '10.0.0.5',
        'content-length': String(JSON.stringify(baseBody).length),
      },
      body: JSON.stringify(baseBody),
      signal: ac.signal,
    });
    const res1 = await invokeRoute(req1);
    expect(res1.status).toBe(200);

    // Read enough chunks from res1 to know the start() callback has run
    // (the in-flight Map is populated synchronously before any await,
    // but reading at least one chunk gives the start() body time to
    // execute the translator call and reach the solving phase).
    const reader1 = res1.body!.getReader();
    const decoder = new TextDecoder();
    let acc1 = '';
    while (!acc1.includes('event: solving')) {
      const { value, done } = await reader1.read();
      if (done) break;
      if (value) acc1 += decoder.decode(value, { stream: true });
    }

    // Second concurrent request from same IP — must get 409 immediately.
    const res2 = await invokeRoute(makeRequest(baseBody, '10.0.0.5'));
    expect(res2.status).toBe(409);
    const body2 = await res2.json();
    expect(body2.error).toBe('conflict');

    // Clean up: release the hung backend fetch so res1's stream closes.
    abortBackend();
    try {
      while (true) {
        const r = await reader1.read();
        if (r.done) break;
      }
    } catch { /* expected */ }
  });

  it('rejects invalid body with 400', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest({ slug: '', whatifText: 'too short' }, '10.0.0.6'),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_body');
    expect(anthropicCreate).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('safety_gate full-plant block: translator coerces to unsupported, route skips solve', async () => {
    // Translator returns a "valid-looking" block_machine that would
    // freeze the entire plant. The deterministic post-validator (DA-08)
    // demotes it to unsupported with a safety_gate warning. The route
    // must surface it via aborted_unsupported and NOT call the backend.
    anthropicCreate.mockResolvedValueOnce(
      fakeAnthropicReply({
        type: 'block_machine',
        rules: {
          unavailable_machines: {
            'M-1': [{ start_min: 0, end_min: 480 }],
            'M-3': [{ start_min: 0, end_min: 480 }],
          },
        },
        rationale: 'Fermo totale.',
        confidence: 'high',
        warnings: [],
      }),
    );

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest(baseBody, '10.0.0.7'));
    expect(res.status).toBe(200);

    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    expect(events).toEqual(['translating', 'translated', 'aborted_unsupported', 'done']);

    const translated = chunks.find((c) => c.event === 'translated')!.data as {
      change: { type: string; warnings: string[]; unsupportedReason?: string };
    };
    expect(translated.change.type).toBe('unsupported');
    expect(translated.change.warnings.some((w) => /^safety_gate:full_plant_block/.test(w))).toBe(true);
    expect(translated.change.unsupportedReason).toBeDefined();

    // Backend MUST NOT be called when the translator emits unsupported.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('schema_mismatch: translator demotes to unsupported, route propagates without solve', async () => {
    // DA-10: the LLM emitted a malformed rules payload (string instead
    // of array). The translator's per-type validator catches this and
    // coerces to unsupported.
    anthropicCreate.mockResolvedValueOnce(
      fakeAnthropicReply({
        type: 'block_machine',
        rules: {
          // Intentionally wrong: should be an array of {start_min, end_min}.
          unavailable_machines: { 'M-3': 'BLOCKED_ALL_DAY' },
        },
        rationale: 'Fermo M-3.',
        confidence: 'high',
        warnings: [],
      }),
    );

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest(baseBody, '10.0.0.8'));
    expect(res.status).toBe(200);

    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    expect(events).toEqual(['translating', 'translated', 'aborted_unsupported', 'done']);

    const translated = chunks.find((c) => c.event === 'translated')!.data as {
      change: { type: string; warnings: string[] };
    };
    expect(translated.change.type).toBe('unsupported');
    expect(translated.change.warnings.some((w) => /^schema_mismatch:unavailable_machines/.test(w))).toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('missing_kpi: one-sided KPIs are not deltaed, emitted as warnings instead (DA-22)', async () => {
    // Baseline has makespan_min + on_time_rate; backend returns
    // makespan_min + n_in_ritardo (new metric, not in baseline) and
    // DROPS on_time_rate. The route must:
    //   - delta only makespan_min (present in both)
    //   - emit missing_kpi:on_time_rate (in baseline, missing in new)
    //   - emit missing_kpi:n_in_ritardo (new only)
    anthropicCreate.mockResolvedValueOnce(
      fakeAnthropicReply({
        type: 'force_priority',
        rules: { priority_orders: ['COM-007'] },
        rationale: 'Priorita.',
        confidence: 'high',
        warnings: [],
      }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL',
          method: 'cp-sat',
          // Non-empty so the §D empty-solution guard does not fire; this test
          // is about KPI delta semantics, not the guard.
          solution: { 'COM-007': { fasi: [{ macchina: 'M-3', start_min: 0, end_min: 60 }] } },
          kpis: { makespan_min: 3000, n_in_ritardo: 0 },
          objective_value: 3000,
          warnings: [],
          cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        {
          ...baseBody,
          // Keep only 2 baseline KPIs to make the math obvious.
          kpis: { makespan_min: 2880, on_time_rate: 0.85 },
        },
        '10.0.0.9',
      ),
    );
    const chunks = parseSse(await streamToString(res.body!));
    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      deltaKpis: Record<string, number>;
      warnings: string[];
    };

    // makespan_min is the ONLY key with a delta (3000 - 2880 = 120).
    expect(Object.keys(solved.deltaKpis)).toEqual(['makespan_min']);
    expect(solved.deltaKpis.makespan_min).toBe(120);
    // on_time_rate is in baseline but not in new → missing_kpi warning.
    expect(solved.warnings).toContain('missing_kpi:on_time_rate');
    // n_in_ritardo is in new but not in baseline → missing_kpi warning.
    expect(solved.warnings).toContain('missing_kpi:n_in_ritardo');
    // DeltaKpis must NOT contain the one-sided keys (avoids the
    // misleading "metric went to/from 0" semantic).
    expect(solved.deltaKpis).not.toHaveProperty('on_time_rate');
    expect(solved.deltaKpis).not.toHaveProperty('n_in_ritardo');
  });
});
