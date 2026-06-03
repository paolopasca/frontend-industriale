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

// Wave 16.6 §A — on extractor MISS/GRAY the route now falls back to the Haiku
// instruction-interpreter (interpretInstruction), which calls
// getAnthropicClient() → new Anthropic(...). Mock the SDK (same FakeAnthropic
// pattern as the apply-whatif suite) so that fallback doesn't throw
// "ANTHROPIC_API_KEY not set" or hit the network. `anthropicCreate` returns a
// forced `tool_use` block (name 'emit_constraint') with a FLAT entity input.
const anthropicCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = { create: anthropicCreate };
    constructor(_: unknown) { void _; }
  }
  return { default: FakeAnthropic };
});

function fakeInterpreterReply(input: object) {
  return {
    content: [{ type: 'tool_use', name: 'emit_constraint', input }],
    usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

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
    // Required by getAnthropicClient() for the interpreter fallback on MISS/GRAY.
    process.env.ANTHROPIC_API_KEY = 'test-key';
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ANTHROPIC_API_KEY;
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

  it('merges cumulative priorRules with the freshly-extracted rule before solving (Wave 17 H1)', async () => {
    // The manager already accepted "M-2 ferma 0-480" + priority COM-007 in
    // earlier What-If turns (the ledger). Now they Ripianifica with "M-1 rotta".
    // The fresh solve MUST honour BOTH the new disruption AND the accumulated
    // prior constraints — otherwise Ripianifica silently drops every previously
    // accepted rule (the cumulative-constraint failure this fixes).
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.9,
      payload: { unavailable_machines: { 'M-1': [{ start_min: 0, end_min: 240 }] } },
      rationale: 'macchina rotta -> blocco finestra',
      pattern_id: 'machine_unavailability_v1',
      confirmation_message: null,
    });
    const fetchMock = vi.fn().mockResolvedValueOnce(
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
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        {
          slug: 'acme',
          message: 'M-1 e rotta',
          priorRules: {
            unavailable_machines: { 'M-2': [{ start_min: 0, end_min: 480 }] },
            priority_orders: ['COM-007'],
          },
        },
        'ip-fresh-merge',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // The solve-template call must carry the MERGED rules.
    const solveCall = fetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/api/public/solve-template'),
    );
    expect(solveCall, 'expected a POST to /api/public/solve-template').toBeTruthy();
    const sentRules = JSON.parse((solveCall![1] as RequestInit).body as string).rules;
    // Fresh disruption present…
    expect(sentRules.unavailable_machines['M-1']).toEqual([{ start_min: 0, end_min: 240 }]);
    // …AND the accumulated prior constraints survived.
    expect(sentRules.unavailable_machines['M-2']).toEqual([{ start_min: 0, end_min: 480 }]);
    expect(sentRules.priority_orders).toEqual(['COM-007']);

    // The echoed applied_rules carries ONLY the NEW rule (pre-merge): the
    // client ledger already holds the priors, so the solver gets the merged set
    // but the ledger only needs the delta (mirrors apply-whatif's contract).
    // Echoing the merged set here would double-append M-2 on the next turn.
    expect(body.applied_rules.unavailable_machines['M-1']).toBeTruthy();
    expect(body.applied_rules.unavailable_machines['M-2']).toBeUndefined();
    expect(body.applied_rules.priority_orders).toBeUndefined();
  });

  it('surfaces skipped_rules from the solver wave7 audit (Wave 17 M2 — fresh path)', async () => {
    // Fresh is the PRODUCTION reschedule path. A rule the solver skips
    // (wave7.apply_rules) must reach the client as a per-rule reason rollup,
    // never be dropped (anti-silent-no-op).
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.9,
      payload: { unavailable_machines: { 'M-1': [{ start_min: 0, end_min: 240 }] } },
      rationale: 'macchina rotta',
      pattern_id: 'machine_unavailability_v1',
      confirmation_message: null,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL',
          method: 'deterministic-template',
          solution: { 'COM-001': { fasi: [] } },
          kpis: { makespan_min: 1500 },
          objective_value: 1500,
          warnings: [],
          cost_usd: 0,
          wave7: {
            locked_count: 0,
            apply_rules: [
              { type: 'unavailable_machine_block', machine_id: 'M-1', count: 1 },
              { type: 'operator_unavailable_skipped', operator_id: 'OP-9', reason: 'window_after_horizon' },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ));

    const res = await invokeRoute(
      makeRequest({ slug: 'acme', message: 'M-1 e rotta' }, 'ip-fresh-skip'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // The rollup must be present, manager-facing, and carry the real reason.
    expect(Array.isArray(body.skipped_rules)).toBe(true);
    expect(body.skipped_rules).toHaveLength(1);
    const op = body.skipped_rules[0];
    expect(op.type).toBe('operator_unavailable_skipped');
    expect(op.target).toBe('OP-9');
    expect(op.reason).toBe('window_after_horizon');
    expect(op.message).toMatch(/OP-9/);
  });

  it('returns extract_miss when BOTH the extractor and the interpreter decline', async () => {
    // Wave 16.6 §A: on extractor MISS the route now gives the closed-set Haiku
    // interpreter a second pass. When the interpreter ALSO declines
    // (intent_id:'unknown' → structural reject) the route still returns
    // code 'extract_miss', but the rationale is now the interpreter's
    // manager-facing clarify message (`ix.confirmation_message ??
    // extracted.rationale`), not the extractor's raw rationale. We assert the
    // ACTUAL new outcome rather than forcing the old 'vaga' string.
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'miss',
      confidence: 0.2,
      payload: null,
      rationale: 'frase troppo vaga, manca soggetto',
      pattern_id: null,
      confirmation_message: null,
    });
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({ intent_id: 'unknown', confidence: 'high' }),
    );

    const res = await invokeRoute(
      makeRequest({ slug: 'acme', message: 'fai qualcosa' }, 'ip-fresh-miss'),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe('extract_miss');
    // The interpreter supplied the clarify rationale (a non-empty, meaningful
    // message); it is NOT the extractor's 'vaga' string anymore.
    expect(typeof body.rationale).toBe('string');
    expect(body.rationale.length).toBeGreaterThanOrEqual(10);
    // Exactly one interpreter call was made for the fallback.
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
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
      pattern_id: 'machine_unavail_v1',
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
        // Realistic HIT shape (devil M-2): an explicit dalle-alle window genuinely
        // HITs machine_unavail_v1 with no needs_day. "M-2 ferma" alone only GRAYs.
        { slug: 'acme', message: 'ferma M-2 dalle 14 alle 18', baselineSolution, currentTimeMin: 120, cushionMin: 30 },
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

  // Wave 16.5 #6 — the no-anchor cutoff comes ONLY from the explicit
  // currentTimeMin (wall clock), NEVER re-parsed from the message text. The
  // old code ran detectScenarioStartMin(message) and Math.max'd it with the
  // clock cutoff, so "da domani" forced 1440 (calendar DAY_MIN, wrong unit +
  // wrong anchor — TD-031). That fallback is removed: with currentTimeMin=60
  // cushionMin=30 the cutoff is exactly 90.
  //
  // Devil M-2 / memory feedback_test_realistic_caller_shape: the prior version
  // of this test mocked result:'hit' for an "...oggi...da domani..." string,
  // which is an IMPOSSIBLE caller shape — the real BE returns MISS for that
  // phrase (and, for a resolvable relative date with no anchor, would set
  // needs_day_clarification and the route would short-circuit before this
  // cutoff logic). That masked C-1. Use a genuine no-needs_day HIT instead:
  // "ferma M-1 dalle 14 alle 18" → machine_unavail_v1 HIT, needs_day absent,
  // an explicit-window intent that legitimately reaches the no-anchor cutoff.
  it('no-anchor cutoff is currentTime+cushion only (realistic dalle-alle HIT, no needs_day)', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.9,
      payload: { unavailable_machines: { 'M-1': [{ start_min: 840, end_min: 1080 }] } },
      rationale: 'ok',
      pattern_id: 'machine_unavail_v1',
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
          message: 'ferma M-1 dalle 14 alle 18',
          baselineSolution: { solution: {} },
          currentTimeMin: 60,
          cushionMin: 30,
        },
        'ip-fresh-clockonly',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // clock only: 60 + 30 = 90. NOT 1440 (the deleted scenario-text fallback).
    expect(body.cutoff_min).toBe(90);
    expect(body.cutoff_source).toBe('scenario_or_clock');
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

  // Wave 16.5 #6 — the regression this fix exists for, end-to-end with the
  // REAL caller shape (devil M-2 / memory feedback_test_realistic_caller_shape).
  // After the BE gate extension (#3), "sposta com-001 dopodomani" — a relative
  // date with no day anchor — returns needs_day_clarification=true. The route's
  // gate (placed before the miss/gray/hit branches) then returns code 'needs_day'
  // and NEVER reaches the cutoff logic, so the old detectScenarioStartMin
  // "dopodomani"→2880 calendar over-freeze (TD-031) can no longer occur: the
  // system ASKS instead. We mock the realistic GRAY+needs_day payload (NOT a
  // fabricated hit) so this also guards that the gate fires for dopodomani.
  it('"dopodomani" with no anchor → needs_day (asks), never solves or over-freezes', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'gray_zone',
      confidence: 0.55,
      payload: { deadline_changes: { 'COM-001': {} }, needs_day_clarification: true },
      rationale: 'manca il giorno',
      pattern_id: 'deadline_change_v3',
      confirmation_message: null,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        // "dopodomani" + no day_anchor + no currentTimeMin.
        { slug: 'acme', message: 'sposta com-001 dopodomani', baselineSolution: { time_config: { day_length_min: 960 }, solution: {} } },
        'ip-fresh-dopodomani',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    // Asks the day; crucially NO solve ran → no 2880 calendar freeze possible.
    expect(body.ok).toBe(false);
    expect(body.code).toBe('needs_day');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Companion (FE-isolation): a NON-relative HIT with no day_anchor and no
  // currentTimeMin reaches the no-anchor branch and yields NO cutoff — the
  // full-horizon replan (TD-030). This is the path the deleted
  // detectScenarioStartMin fallback used to corrupt; it must now be a clean
  // no-freeze. "ferma M-1 dalle 14 alle 18" is a realistic v1 HIT (no needs_day).
  it('no-anchor + no currentTimeMin (non-relative HIT) → no cutoff, full-horizon solve', async () => {
    vi.mocked(extractConstraintFromBackend).mockResolvedValueOnce({
      result: 'hit',
      confidence: 0.9,
      payload: { unavailable_machines: { 'M-1': [{ start_min: 840, end_min: 1080 }] } },
      rationale: 'ok',
      pattern_id: 'machine_unavail_v1',
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
        { slug: 'acme', message: 'ferma M-1 dalle 14 alle 18', baselineSolution: { time_config: { day_length_min: 960 }, solution: {} } },
        'ip-fresh-noanchor-noclock',
      ),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cutoff_min).toBeNull();
    expect(body.cutoff_source).toBe('none');
    expect(body.frozen_count).toBe(0);
    expect(body.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const solveBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(solveBody.cutoff_min ?? null).toBeNull();
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
