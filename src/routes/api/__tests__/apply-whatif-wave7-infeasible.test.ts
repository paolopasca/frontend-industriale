import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-W7-02 — INFEASIBLE recovery deep-dive (w8-infeasible-recovery).
 *
 * The "happy path" retry+lock_relaxed_to_soft case is already in
 * `apply-whatif-wave7.test.ts`. This file pins down the edge cases the
 * Wave 8 audit flagged as un-tested:
 *
 *   1. Both first solve AND retry come back INFEASIBLE → BFF still emits
 *      a `solved` event so the UI never hangs; status stays INFEASIBLE
 *      and the warning marks the failed relaxation.
 *   2. OPTIMAL on the first call → NO retry, NO `lock_relaxing` event
 *      (regression guard against firing the relax path unnecessarily).
 *   3. Backend timeout during the retry → graceful `error` event with
 *      `solve_timeout` code, no unhandled rejection / process crash.
 *   4. Retry cap = max 1 — the BFF makes exactly 2 backend calls when
 *      the first is INFEASIBLE, never 3 (no infinite loop).
 *   5. `frozen_phases.length === 0` (no cutoff supplied) → the INFEASIBLE
 *      branch must NOT trigger a retry, because the hard-lock was never
 *      the cause of infeasibility.
 *
 * Devils 2026-05-22 findings (F-W8-04 + F-W8-05 + F-W8-06):
 *
 *   6. F-W8-04: client abort between lock_relaxing emit and retry race
 *      arm rejects synchronously instead of waiting 60s for setTimeout.
 *   7. F-W8-05: watchdog budget (now SOLVE_TIMEOUT_MS * 2 + 30s) covers
 *      a worst-case 55s first solve + 50s retry without firing.
 *   8. F-W8-06 Wave 9 OPT 1 (w9-backend-lock-mode 2026-05-23): the backend
 *      now accepts `frozen_lock_mode='hint'`. The retry path re-submits
 *      the SAME frozen_phases list with the hint mode so the consolidated
 *      set is preserved as `model.AddHint` (soft preference) instead of
 *      being dropped wholesale. lock_relaxing emits
 *      `recompute_mode: 'frozen_phases_as_hint'` and solved.warnings
 *      carries `lock_relaxed_to_soft__consolidated_preserved_as_hint` —
 *      the UI keeps the lock-relaxed banner amber (no red) because
 *      consolidated phases are NOT lost. The Wave 8 Opt 2 marker
 *      `__plan_recomputed_from_scratch` is retired.
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
      input_tokens: 200,
      output_tokens: 30,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
  };
}

function jsonResponse(body: object): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const nestedSolution = {
  'COM-001': {
    fasi: [
      { operazione: 'OP-1', macchina: 'M01', operatore: 'OP-A', start_min: 0, end_min: 60 },
      { operazione: 'OP-2', macchina: 'M02', operatore: 'OP-A', start_min: 60, end_min: 120 },
    ],
  },
  'COM-007': {
    fasi: [
      { operazione: 'OP-1', macchina: 'M03', operatore: 'OP-B', start_min: 0, end_min: 80 },
    ],
  },
};

