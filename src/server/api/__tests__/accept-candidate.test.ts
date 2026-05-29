import { describe, it, expect } from 'vitest';

/**
 * Wave 16.4 A7 — BFF accept-candidate route.
 *
 * Validates body shape, returns a solve-template shaped envelope so the
 * client can pipe it straight into setBackendResult, and rate-limits.
 */

function makeRequest(body: unknown, ip = '127.0.0.1', headers: Record<string, string> = {}): Request {
  const bodyStr = JSON.stringify(body);
  return new Request('http://localhost:8080/api/accept-candidate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': ip,
      'content-length': String(bodyStr.length),
      ...headers,
    },
    body: bodyStr,
  });
}

async function invokeRoute(request: Request): Promise<Response> {
  const mod = await import('../../../routes/api/accept-candidate');
  const handler =
    (mod.Route as unknown as {
      options: { server: { handlers: { POST: (ctx: { request: Request }) => Promise<Response> } } };
    }).options.server.handlers.POST;
  return handler({ request });
}

describe('POST /api/accept-candidate', () => {
  it('returns solve-template shaped envelope on valid body', async () => {
    const res = await invokeRoute(
      makeRequest(
        {
          slug: 'acme-spa',
          candidateSolution: { status: 'OPTIMAL', schedule: [] },
          candidateKpis: { makespan_min: 1400, on_time_rate: 0.95 },
          warnings: ['lock_relaxed_to_soft'],
          intentId: 'machine_unavailability',
          strategy: 'B',
        },
        'ip-accept-candidate-happy',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.slug).toBe('acme-spa');
    expect(body.result).toBeDefined();
    expect(body.result.method).toBe('deterministic-template');
    expect(body.result.solution).toEqual({ status: 'OPTIMAL', schedule: [] });
    expect(body.result.kpis).toEqual({ makespan_min: 1400, on_time_rate: 0.95 });
    expect(body.result.warnings).toEqual(['lock_relaxed_to_soft']);
    expect(typeof body.accepted_at).toBe('string');
  });

  // Wave 16.5 A2 regression — the FJSP solver emits a nested carico_macchine
  // dict alongside the flat KPIs (daino fjsp.py). The original
  // z.record(string, number) rejected it with HTTP 400; the union widening
  // must accept it AND forward it verbatim into the echoed result.
  it('accepts nested carico_macchine KPI dict and preserves it (200, not 400)', async () => {
    const res = await invokeRoute(
      makeRequest(
        {
          slug: 'acme-spa',
          candidateSolution: { 'COM-001': { fasi: [] } },
          candidateKpis: {
            makespan: 703,
            costo_totale_operatori: 50,
            costo_totale_setup: 10,
            carico_macchine: { M01: 703, M02: 540 },
          },
        },
        'ip-accept-candidate-nested-kpi',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.kpis.carico_macchine).toEqual({ M01: 703, M02: 540 });
    expect(body.result.kpis.makespan).toBe(703);
  });

  it('rejects invalid body with 400', async () => {
    const res = await invokeRoute(
      makeRequest({ slug: 'acme-spa' }, 'ip-accept-candidate-invalid'),
    );
    expect(res.status).toBe(400);
  });

  it('rejects oversized payload with 413', async () => {
    const res = await invokeRoute(
      new Request('http://localhost:8080/api/accept-candidate', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-real-ip': 'ip-accept-candidate-toobig',
          'content-length': String(2_000_000),
        },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(413);
  });

  it('accepts strategy=undefined (Wave 4.1 fallback)', async () => {
    const res = await invokeRoute(
      makeRequest(
        {
          slug: 'pmi-test',
          candidateSolution: {},
          candidateKpis: { makespan_min: 100 },
        },
        'ip-accept-candidate-no-strategy',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.strategy).toBeNull();
    expect(body.intent_id).toBeNull();
  });
});
