import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-W8-01 — not_implemented short-circuit (w8-infeasible-recovery).
 *
 * Catalog flag introduced after devils' 2026-05-22 finding: the Haiku
 * parser recognises `capacity_addition` and `shift_window`, but the
 * backend solver (f_apply_rules.py) only logs a passthrough warning for
 * those rule keys — the CP-SAT model has no consumer that actually
 * changes capacity or shifts. Routing them through Strategy B would
 * pretend a constraint took effect when in fact it was silently ignored,
 * which is exactly the "transport-only" hypocrisy this fix removes.
 *
 * Expected end-to-end behaviour through /api/apply-whatif:
 *   parsing_intent → intent_parsed → routed (strategy=unsupported) →
 *   aborted_unsupported → done.
 *
 * The route MUST NOT call the backend at all — no wasted solve, no
 * misleading "rule applied" UI state. The `aborted_unsupported.reason`
 * surface is the user-facing Italian message the UI renders as a toast.
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
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

const nestedSolution = {
  'COM-001': {
    fasi: [
      { operazione: 'OP-1', macchina: 'M01', operatore: 'OP-A', start_min: 0, end_min: 60 },
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
  const mod = await import('../apply-whatif');
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

describe('F-W8-01 — not_implemented intents short-circuit to aborted_unsupported', () => {
  it('capacity_addition: routed=unsupported with not_implemented warning, no backend fetch', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'capacity_addition',
        entities: { operators: 1, shift: 'serale' },
        confidence: 'high',
      }),
    );

    // Any backend call here would be a regression. The fetch mock fails
    // the test if it's invoked.
    const fetchMock = vi.fn().mockImplementation(() => {
      throw new Error('backend MUST NOT be called for not_implemented intents');
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'Aggiungi un operatore in turno serale' },
        '10.0.81.1',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // The routed event must report the unsupported strategy AND carry
    // the not_implemented marker on the warnings array.
    expect(events).toContain('routed');
    const routed = chunks.find((c) => c.event === 'routed')!.data as {
      strategy: string;
      intent_id: string;
      warnings: string[];
    };
    expect(routed.strategy).toBe('unsupported');
    expect(routed.intent_id).toBe('capacity_addition');
    expect(routed.warnings).toContain('not_implemented:capacity_addition');

    // The route exits via aborted_unsupported → done, never reaching
    // solving / solved. The toast text on the UI side comes from the
    // `reason` field on aborted_unsupported.
    expect(events).toContain('aborted_unsupported');
    expect(events).toContain('done');
    expect(events).not.toContain('solving');
    expect(events).not.toContain('solved');
    expect(events).not.toContain('translating');

    const aborted = chunks.find((c) => c.event === 'aborted_unsupported')!.data as {
      reason: string;
      warnings: string[];
    };
    expect(aborted.reason).toMatch(/non ancora supportato/i);
    expect(aborted.warnings).toContain('not_implemented:capacity_addition');

    // Backend never contacted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shift_window: routed=unsupported with not_implemented warning, no backend fetch', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'shift_window',
        entities: { shift_id: 'turno_mattina', start_min: 360, end_min: 720 },
        confidence: 'high',
      }),
    );

    const fetchMock = vi.fn().mockImplementation(() => {
      throw new Error('backend MUST NOT be called for not_implemented intents');
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'Anticipa il turno mattina di un ora' },
        '10.0.81.2',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    expect(events).toContain('routed');
    const routed = chunks.find((c) => c.event === 'routed')!.data as {
      strategy: string;
      intent_id: string;
      warnings: string[];
    };
    expect(routed.strategy).toBe('unsupported');
    expect(routed.intent_id).toBe('shift_window');
    expect(routed.warnings).toContain('not_implemented:shift_window');

    expect(events).toContain('aborted_unsupported');
    expect(events).toContain('done');
    expect(events).not.toContain('solving');
    expect(events).not.toContain('solved');
    expect(events).not.toContain('translating');

    const aborted = chunks.find((c) => c.event === 'aborted_unsupported')!.data as {
      reason: string;
      warnings: string[];
    };
    expect(aborted.reason).toMatch(/non ancora supportato/i);
    expect(aborted.warnings).toContain('not_implemented:shift_window');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deadline_change still routes normally (regression guard: only the flagged intents short-circuit)', async () => {
    // Sanity check: an intent without `not_implemented` keeps working.
    // If this fails, the short-circuit has accidentally swallowed a
    // supported intent.
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'deadline_change',
        entities: { order_id: 'COM-001', new_deadline_min: 1440 },
        confidence: 'high',
      }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'OPTIMAL', method: 'cp-sat',
        solution: {}, kpis: {}, objective_value: 0, warnings: [], cost_usd: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'Sposta COM-001 a domani entro le 24' },
        '10.0.81.3',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // deadline_change is still wired end-to-end.
    expect(events).toContain('solving');
    expect(events).toContain('solved');
    expect(events).not.toContain('aborted_unsupported');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
