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

  // Wave 16.5 B3 — the extractor must receive a real SolutionContext built
  // from the baseline so entity aliases ("m1" → "M-1") resolve. The old
  // minimalSolutionContext handed over a {slug, baseline} wrapper with empty
  // machines, so every entity-referencing utterance MISSed.
  it('passes a SolutionContext with machine_aliases derived from the baseline', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.9,
      payload: { unavailable_machines: { 'M-1': [{ start: 0, end: 240 }] } },
      rationale: 'ok',
      pattern_id: 'machine_unavailability_v1',
      confirmation_message: null,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'deterministic-template', solution: {},
          kpis: {}, objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ));

    // Raw backend response shape: { status, solution: { COM-001: { fasi } }, kpis }.
    const baselineSolution = {
      status: 'OPTIMAL',
      solution: {
        'COM-001': {
          fasi: [
            { operazione: 'taglio', macchina: 'M-1', operatore: 'W-1', start_min: 0, end_min: 120 },
            { operazione: 'finitura', macchina: 'M-2', operatore: 'W-2', start_min: 120, end_min: 300 },
          ],
        },
      },
      kpis: {},
    };

    const res = await invokeRoute(
      makeRequest({ slug: 'acme', message: 'm1 e rotta', baselineSolution }, 'ip-fresh-ctx'),
    );
    expect(res.status).toBe(200);

    expect(extractConstraintFromBackend).toHaveBeenCalledTimes(1);
    const [instruction, ctx] = vi.mocked(extractConstraintFromBackend).mock.calls[0];
    expect(instruction).toBe('m1 e rotta');
    // Canonical machine strings recovered from solution[commessa].fasi.
    expect(ctx.machines).toEqual(expect.arrayContaining(['M-1', 'M-2']));
    expect(ctx.orders).toEqual(['COM-001']);
    // NL + case-folding aliases so "m1"/"macchina 1" resolve to "M-1".
    expect(ctx.machine_aliases['m-1']).toBe('M-1');
    expect(ctx.machine_aliases['macchina 1']).toBe('M-1');
  });

  // Wave 16.5 B3 — when currentTimeMin is supplied, phases finishing at or
  // before the cutoff (currentTime + cushion) must be frozen and forwarded
  // to solve-template, and the solve must run cold (no stale warm-start).
  it('freezes past phases and forces a cold solve when currentTimeMin is set', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.9,
      payload: { unavailable_machines: { 'M-2': [{ start: 1440, end: 1680 }] } },
      rationale: 'ok',
      pattern_id: 'machine_unavailability_v1',
      confirmation_message: null,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'FEASIBLE', method: 'deterministic-template', solution: {},
          kpis: {}, objective_value: 100, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const baselineSolution = {
      solution: {
        'COM-001': {
          fasi: [
            // ends at 120 <= cutoff(150) → frozen
            { operazione: 'taglio', macchina: 'M-1', operatore: 'W-1', start_min: 0, end_min: 120 },
            // ends at 400 > cutoff(150) → left to solver
            { operazione: 'finitura', macchina: 'M-2', operatore: 'W-2', start_min: 120, end_min: 400 },
          ],
        },
      },
    };

    const res = await invokeRoute(
      makeRequest(
        { slug: 'acme', message: 'M-2 ferma', baselineSolution, currentTimeMin: 120, cushionMin: 30 },
        'ip-fresh-frozen',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cutoff_min).toBe(150);
    expect(body.frozen_count).toBe(1);

    // Inspect the body sent to /api/public/solve-template.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const solveBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(solveBody.cutoff_min).toBe(150);
    expect(solveBody.force_cold_start).toBe(true);
    expect(Array.isArray(solveBody.frozen_phases)).toBe(true);
    expect(solveBody.frozen_phases).toHaveLength(1);
    expect(solveBody.frozen_phases[0].job_id).toBe('COM-001');
    expect(solveBody.frozen_phases[0].machine_id).toBe('M-1');
    expect(solveBody.frozen_phases[0].seq).toBe(1);
  });

  // Wave 16.5 B3 — a future scenario boundary ("da domani") pushes the cutoff
  // to the start of day 2, overriding the smaller currentTime+cushion window
  // so the compound "oggi rotta, da domani torna" intent freezes only today.
  it('uses the detected future scenario start when larger than currentTime+cushion', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.9,
      payload: { unavailable_machines: { 'M-1': [{ start: 0, end: 1440 }] } },
      rationale: 'ok',
      pattern_id: 'machine_unavailability_v3',
      confirmation_message: null,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'deterministic-template', solution: {},
          kpis: {}, objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ));

    const res = await invokeRoute(
      makeRequest(
        {
          slug: 'acme',
          message: 'la macchina m1 oggi e in riparazione, da domani torna a funzionare',
          baselineSolution: { solution: {} },
          currentTimeMin: 60,
          cushionMin: 30,
        },
        'ip-fresh-tomorrow',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // "domani" → 1*1440, max(1440, 60+30) = 1440.
    expect(body.cutoff_min).toBe(1440);
  });
});