const baseBody = {
  slug: 'acme-spa',
  originalSolution: nestedSolution,
  kpis: { makespan_min: 2880 },
  whatifText: '## 1. Interpretazione\n…',
  consultationMd: '## Tipo problema: fjsp\n',
  currentTimeMin: 90,
  cushionMin: 30,
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

describe('F-W7-02 — INFEASIBLE recovery edge cases', () => {
  it('Case 2: both first solve AND retry INFEASIBLE → solved event with INFEASIBLE + lock_relaxed_to_soft warning', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'order_priority',
        entities: { order_ids: ['COM-001'] },
        confidence: 'high',
      }),
    );

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        status: 'INFEASIBLE',
        method: 'cp-sat',
        solution: {},
        kpis: {},
        objective_value: 0,
        warnings: ['cpsat:infeasible'],
        cost_usd: 0,
        wave7: {
          cutoff_min: 120,
          locked_count: 2,
          frozen_phases: [],
          apply_rules: [
            { type: 'priority_orders_applied', priority_jobs: ['COM-001'], pairs_posted: 1 },
          ],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        // The retry (without frozen_phases) still comes back INFEASIBLE.
        // BFF must NOT crash — it must emit `solved` with status
        // INFEASIBLE so the UI can display "scenario impossibile" to the
        // manager and surface the warning.
        status: 'INFEASIBLE',
        method: 'cp-sat',
        solution: {},
        kpis: {},
        objective_value: 0,
        warnings: ['cpsat:infeasible_after_relax'],
        cost_usd: 0,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest({ ...baseBody, managerText: 'priorità COM-001' }, '10.0.8.1'),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // Stream must complete normally — solved + done, no `error`.
    expect(events).toContain('lock_relaxing');
    expect(events).toContain('solved');
    expect(events).toContain('done');
    expect(events).not.toContain('error');

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      status: string;
      warnings: string[];
    };
    // Status reflects what the relaxed retry returned (still INFEASIBLE).
    expect(solved.status).toBe('INFEASIBLE');
    // The lock_relaxed_to_soft marker is prepended so the UI knows the
    // BFF tried the fallback path; the backend's own warnings come after.
    expect(solved.warnings[0]).toBe('lock_relaxed_to_soft');
    expect(solved.warnings).toContain('cpsat:infeasible_after_relax');
    // F-W8-06 Wave 9 OPT 1: the louder marker for "consolidated preserved
    // as hint" travels alongside the legacy marker. The earlier
    // `__plan_recomputed_from_scratch` marker is replaced now that the
    // backend supports the hint mode (w9-backend-lock-mode 2026-05-23).
    expect(solved.warnings).toContain('lock_relaxed_to_soft__consolidated_preserved_as_hint');

    // Backend called exactly twice — original + 1 relaxed retry.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('F-W8-06 Wave 9 OPT 1: lock_relaxing carries recompute_mode=frozen_phases_as_hint AND retry payload preserves frozen_phases with frozen_lock_mode=hint', async () => {
    // Wave 9 (w9-backend-lock-mode 2026-05-23): backend accepts
    // `frozen_lock_mode='hint'`. The BFF retry re-submits the SAME
    // frozen_phases list with the soft-preference mode, so the
    // consolidated set is preserved as `model.AddHint` instead of being
    // wiped (Wave 8 Opt 2 fallback). The marker emitted on solved.warnings
    // is `__consolidated_preserved_as_hint` and the lock_relaxing event
    // carries `recompute_mode: 'frozen_phases_as_hint'`.
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'order_priority',
        entities: { order_ids: ['COM-001'] },
        confidence: 'high',
      }),
    );

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        status: 'INFEASIBLE',
        method: 'cp-sat',
        solution: {},
        kpis: {},
        objective_value: 0,
        warnings: [],
        cost_usd: 0,
        wave7: {
          cutoff_min: 120,
          locked_count: 2,
          frozen_phases: [],
          apply_rules: [],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'OPTIMAL',
        method: 'cp-sat',
        solution: {},
        kpis: { makespan_min: 2900 },
        objective_value: 2900,
        warnings: [],
        cost_usd: 0,
        wave7: {
          cutoff_min: 120,
          locked_count: 2,
          frozen_phases: [],
          apply_rules: [],
          // Per w9-backend-lock-mode contract: the kernel echoes back the
          // mode it actually applied. Tests assert the BFF asked for
          // 'hint' on the retry by inspecting the request body below; the
          // backend echo here is a separate audit channel.
          frozen_lock_mode: 'hint',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest({ ...baseBody, managerText: 'priorità COM-001' }, '10.0.86.1'),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));

    const lockRelaxing = chunks.find((c) => c.event === 'lock_relaxing')!.data as {
      reason: string;
      recompute_mode: string;
      frozen_count: number;
    };
    expect(lockRelaxing.reason).toBe('infeasible_with_hard_lock');
    expect(lockRelaxing.recompute_mode).toBe('frozen_phases_as_hint');
    // The retry preserves the consolidated set — frozen_count is the
    // number of phases identified, NOT zeroed out.
    expect(lockRelaxing.frozen_count).toBeGreaterThan(0);

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      status: string;
      warnings: string[];
    };
    expect(solved.warnings).toContain('lock_relaxed_to_soft');
    expect(solved.warnings).toContain('lock_relaxed_to_soft__consolidated_preserved_as_hint');
    // Wave 9 specifically must NOT emit the Wave 8 `__plan_recomputed_from_scratch`
    // marker — that one is replaced because the plan is NOT recomputed from scratch.
    expect(solved.warnings).not.toContain('lock_relaxed_to_soft__plan_recomputed_from_scratch');

    // Inspect the retry request body: frozen_phases must be the FULL list
    // (preserved) AND `frozen_lock_mode: 'hint'` must be present.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryBody = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    );
    expect(retryBody.frozen_lock_mode).toBe('hint');
    expect(Array.isArray(retryBody.frozen_phases)).toBe(true);
    expect(retryBody.frozen_phases.length).toBeGreaterThan(0);
    // First call (the hard-lock attempt) must NOT include frozen_lock_mode —
    // it relies on the backend default 'hard'.
    const firstBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(firstBody.frozen_lock_mode).toBeUndefined();
  });

  it('Case 3: OPTIMAL on first solve → no retry, no lock_relaxing event', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'order_priority',
        entities: { order_ids: ['COM-001'] },
        confidence: 'high',
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      status: 'OPTIMAL',
      method: 'cp-sat',
      solution: { 'COM-001': { fasi: [] } },
      kpis: { makespan_min: 2700 },
      objective_value: 2700,
      warnings: [],
      cost_usd: 0,
      wave7: { cutoff_min: 120, locked_count: 3, frozen_phases: [], apply_rules: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest({ ...baseBody, managerText: 'priorità COM-001' }, '10.0.8.2'),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // No lock_relaxing event — the first solve succeeded, the relax
    // path is not triggered.
    expect(events).not.toContain('lock_relaxing');
    expect(events).toContain('solved');

    // Solved.warnings must NOT contain the lock_relaxed_to_soft marker
    // (this is the regression guard: the marker is only added inside
    // the relax branch).
    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      status: string;
      warnings: string[];
    };
    expect(solved.status).toBe('OPTIMAL');
    expect(solved.warnings).not.toContain('lock_relaxed_to_soft');

    // Backend called exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Case 4: backend timeout on the retry → graceful error event, no crash', async () => {
    // Use fake timers so we can trigger the 60s solve_timeout deterministically.
    vi.useFakeTimers();
    try {
      anthropicCreate.mockResolvedValueOnce(
        fakeHaikuReply({
          intent_id: 'order_priority',
          entities: { order_ids: ['COM-001'] },
          confidence: 'high',
        }),
      );

      // First call: INFEASIBLE (triggers relax).
      // Second call: a fetch that never resolves — the BFF's 60s
      // solve_timeout fires inside the relaxed retry promise race.
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(jsonResponse({
          status: 'INFEASIBLE',
          method: 'cp-sat',
          solution: {},
          kpis: {},
          objective_value: 0,
          warnings: [],
          cost_usd: 0,
          wave7: {
            cutoff_min: 120,
            locked_count: 1,
            frozen_phases: [],
            apply_rules: [],
          },
        }))
        .mockImplementationOnce(() => new Promise(() => undefined));
      vi.stubGlobal('fetch', fetchMock);

      const resPromise = invokeRoute(
        makeRequest({ ...baseBody, managerText: 'priorità COM-001' }, '10.0.8.3'),
      );
      // Pump microtasks so the route reaches the retry promise.
      await vi.advanceTimersByTimeAsync(50);
      // Fast-forward past the 60s solve_timeout for the retry.
      await vi.advanceTimersByTimeAsync(60_500);
      const res = await resPromise;
      expect(res.status).toBe(200);

      const chunks = parseSse(await streamToString(res.body!));
      const events = chunks.map((c) => c.event);

      // The retry path was entered (lock_relaxing emitted) but the
      // backend hung, so the route surfaces a clean `error` event with
      // code `solve_timeout`. No unhandled rejection, no `solved` for
      // the relaxed result.
      expect(events).toContain('lock_relaxing');
      expect(events).toContain('error');

      const errEvent = chunks.find((c) => c.event === 'error')!.data as {
        code: string;
        message: string;
      };
      expect(errEvent.code).toBe('solve_timeout');
      expect(errEvent.message).toMatch(/solve_timeout/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('Case 5: retry cap — max 1 retry, never 3 backend calls (no infinite loop)', async () => {
    // Belt-and-braces: even if both first AND retry are INFEASIBLE, the
    // BFF must stop after the second call. It must not loop, must not
    // recursively re-arm the relax path.
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'order_priority',
        entities: { order_ids: ['COM-001'] },
        confidence: 'high',
      }),
    );

    const infeasibleBody = {
      status: 'INFEASIBLE',
      method: 'cp-sat',
      solution: {},
      kpis: {},
      objective_value: 0,
      warnings: ['cpsat:infeasible'],
      cost_usd: 0,
      wave7: { cutoff_min: 120, locked_count: 1, frozen_phases: [], apply_rules: [] },
    };
    // Arm a third response that should NEVER be consumed.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(infeasibleBody))
      .mockResolvedValueOnce(jsonResponse(infeasibleBody))
      .mockResolvedValueOnce(jsonResponse({
        status: 'OPTIMAL', method: 'cp-sat', solution: {}, kpis: {},
        objective_value: 0, warnings: [], cost_usd: 0,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest({ ...baseBody, managerText: 'priorità COM-001' }, '10.0.8.4'),
    );
    expect(res.status).toBe(200);
    await streamToString(res.body!);

    // Hard cap: exactly 2 backend calls (the third armed response is
    // proof that we'd notice if a recursive relax sneaked in).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Case 6: frozen_phases.length === 0 (no cutoff applied) → INFEASIBLE does NOT trigger retry', async () => {
    // When currentTimeMin is omitted, cutoffMin is undefined and
    // frozenPhases is []. In that case the hard-lock was never the
    // cause of infeasibility — retrying without it would be wasted
    // backend cost and could mask a real solver issue. The BFF must
    // pass the INFEASIBLE straight through.
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'order_priority',
        entities: { order_ids: ['COM-001'] },
        confidence: 'high',
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      status: 'INFEASIBLE',
      method: 'cp-sat',
      solution: {},
      kpis: {},
      objective_value: 0,
      warnings: ['cpsat:infeasible'],
      cost_usd: 0,
    }));
    vi.stubGlobal('fetch', fetchMock);

    // currentTimeMin explicitly undefined → no cutoff → no frozen phases.
    const { currentTimeMin: _drop, ...bodyNoCutoff } = baseBody;
    void _drop;
    const res = await invokeRoute(
      makeRequest({ ...bodyNoCutoff, managerText: 'priorità COM-001' }, '10.0.8.5'),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // No retry → no lock_relaxing.
    expect(events).not.toContain('lock_relaxing');
    expect(events).toContain('solved');
    expect(events).not.toContain('error');

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      status: string;
      warnings: string[];
    };
    // INFEASIBLE passes through unchanged — no spurious relax marker.
    expect(solved.status).toBe('INFEASIBLE');
    expect(solved.warnings).not.toContain('lock_relaxed_to_soft');

    // Exactly one backend call (no retry).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('F-W8-04: client abort between lock_relaxing and retry race does not stall the stream', async () => {
    // Devils 2026-05-22: an AbortSignal listener added AFTER abort() never
    // fires (verified empirically in node repl). Before the fix, if the
    // client disconnected between the SSE `lock_relaxing` write and the
    // retry race armament, the setTimeout would tick for the full 60s
    // before reject. The fix is a synchronous abort-check inside the
    // race helper + an explicit check right after `lock_relaxing`.
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'order_priority',
        entities: { order_ids: ['COM-001'] },
        confidence: 'high',
      }),
    );

    // First call: INFEASIBLE (triggers retry path). We then sabotage the
    // request by manually aborting via the controller exposed through the
    // request's signal: replicate the "client closed the stream right
    // after lock_relaxing" race.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        status: 'INFEASIBLE',
        method: 'cp-sat',
        solution: {},
        kpis: {},
        objective_value: 0,
        warnings: [],
        cost_usd: 0,
        wave7: { cutoff_min: 120, locked_count: 1, frozen_phases: [], apply_rules: [] },
      }))
      .mockImplementationOnce(() => new Promise(() => undefined));
    vi.stubGlobal('fetch', fetchMock);

    const ac = new AbortController();
    const req = new Request('http://localhost:8080/api/apply-whatif', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-real-ip': '10.0.8.6',
        'content-length': String(JSON.stringify({ ...baseBody, managerText: 'priorità COM-001' }).length),
      },
      body: JSON.stringify({ ...baseBody, managerText: 'priorità COM-001' }),
      signal: ac.signal,
    });

    const resPromise = invokeRoute(req);
    // Give the route time to reach the lock_relaxing emit + retry race
    // arm, then abort. Without the fix, the stream would sit on the
    // retry's 60s setTimeout. With the fix, the abort-check inside the
    // race helper rejects synchronously and the SSE wraps up via the
    // outer catch.
    await new Promise((r) => setTimeout(r, 50));
    ac.abort('client_disconnect');

    // The route must complete within reasonable time — definitely much
    // less than SOLVE_TIMEOUT_MS=60_000. If we hit a stall, the test
    // hangs and vitest's per-test timeout (5s default) catches it.
    const res = await resPromise;
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // The retry path WAS entered (lock_relaxing emitted) before the abort.
    expect(events).toContain('lock_relaxing');
    // After abort, the stream closes via either `error` (race rejected
    // with "aborted") or `aborted` — never a hang or a `solved`.
    const hasTerminalEvent = events.includes('error') || events.includes('aborted');
    expect(hasTerminalEvent, `expected error or aborted, got events=${events.join(',')}`).toBe(true);
    expect(events).not.toContain('solved');
  });

  it('F-W8-05: watchdog covers both first solve AND retry (was 90s, now 150s)', async () => {
    // Devils 2026-05-22: WATCHDOG_MS was SOLVE_TIMEOUT_MS + 30s = 90s.
    // Scenario "first solve 55s INFEASIBLE → retry 50s" totals 105s,
    // which exceeded the watchdog and triggered a spurious slug-lock
    // release + abort mid-retry. After the fix the budget is 2x
    // SOLVE_TIMEOUT_MS + 30s = 150s; the watchdog must NOT fire while
    // a legitimate retry is still in flight.
    vi.useFakeTimers();
    try {
      anthropicCreate.mockResolvedValueOnce(
        fakeHaikuReply({
          intent_id: 'order_priority',
          entities: { order_ids: ['COM-001'] },
          confidence: 'high',
        }),
      );

      // Backend behaviour: first call resolves INFEASIBLE after 55s,
      // retry resolves OPTIMAL after another 50s. Total 105s.
      let firstResolve: ((r: Response) => void) | null = null;
      let retryResolve: ((r: Response) => void) | null = null;
      const fetchMock = vi.fn()
        .mockImplementationOnce(() => new Promise<Response>((r) => { firstResolve = r; }))
        .mockImplementationOnce(() => new Promise<Response>((r) => { retryResolve = r; }));
      vi.stubGlobal('fetch', fetchMock);

      const slug = 'w8-watchdog-retry-coverage';
      const resPromise = invokeRoute(
        makeRequest({ ...baseBody, slug, managerText: 'priorità COM-001' }, '10.0.8.7'),
      );

      // Tick into the first solve.
      await vi.advanceTimersByTimeAsync(55_000);
      // Resolve first solve as INFEASIBLE — triggers the retry path.
      firstResolve!(new Response(JSON.stringify({
        status: 'INFEASIBLE',
        method: 'cp-sat',
        solution: {},
        kpis: {},
        objective_value: 0,
        warnings: [],
        cost_usd: 0,
        wave7: { cutoff_min: 120, locked_count: 1, frozen_phases: [], apply_rules: [] },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

      // Let microtasks flush so the retry kicks off.
      await vi.advanceTimersByTimeAsync(1);
      // Now we're 55s in. Advance another 50s (total 105s) — under the
      // OLD 90s watchdog this would have fired; under the NEW 150s it
      // must not.
      await vi.advanceTimersByTimeAsync(50_000);
      // Resolve retry as OPTIMAL.
      retryResolve!(new Response(JSON.stringify({
        status: 'OPTIMAL', method: 'cp-sat',
        solution: {}, kpis: { makespan_min: 2900 },
        objective_value: 2900, warnings: [], cost_usd: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } }));

      // Drain remaining microtasks.
      await vi.advanceTimersByTimeAsync(1);

      const res = await resPromise;
      expect(res.status).toBe(200);
      const chunks = parseSse(await streamToString(res.body!));
      const events = chunks.map((c) => c.event);
      // Both phases completed successfully under the extended budget.
      expect(events).toContain('lock_relaxing');
      expect(events).toContain('solved');
      // No abort surfaced as error.
      expect(events).not.toContain('error');

      const solved = chunks.find((c) => c.event === 'solved')!.data as {
        status: string;
        warnings: string[];
      };
      expect(solved.status).toBe('OPTIMAL');
      expect(solved.warnings).toContain('lock_relaxed_to_soft');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('B-W8-S-04 — Haiku unknown+high short-circuits Opus cascade', () => {
  // Stress engineer 2026-05-22: `intent_id="unknown" + confidence="high"`
  // is Haiku's "definitely outside the 5 catalog intents" signal. The
  // previous router cascaded to Opus translator (strategy-router.ts:452)
  // which also returned unsupported. $0.20 per cycle × 5 stress cycles
  // = $1.00 wasted. The BFF now short-circuits and emits
  // `aborted_unsupported` directly when Haiku is confident.

  it('Haiku unknown + confidence=high → aborted_unsupported, no translating event, no Opus call', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'unknown',
        entities: {},
        confidence: 'high',
        fallback_reasoning: 'domanda di valutazione finanziaria fuori dai 5 intent del catalogo',
      }),
    );

    // No backend calls expected — the short-circuit bails before
    // anything network-side fires. Stub fetch with a failing impl so
    // an unexpected call is loud.
    const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected backend call'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest({ ...baseBody, managerText: 'a quanto ammontano i debiti aziendali?' }, '10.0.84.1'),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // Required terminal sequence: parsing_intent → intent_parsed →
    // routed → aborted_unsupported → done.
    expect(events).toEqual(['parsing_intent', 'intent_parsed', 'routed', 'aborted_unsupported', 'done']);
    // Strategy C (Opus translator) markers must NOT appear.
    expect(events).not.toContain('translating');
    expect(events).not.toContain('translated');
    expect(events).not.toContain('solving');
    expect(events).not.toContain('solved');
    expect(events).not.toContain('error');

    const routed = chunks.find((c) => c.event === 'routed')!.data as {
      strategy: string;
      intent_id: string;
      warnings: string[];
    };
    expect(routed.strategy).toBe('unsupported');
    expect(routed.intent_id).toBe('unknown');
    expect(routed.warnings).toContain('haiku_unknown_high_no_cascade');

    const aborted = chunks.find((c) => c.event === 'aborted_unsupported')!.data as {
      reason: string;
      warnings: string[];
    };
    // Reason preserves the Haiku fallback_reasoning when present, so
    // the UI can surface the precise diagnosis to the manager.
    expect(aborted.reason).toBe('domanda di valutazione finanziaria fuori dai 5 intent del catalogo');
    expect(aborted.warnings).toContain('haiku_unknown_high_no_cascade');

    // Anthropic SDK called exactly once — only the Haiku parser, no
    // Opus translator cascade. The savings claim ($0.20/cycle) hinges
    // on this assertion.
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    // Backend never reached — no fetch made.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Haiku unknown + confidence=high with NO Haiku-supplied fallback_reasoning → reason still meaningful (parser injects default)', async () => {
    // Defense in depth — the intent-parser injects a default reason
    // (`intent non riconosciuto dal catalogo`) when Haiku omits one
    // (parser line ~318). The short-circuit then forwards whatever
    // the parser produced. If the parser ever stops injecting a
    // default, the BFF's `?? 'haiku_classified_unknown_high_confidence'`
    // fallback in apply-whatif.ts:B-W8-S-04 catches it.
    //
    // The assertion is on the property "reason is a non-empty
    // meaningful string", because the exact text depends on the
    // upstream parser layer.
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'unknown',
        entities: {},
        confidence: 'high',
        // No fallback_reasoning.
      }),
    );

    const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected backend call'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest({ ...baseBody, managerText: 'asdf qwer' }, '10.0.84.2'),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));

    const aborted = chunks.find((c) => c.event === 'aborted_unsupported')!.data as { reason: string };
    // Must be non-empty meaningful text (>= 10 chars). Both the
    // parser default and the BFF default qualify.
    expect(aborted.reason.length).toBeGreaterThanOrEqual(10);
    expect(aborted.reason).toMatch(/intent|catalogo|haiku|unknown|classified/i);
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('Haiku unknown + confidence=low → Opus translator cascade still fires (negative guard)', async () => {
    // The short-circuit is intentionally scoped to confidence=high.
    // When Haiku is uncertain (confidence=low), the cascade to Opus
    // translator is a legitimate rescue path — Opus may recognize a
    // catalog intent Haiku couldn't pin down. Regression guard.
    anthropicCreate
      // 1st call: Haiku returns unknown/low.
      .mockResolvedValueOnce(
        fakeHaikuReply({
          intent_id: 'unknown',
          entities: {},
          confidence: 'low',
          fallback_reasoning: 'ambiguous',
        }),
      )
      // 2nd call: Opus translator. We make it return unsupported so
      // the assertion is symmetric, but the key check is that
      // `anthropicCreate` was called TWICE (Haiku + Opus).
      .mockResolvedValueOnce({
        content: [{
          type: 'text',
          text: JSON.stringify({
            type: 'unsupported',
            unsupportedReason: 'opus_could_not_map_either',
            warnings: ['opus_unsupported'],
          }),
        }],
        usage: { input_tokens: 800, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });

    const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected backend call'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest({ ...baseBody, managerText: 'cose strane succedono in produzione' }, '10.0.84.3'),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // The Strategy C path fires — translating/translated events MUST
    // be present, proving the cascade still runs for low confidence.
    expect(events).toContain('translating');
    expect(events).toContain('translated');

    // Opus translator was called → 2 LLM calls total.
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
  });

  it('F-W8-10 regression: Haiku unknown + confidence=medium STILL cascades to Opus (discriminator is === high only)', async () => {
    // F-W8-10 (devils advocate 2026-05-22): pin that the
    // discriminator is strictly `confidence === 'high'`, NOT
    // `confidence !== 'low'`. The `medium` case represents Haiku
    // "tentatively rejecting" with at least one assumption — Opus
    // refinement still has value. Regressing the discriminator to
    // `!== 'low'` would skip Opus for medium and burn UX (manager
    // sees aborted_unsupported on borderline cases that Opus could
    // have rescued).
    anthropicCreate
      .mockResolvedValueOnce(
        fakeHaikuReply({
          intent_id: 'unknown',
          entities: {},
          confidence: 'medium',
          fallback_reasoning: 'classificazione tentata con piu assunzioni',
        }),
      )
      .mockResolvedValueOnce({
        content: [{
          type: 'text',
          text: JSON.stringify({
            type: 'unsupported',
            unsupportedReason: 'opus_could_not_disambiguate',
            warnings: ['opus_unsupported_medium_path'],
          }),
        }],
        usage: { input_tokens: 800, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });

    const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected backend call'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest({ ...baseBody, managerText: 'ferma qualcosa domani forse?' }, '10.0.84.5'),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // Must enter Strategy C — translating/translated present.
    expect(events).toContain('translating');
    expect(events).toContain('translated');

    // The `haiku_unknown_high_no_cascade` warning MUST NOT appear —
    // that marker is exclusively for the short-circuit path. Its
    // presence on a medium-confidence run would indicate the
    // discriminator regressed to `!== 'low'`.
    const routed = chunks.find((c) => c.event === 'routed')!.data as { warnings: string[] };
    expect(routed.warnings).not.toContain('haiku_unknown_high_no_cascade');

    // Opus was called → 2 LLM calls total.
    expect(anthropicCreate).toHaveBeenCalledTimes(2);
  });

  it('Haiku known intent + confidence=high → still routes through strategy A/B (not short-circuited)', async () => {
    // Confirms the short-circuit only fires for `unknown`. A known
    // catalog intent with high confidence proceeds to Strategy B /
    // backend solve as usual.
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'order_priority',
        entities: { order_ids: ['COM-001'] },
        confidence: 'high',
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({
      status: 'OPTIMAL',
      method: 'cp-sat',
      solution: { 'COM-001': { fasi: [] } },
      kpis: { makespan_min: 2700 },
      objective_value: 2700,
      warnings: [],
      cost_usd: 0,
      wave7: { cutoff_min: 120, locked_count: 1, frozen_phases: [], apply_rules: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest({ ...baseBody, managerText: 'priorità COM-001' }, '10.0.84.4'),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // Strategy B path — solving/solved present, no aborted_unsupported.
    expect(events).toContain('solving');
    expect(events).toContain('solved');
    expect(events).not.toContain('aborted_unsupported');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
