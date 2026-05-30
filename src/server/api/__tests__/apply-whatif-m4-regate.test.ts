import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 16.6 M-4 — re-gate the manager-confirmed gray-zone payload.
 *
 * The gray pause emits a confirmedPayload that was gated (interpreter) or
 * translator-produced. The confirm re-entry (userConfirmedGrayZone=true)
 * receives that payload back FROM the client. A stale/tampered client could
 * swap an entity id (M02 → M99) to push an off-set entity into the solver,
 * bypassing the closed-set anti-hallucination guarantee on the second pass.
 *
 * regateConfirmedRules re-resolves every machine/order id against the live
 * closed set (built from originalSolution):
 *   - off-set id            → aborted_unsupported(unresolved_entity_target), NO solve
 *   - valid id              → solve proceeds
 *   - alias ("m02")         → canonicalised to the real id before solving
 *
 * Harness mirrors apply-whatif-wave-16.6.test.ts: mock the SDK + fetch, drive
 * the file route's POST handler, parse the SSE body.
 */

const anthropicCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = { create: anthropicCreate };
    constructor(_: unknown) { void _; }
  }
  return { default: FakeAnthropic };
});

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
      try { data = JSON.parse(dataLines.join('\n')); } catch { data = dataLines.join('\n'); }
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

// Non-empty baseline so the §D empty-solution guard is not the thing aborting.
const nestedSolution = {
  'COM-001': {
    fasi: [
      { operazione: 'OP-1', macchina: 'M01', operatore: 'OP-A', start_min: 0, end_min: 60 },
      { operazione: 'OP-2', macchina: 'M02', operatore: 'OP-A', start_min: 60, end_min: 120 },
    ],
  },
  'COM-007': {
    fasi: [{ operazione: 'OP-1', macchina: 'M03', operatore: 'OP-B', start_min: 0, end_min: 80 }],
  },
};

const baseBody = {
  slug: 'm4-co',
  originalSolution: nestedSolution,
  kpis: { makespan_min: 2880, on_time_rate: 0.85 },
  whatifText: '## 1. Interpretazione\n…\n## 4. Raccomandazione\nApplicabile.',
  consultationMd: '## Tipo problema: fjsp\n',
};

const NON_EMPTY_SOLVE = {
  status: 'OPTIMAL',
  method: 'cp-sat',
  solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } },
  kpis: { makespan_min: 2700 },
  objective_value: 2700,
  warnings: [],
  cost_usd: 0,
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
  const handler = (mod.Route as unknown as {
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

describe('Wave 16.6 M-4 — gray-confirm re-gate against the closed set', () => {
  it('off-set machine in confirmedPayload (M99) → aborted_unsupported, NO solve', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: { unavailable_machines: { M99: [{ start_min: 840, end_min: 1080 }] } },
    }, '10.0.4.1'));
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    expect(events).toContain('aborted_unsupported');
    expect(events).not.toContain('solved');
    expect(fetchMock).not.toHaveBeenCalled(); // never reached the solver
    const aborted = chunks.find((c) => c.event === 'aborted_unsupported')!.data as {
      reason: string; warnings: string[];
    };
    expect(aborted.reason).toBe('unresolved_entity_target');
    expect(aborted.warnings).toContain('gray_zone_offset_target:M99');
    // The interpreter is NOT consulted on the confirm fast-path.
    expect(anthropicCreate).not.toHaveBeenCalled();
  });

  it('off-set order in confirmedPayload (COM-999) → aborted_unsupported, NO solve', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: { priority_orders: ['COM-999'] },
    }, '10.0.4.2'));
    const events = parseSse(await streamToString(res.body!)).map((c) => c.event);

    expect(events).toContain('aborted_unsupported');
    expect(events).not.toContain('solved');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('valid machine in confirmedPayload (M02) → solve proceeds with that rule', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(NON_EMPTY_SOLVE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: { unavailable_machines: { M02: [{ start_min: 840, end_min: 1080 }] } },
    }, '10.0.4.3'));
    const events = parseSse(await streamToString(res.body!)).map((c) => c.event);

    expect(events).toContain('solved');
    expect(events).not.toContain('aborted_unsupported');
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.rules.unavailable_machines.M02).toEqual([{ start_min: 840, end_min: 1080 }]);
  });

  it('alias machine in confirmedPayload ("m02") → canonicalised to M02 before the solve', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(NON_EMPTY_SOLVE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: { unavailable_machines: { m02: [{ start_min: 840, end_min: 1080 }] } },
    }, '10.0.4.4'));
    const events = parseSse(await streamToString(res.body!)).map((c) => c.event);

    expect(events).toContain('solved');
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // The lowercase alias was canonicalised to the real closed-set id.
    expect(sentBody.rules.unavailable_machines.M02).toEqual([{ start_min: 840, end_min: 1080 }]);
    expect(sentBody.rules.unavailable_machines.m02).toBeUndefined();
  });
});
