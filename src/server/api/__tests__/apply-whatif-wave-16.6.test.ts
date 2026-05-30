import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 16.6 §C/§D/§E — apply-whatif route tests for:
 *   §C  priorRules ledger merged NEW-WINS into BOTH resolveTemplate calls.
 *   §D  empty-solution guard: OPTIMAL/FEASIBLE + zero-phase solution on a
 *       non-empty baseline → aborted_unsupported(empty_solution_after_solve);
 *       INFEASIBLE is NOT guarded (legitimate terminal solved).
 *   §E  time_window_start_unsupported warning when an explicit clock start
 *       time rides on a day anchor the solver can't pin.
 *
 * Harness mirrors apply-whatif.test.ts: mock the Anthropic SDK + globalThis
 * fetch, drive the file route's POST handler, parse the SSE body.
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

function fakeHaikuReply(payload: object) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

// Non-empty baseline so the §D guard's `baselinePhaseCount > 0` gate holds.
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
  // Unique per-file slug (NOT the shared 'acme-spa' that ~10 apply-whatif test
  // files reuse) to avoid contending on apply-whatif.ts's module-level
  // _inFlightBySlug / rate-limiter maps under parallel execution — the H-3
  // isolation flake the devil-advocate flagged. Each test below also uses a
  // distinct IP.
  slug: 'wave166-co',
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

describe('Wave 16.6 §C — priorRules ledger merge (NEW-WINS)', () => {
  it('merges priorRules under the new scenario and sends the union to the backend', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({ intent_id: 'order_priority', entities: { order_ids: ['COM-007'] }, confidence: 'high' }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(NON_EMPTY_SOLVE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'priorità a COM-007',
      // A previously-accepted constraint carried forward via the ledger.
      priorRules: { unavailable_machines: { M02: [{ start_min: 960, end_min: 1440 }] } },
    }, '10.0.166.1'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    expect(chunks.map((c) => c.event)).toContain('solved');

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // BOTH the prior M02 downtime AND the new COM-007 priority reach the solver.
    expect(sentBody.rules.unavailable_machines).toEqual({ M02: [{ start_min: 960, end_min: 1440 }] });
    expect(sentBody.rules.priority_orders).toEqual(['COM-007']);
  });

  it('new OVERLAPPING window WINS over a conflicting prior window (same machine correction)', async () => {
    // Translator (Strategy C) emits a new M02 window that OVERLAPS the prior
    // ledger window → the manager corrected that downtime, so the newer window
    // replaces it (no double-ban). Disjoint windows would instead accumulate
    // (covered in appliedRulesLedger.test.ts).
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        type: 'block_machine',
        rules: { unavailable_machines: { M02: [{ start_min: 900, end_min: 1200 }] } },
        rationale: 'Correggo finestra M02.',
        confidence: 'high',
        warnings: [],
      }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(NON_EMPTY_SOLVE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    // No managerText → Strategy C translator path.
    const res = await invokeRoute(makeRequest({
      ...baseBody,
      priorRules: { unavailable_machines: { M02: [{ start_min: 960, end_min: 1440 }] } },
    }, '10.0.166.2'));
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    expect(chunks.map((c) => c.event)).toContain('solved');

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // Overlapping prior [960,1440] replaced by the corrected [900,1200].
    expect(sentBody.rules.unavailable_machines.M02).toEqual([{ start_min: 900, end_min: 1200 }]);
  });

  it('carry-state: prior M02 downtime PERSISTS when the new scenario is a different slot (priority)', async () => {
    // The canonical Wave 16.6 scenario. A previous what-if froze M02 (ledger),
    // and the manager now issues a NEW priority constraint. The solve must
    // honour BOTH — the M02 downtime is not lost when priority is added.
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({ intent_id: 'order_priority', entities: { order_ids: ['COM-001'] }, confidence: 'high' }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(NON_EMPTY_SOLVE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'priorità a COM-001',
      priorRules: { unavailable_machines: { M02: [{ start_min: 960, end_min: 1440 }] } },
    }, '10.0.166.3'));
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    expect(events).toContain('solved');
    expect(events).not.toContain('aborted_unsupported');
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.rules.unavailable_machines).toEqual({ M02: [{ start_min: 960, end_min: 1440 }] });
    expect(sentBody.rules.priority_orders).toEqual(['COM-001']);
  });

  it('omitting priorRules is a no-op (only the new scenario reaches the backend)', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({ intent_id: 'order_priority', entities: { order_ids: ['COM-007'] }, confidence: 'high' }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(NON_EMPTY_SOLVE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody, managerText: 'priorità a COM-007',
    }, '10.0.166.4'));
    const chunks = parseSse(await streamToString(res.body!));
    expect(chunks.map((c) => c.event)).toContain('solved');
    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(sentBody.rules.priority_orders).toEqual(['COM-007']);
    expect(sentBody.rules.unavailable_machines).toBeUndefined();
  });

  it('merges priorRules into the INFEASIBLE retry payload too (both calls)', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({ intent_id: 'order_priority', entities: { order_ids: ['COM-001'] }, confidence: 'high' }),
    );
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        status: 'INFEASIBLE', method: 'cp-sat', solution: {}, kpis: {}, objective_value: 0,
        warnings: ['cpsat:infeasible'], cost_usd: 0,
        wave7: { cutoff_min: 120, locked_count: 2, frozen_phases: [], apply_rules: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(NON_EMPTY_SOLVE), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      managerText: 'priorità COM-001',
      currentTimeMin: 90,
      cushionMin: 30,
      priorRules: { unavailable_machines: { M02: [{ start_min: 960, end_min: 1440 }] } },
    }, '10.0.166.5'));
    const chunks = parseSse(await streamToString(res.body!));
    expect(chunks.map((c) => c.event)).toContain('lock_relaxing');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const retryBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    // The prior M02 downtime is present on BOTH the first solve and the retry.
    expect(firstBody.rules.unavailable_machines).toEqual({ M02: [{ start_min: 960, end_min: 1440 }] });
    expect(retryBody.rules.unavailable_machines).toEqual({ M02: [{ start_min: 960, end_min: 1440 }] });
    expect(retryBody.frozen_lock_mode).toBe('hint');
  });
});

