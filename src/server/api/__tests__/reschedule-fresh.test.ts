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

  // ── Wave 16.5-RE2 — day_anchor cutoff (the real "freeze the past" fix) ──

  // day_anchor=N → cutoff = (N-1) × day_length_min, using the COMPRESSED model
  // day length from time_config (NOT calendar 1440 — that is TD-031). With
  // day_length=960, "siamo al giorno 2" → cutoff 960 → freeze all of day 1.
  it('day_anchor=2 freezes day 1 using (N-1)*day_length_min (960, NOT 1440)', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.95,
      payload: {
        day_anchor: 2,
        unavailable_machines: { 'M-1': [{ start_min: 960, end_min: 1920, date: '2026-06-02' }] },
      },
      rationale: 'giorno 2, m1 rotta',
      pattern_id: 'machine_unavailability_v3',
      confirmation_message: null,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'deterministic-template', solution: {},
          kpis: {}, objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const baselineSolution = {
      time_config: { start_date: '2026-06-01', company_start_hour: 6, day_length_min: 960 },
      solution: {
        'COM-001': {
          fasi: [
            // day 1: ends at 900 <= cutoff(960) → frozen
            { operazione: 'taglio', macchina: 'M-1', operatore: 'W-1', start_min: 0, end_min: 900 },
            // straddles into day 2: starts 900 < 960 < 1500 → NOT frozen
            { operazione: 'finitura', macchina: 'M-2', operatore: 'W-2', start_min: 900, end_min: 1500 },
          ],
        },
      },
    };

    const res = await invokeRoute(
      makeRequest({ slug: 'acme', message: 'siamo al giorno 2, m1 rotta', baselineSolution }, 'ip-fresh-anchor2'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // The crux: 1×960, NOT 1×1440.
    expect(body.cutoff_min).toBe(960);
    expect(body.cutoff_source).toBe('day_anchor');
    expect(body.day_anchor).toBe(2);
    expect(body.frozen_count).toBe(1);

    const solveBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(solveBody.cutoff_min).toBe(960);
    expect(solveBody.force_cold_start).toBe(true);
    expect(solveBody.frozen_phases).toHaveLength(1);
    // Identity guard (devil-advocate): the frozen phase pins the EXACT baseline
    // coordinates, so day-1 work cannot be reshuffled by the re-solve.
    expect(solveBody.frozen_phases[0]).toMatchObject({
      job_id: 'COM-001',
      machine_id: 'M-1',
      start_min: 0,
      end_min: 900,
      seq: 1,
    });
  });

  // Off-by-one: day_anchor=1 == we are at the first day → nothing completed →
  // cutoff 0 → no frozen phases (buildFrozenPhases returns [] for cutoff<=0).
  it('day_anchor=1 yields cutoff 0 and freezes nothing', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.95,
      payload: { day_anchor: 1, unavailable_machines: { 'M-1': [{ start_min: 0, end_min: 480, date: '2026-06-01' }] } },
      rationale: 'giorno 1',
      pattern_id: 'machine_unavailability_v3',
      confirmation_message: null,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'deterministic-template', solution: {},
          kpis: {}, objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const baselineSolution = {
      time_config: { day_length_min: 960 },
      solution: { 'COM-001': { fasi: [{ macchina: 'M-1', start_min: 0, end_min: 480 }] } },
    };
    const res = await invokeRoute(
      makeRequest({ slug: 'acme', message: 'siamo al giorno 1, m1 rotta', baselineSolution }, 'ip-fresh-anchor1'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cutoff_min).toBe(0);
    expect(body.frozen_count).toBe(0);
    // cutoff 0 → no frozen_phases forwarded.
    const solveBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect('frozen_phases' in solveBody).toBe(false);
  });

  // day_anchor=3 with day_length=960 → cutoff 1920 (days 1+2 frozen).
  it('day_anchor=3 yields cutoff = 2*day_length_min', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.95,
      payload: { day_anchor: 3, unavailable_machines: { 'M-1': [{ start_min: 1920, end_min: 2880, date: '2026-06-03' }] } },
      rationale: 'giorno 3',
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
        { slug: 'acme', message: 'siamo al giorno 3, m1 rotta', baselineSolution: { time_config: { day_length_min: 960 }, solution: {} } },
        'ip-fresh-anchor3',
      ),
    );
    const body = await res.json();
    expect(body.cutoff_min).toBe(1920);
  });

  // Ask-flow gate (devil-advocate Option 1): needs_day_clarification → the
  // route returns code 'needs_day' and NEVER calls resolveTemplate. This is the
  // structural guarantee that an un-anchored utterance cannot trigger a blind
  // solve that reshuffles the past.
  it('needs_day_clarification short-circuits BEFORE any solve', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.9,
      payload: {
        needs_day_clarification: true,
        // A fallback day-0 window may be present — must be ignored, not solved.
        unavailable_machines: { 'M-1': [{ start_min: 0, end_min: 960, date: '2026-06-01' }] },
      },
      rationale: 'manca il giorno',
      pattern_id: 'machine_unavailability_v3',
      confirmation_message: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { slug: 'acme', message: 'm1 rotta oggi', baselineSolution: { time_config: { day_length_min: 960 }, solution: {} } },
        'ip-fresh-needday',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('needs_day');
    // The structural invariant: NO solve was attempted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Defensive: day_anchor present but baseline lacks time_config.day_length_min
  // → cannot compute a correct cutoff → skip the freeze (no bogus 1440), still
  // solve. Better an un-frozen replan than a wrong-unit freeze.
  it('day_anchor without day_length_min skips the freeze (no bogus cutoff)', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.95,
      payload: { day_anchor: 2, unavailable_machines: { 'M-1': [{ start_min: 960, end_min: 1920 }] } },
      rationale: 'giorno 2 ma niente day_length',
      pattern_id: 'machine_unavailability_v3',
      confirmation_message: null,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'deterministic-template', solution: {},
          kpis: {}, objective_value: 0, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        // No time_config → day_length_min unknown.
        { slug: 'acme', message: 'siamo al giorno 2, m1 rotta', baselineSolution: { solution: { 'COM-001': { fasi: [{ macchina: 'M-1', start_min: 0, end_min: 900 }] } } } },
        'ip-fresh-nodl',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cutoff_min).toBeNull();
    expect(body.cutoff_source).toBe('none');
    expect(body.frozen_count).toBe(0);
    // Still solved (just without a frozen window).
    expect(body.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
