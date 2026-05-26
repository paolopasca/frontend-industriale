import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 9 T1 (w9-backend-rules-consumer 2026-05-23) — capacity_addition
 * and shift_window are NOW wired end-to-end. Backend has real
 * `extra_capacity_added` + `shift_window_modified` consumers in
 * f_apply_rules.py, with explicit skip reasons surfaced on
 * `wave7.apply_rules[]` when the dataset cannot accept the rule.
 *
 * The catalog flag `not_implemented: true` is removed for both intents.
 * The strategy-router now routes them to Strategy B (rule_addition).
 *
 * Expected end-to-end behaviour through /api/apply-whatif:
 *   parsing_intent → intent_parsed → routed (strategy=B) → solving →
 *   solved → done.
 *
 * This file is the regression guard against re-introducing the
 * short-circuit: if either intent stops routing to Strategy B, the
 * backend wiring is silently broken again.
 *
 * Historical context: the original Wave 8 short-circuit was introduced
 * after devils 2026-05-22 found the backend silently dropped both
 * payloads via `extra_capacity_data_layer_passthrough` /
 * `shift_changes_data_layer_passthrough`. Wave 9 fixed the root cause
 * (real consumers) instead of papering over it with `unsupported`.
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

describe('Wave 9 T1 — capacity_addition + shift_window route to Strategy B end-to-end', () => {
  it('capacity_addition: routed=B, backend receives rules.extra_capacity, solved fires', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'capacity_addition',
        entities: { operators: 1, shift: 'serale' },
        confidence: 'high',
      }),
    );

    // Wave 9: backend now has a real consumer, so it MUST be called.
    // The mock returns an OPTIMAL response with the wave7 envelope
    // carrying `extra_capacity_added` on apply_rules — the audit
    // signal the UI uses to show "vincolo applicato".
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'OPTIMAL',
        method: 'cp-sat',
        solution: { 'COM-001': { fasi: [] } },
        kpis: { makespan_min: 2900 },
        objective_value: 2900,
        warnings: [],
        cost_usd: 0,
        wave7: {
          cutoff_min: null,
          locked_count: 0,
          frozen_phases: [],
          apply_rules: [
            {
              type: 'extra_capacity_added',
              shift_id: 'serale',
              operator_id: 'OP-extra-1',
              machines: ['M01'],
            },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
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

    expect(events).toContain('routed');
    const routed = chunks.find((c) => c.event === 'routed')!.data as {
      strategy: string;
      intent_id: string;
      warnings: string[];
    };
    expect(routed.strategy).toBe('B');
    expect(routed.intent_id).toBe('capacity_addition');
    // No more not_implemented marker — Wave 9 removed it.
    expect(routed.warnings).not.toContain('not_implemented:capacity_addition');

    // Full happy path: solving → solved → done. No aborted_unsupported.
    expect(events).toContain('solving');
    expect(events).toContain('solved');
    expect(events).toContain('done');
    expect(events).not.toContain('aborted_unsupported');

    // Backend received rules.extra_capacity per the Wave 9 wire schema.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.rules).toBeDefined();
    expect(sentBody.rules.extra_capacity).toBeDefined();
  });

  it('shift_window: routed=B, backend receives rules.shift_changes, solved fires', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'shift_window',
        entities: { shift_id: 'turno_mattina', start_min: 360, end_min: 720 },
        confidence: 'high',
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'OPTIMAL',
        method: 'cp-sat',
        solution: { 'COM-001': { fasi: [] } },
        kpis: { makespan_min: 2900 },
        objective_value: 2900,
        warnings: [],
        cost_usd: 0,
        wave7: {
          cutoff_min: null,
          locked_count: 0,
          frozen_phases: [],
          apply_rules: [
            {
              type: 'shift_window_modified',
              shift_id: 'turno_mattina',
              old_start_min: 480,
              old_end_min: 720,
              new_start_min: 360,
              new_end_min: 720,
            },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
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
    expect(routed.strategy).toBe('B');
    expect(routed.intent_id).toBe('shift_window');
    expect(routed.warnings).not.toContain('not_implemented:shift_window');

    expect(events).toContain('solving');
    expect(events).toContain('solved');
    expect(events).toContain('done');
    expect(events).not.toContain('aborted_unsupported');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.rules).toBeDefined();
    expect(sentBody.rules.shift_changes).toBeDefined();
  });

  it('deadline_change still routes normally (regression guard: supported intents keep working)', async () => {
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

    expect(events).toContain('solving');
    expect(events).toContain('solved');
    expect(events).not.toContain('aborted_unsupported');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
