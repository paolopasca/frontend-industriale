import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 16.4 C4 — BFF reschedule-fresh route tests.
 *
 * Strategy:
 *   - Mock extract-constraint backend module so no live network is touched.
 *   - Mock resolveTemplate via fetch on /api/public/solve-template.
 *   - Drive the route by importing the file route POST handler and
 *     calling it with a synthetic Request.
 */

vi.mock('@/server/llm/extract-constraint-client', () => ({
  extractConstraintFromBackend: vi.fn(),
}));

import { extractConstraintFromBackend } from '@/server/llm/extract-constraint-client';

function makeRequest(body: unknown, ip = '127.0.0.1'): Request {
  const bodyStr = JSON.stringify(body);
  return new Request('http://localhost:8080/api/reschedule-fresh', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': ip,
      'content-length': String(bodyStr.length),
    },
    body: bodyStr,
  });
}

async function invokeRoute(request: Request): Promise<Response> {
  const mod = await import('../../../routes/api/reschedule-fresh');
  const handler =
    (mod.Route as unknown as {
      options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
    }).options.server.handlers.POST;
  return handler({ request });
}

describe('POST /api/reschedule-fresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns solve-template shaped envelope on extract HIT + solve OK', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.9,
      payload: { unavailable_machines: { 'M-1': [{ start: 0, end: 240 }] } },
      rationale: 'macchina rotta -> blocco finestra',
      pattern_id: 'machine_unavailability_v1',
      confirmation_message: null,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL',
          method: 'deterministic-template',
          solution: { fasi: [] },
          kpis: { makespan_min: 1500 },
          objective_value: 1500,
          warnings: [],
          cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ));

    const res = await invokeRoute(
      makeRequest({ slug: 'acme', message: 'M-1 e rotta' }, 'ip-fresh-happy'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.code).toBe('solved_fresh');
    expect(body.extracted_pattern_id).toBe('machine_unavailability_v1');
    expect(body.result.status).toBe('OPTIMAL');
    expect(body.result.method).toBe('deterministic-template');
    expect(body.result.kpis).toEqual({ makespan_min: 1500 });
  });

  it('returns extract_miss when the extractor cannot classify', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'miss',
      confidence: 0.2,
      payload: null,
      rationale: 'frase troppo vaga, manca soggetto',
      pattern_id: null,
      confirmation_message: null,
    });

    const res = await invokeRoute(
      makeRequest({ slug: 'acme', message: 'fai qualcosa' }, 'ip-fresh-miss'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('extract_miss');
    expect(body.rationale).toContain('vaga');
  });

  it('returns extract_unavailable when extract-constraint backend is down', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce(null);
    const res = await invokeRoute(
      makeRequest({ slug: 'acme', message: 'macchina rotta' }, 'ip-fresh-unavailable'),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('extract_unavailable');
  });

  it('rejects invalid body with 400', async () => {
    const res = await invokeRoute(
      makeRequest({ slug: 'acme' }, 'ip-fresh-invalid'),
    );
    expect(res.status).toBe(400);
  });
});