describe('Wave 16.6 §D — empty-solution guard (Gantt-not-updating fix)', () => {
  it('OPTIMAL with zero phases on a non-empty baseline → aborted_unsupported(empty_solution_after_solve)', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({ intent_id: 'order_priority', entities: { order_ids: ['COM-007'] }, confidence: 'high' }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'OPTIMAL', method: 'cp-sat', solution: {}, kpis: { makespan_min: 2700 },
        objective_value: 2700, warnings: [], cost_usd: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({ ...baseBody, managerText: 'priorità a COM-007' }, '10.0.166.10'));
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    // Solver WAS called (the guard is post-solve), but the misleading solved
    // is suppressed in favour of an explicit abort.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toContain('solving');
    expect(events).not.toContain('solved');
    expect(events).toContain('aborted_unsupported');
    const aborted = chunks.find((c) => c.event === 'aborted_unsupported')!.data as { reason: string; warnings: string[] };
    expect(aborted.reason).toBe('empty_solution_after_solve');
    expect(aborted.warnings).toContain('empty_solution_after_solve');
    expect(events[events.length - 1]).toBe('done');
  });

  it('a flat top-level fasi:[] solution is also treated as empty', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({ intent_id: 'order_priority', entities: { order_ids: ['COM-007'] }, confidence: 'high' }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'OPTIMAL', method: 'cp-sat', solution: { status: 'OPTIMAL', fasi: [] }, kpis: {},
        objective_value: 0, warnings: [], cost_usd: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({ ...baseBody, managerText: 'priorità a COM-007' }, '10.0.166.11'));
    const events = parseSse(await streamToString(res.body!)).map((c) => c.event);
    expect(events).toContain('aborted_unsupported');
    expect(events).not.toContain('solved');
  });

  it('INFEASIBLE with empty solution is NOT guarded (legitimate terminal solved)', async () => {
    // Both first solve AND retry INFEASIBLE → the UI must still get `solved`
    // with status INFEASIBLE so it can render "scenario impossibile".
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({ intent_id: 'order_priority', entities: { order_ids: ['COM-001'] }, confidence: 'high' }),
    );
    const infeasible = {
      status: 'INFEASIBLE', method: 'cp-sat', solution: {}, kpis: {}, objective_value: 0,
      warnings: ['cpsat:infeasible'], cost_usd: 0,
      wave7: { cutoff_min: 120, locked_count: 2, frozen_phases: [], apply_rules: [] },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(infeasible), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...infeasible, wave7: undefined }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody, managerText: 'priorità COM-001', currentTimeMin: 90, cushionMin: 30,
    }, '10.0.166.12'));
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    expect(events).toContain('solved');
    expect(events).not.toContain('aborted_unsupported');
    const solved = chunks.find((c) => c.event === 'solved')!.data as { status: string };
    expect(solved.status).toBe('INFEASIBLE');
  });

  it('non-empty solution passes the guard (normal solved)', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({ intent_id: 'order_priority', entities: { order_ids: ['COM-007'] }, confidence: 'high' }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(NON_EMPTY_SOLVE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({ ...baseBody, managerText: 'priorità a COM-007' }, '10.0.166.13'));
    const events = parseSse(await streamToString(res.body!)).map((c) => c.event);
    expect(events).toContain('solved');
    expect(events).not.toContain('aborted_unsupported');
  });
});

describe('Wave 16.6 §E — time_window_start_unsupported flag', () => {
  it('emits the warning when a clock start-time rides on a day anchor', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({ intent_id: 'order_priority', entities: { order_ids: ['COM-007'] }, confidence: 'high' }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(NON_EMPTY_SOLVE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody,
      // "domani" (day anchor) + "alle 8" (clock start) with no enforcing slot.
      managerText: 'anticipa COM-007 a domani alle 8',
    }, '10.0.166.20'));
    const chunks = parseSse(await streamToString(res.body!));
    const solved = chunks.find((c) => c.event === 'solved')!.data as { warnings: string[] };
    expect(solved.warnings).toContain('time_window_start_unsupported');
  });

  it('does NOT emit the warning for a bare machine downtime window (no day anchor)', async () => {
    // "ferma M-3 dalle 14 alle 18" maps to unavailable_machines, which IS
    // enforced — the clock time is the window itself, not an unpinnable
    // order start. No day anchor → no warning.
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'machine_unavailability',
        entities: { machine_id: 'M03', start_min: 840, end_min: 1080 },
        confidence: 'high',
      }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(NON_EMPTY_SOLVE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody, managerText: 'ferma M-3 dalle 14 alle 18',
    }, '10.0.166.21'));
    const chunks = parseSse(await streamToString(res.body!));
    const solved = chunks.find((c) => c.event === 'solved')!.data as { warnings: string[] };
    expect(solved.warnings).not.toContain('time_window_start_unsupported');
  });

  it('does NOT emit the warning for a day anchor with no explicit clock time', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({ intent_id: 'order_priority', entities: { order_ids: ['COM-007'] }, confidence: 'high' }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(NON_EMPTY_SOLVE), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(makeRequest({
      ...baseBody, managerText: 'anticipa COM-007 a domani',
    }, '10.0.166.22'));
    const chunks = parseSse(await streamToString(res.body!));
    const solved = chunks.find((c) => c.event === 'solved')!.data as { warnings: string[] };
    expect(solved.warnings).not.toContain('time_window_start_unsupported');
  });
});
