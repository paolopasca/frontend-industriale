import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * F-W9-08 — BFF retry payload contract for the e2e "frozen_lock_mode=hint
 * preserves consolidated softly" scenario.
 *
 * Companion to `tests/e2e/wave9-extensions.spec.ts` test 5. That e2e mocks
 * `**\/api/apply-whatif` (the BFF boundary) so it CANNOT verify what the
 * BFF actually sends to the backend kernel — the BFF code never runs in
 * the e2e. This file pins down the BFF -> backend payload contract for
 * the same machine_unavailability + INFEASIBLE retry scenario the e2e
 * exercises, so a BFF regression that stops emitting `frozen_lock_mode:
 * 'hint'` (or wipes `frozen_phases` on the retry) is caught here even if
 * the e2e is still green.
 *
 * Coverage:
 *   - first call hits backend with hard-lock semantics (no frozen_lock_mode)
 *   - first call returns INFEASIBLE -> BFF retries
 *   - retry call hits backend with `frozen_lock_mode: 'hint'`
 *     AND the SAME frozen_phases list (NOT wiped)
 *   - solved.warnings carry both legacy + W9 markers, and NOT the
 *     retired W8 `__plan_recomputed_from_scratch` marker
 *
 * Pattern of reference: `apply-whatif-low-confidence.test.ts`.
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
      output_tokens: 25,
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

// Baseline shaped to match the e2e scenario: a handful of phases all
// ending before cutoffMin=120 so buildFrozenPhases produces a non-empty
// list (otherwise the retry path is short-circuited — see Case 6 in
// `apply-whatif-wave7-infeasible.test.ts`).
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

describe('F-W9-08 — BFF retry payload contract (e2e test 5 companion)', () => {
  it('machine_unavailability + INFEASIBLE -> retry includes frozen_lock_mode=hint AND preserves frozen_phases', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'machine_unavailability',
        entities: { machine_id: 'M01', start_min: 0, end_min: 1200 },
        confidence: 'high',
        fallback_reasoning: null,
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
          apply_rules: [{ type: 'unavailable_machines', key: 'unavailable_machines' }],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        status: 'OPTIMAL',
        method: 'cp-sat',
        solution: { 'COM-001': { fasi: [] } },
        kpis: { makespan_min: 2970 },
        objective_value: 2970,
        warnings: [],
        cost_usd: 0,
        wave7: {
          cutoff_min: 120,
          locked_count: 0,
          frozen_phases: [],
          apply_rules: [{ type: 'unavailable_machines', key: 'unavailable_machines' }],
          frozen_lock_mode: 'hint',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'M01 fuori uso tutto il primo turno' },
        '10.0.98.1',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // ── ASSERT 1 — pipeline emitted lock_relaxing + solved.
    expect(events).toContain('lock_relaxing');
    expect(events).toContain('solved');
    expect(events).not.toContain('error');

    // ── ASSERT 2 — lock_relaxing carries the W9 recompute_mode marker
    // (the W8 `'full_plan_from_scratch'` is retired).
    const lockRelaxing = chunks.find((c) => c.event === 'lock_relaxing')!.data as {
      reason: string;
      recompute_mode: string;
      frozen_count: number;
    };
    expect(lockRelaxing.reason).toBe('infeasible_with_hard_lock');
    expect(lockRelaxing.recompute_mode).toBe('frozen_phases_as_hint');
    // Pre-cutoff phases were preserved, not zeroed out.
    expect(lockRelaxing.frozen_count).toBeGreaterThan(0);

    // ── ASSERT 3 — solved.warnings include both the legacy and W9
    // markers, and NOT the retired W8 `__plan_recomputed_from_scratch`.
    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      status: string;
      warnings: string[];
    };
    expect(solved.warnings).toContain('lock_relaxed_to_soft');
    expect(solved.warnings).toContain('lock_relaxed_to_soft__consolidated_preserved_as_hint');
    expect(solved.warnings).not.toContain('lock_relaxed_to_soft__plan_recomputed_from_scratch');

    // ── ASSERT 4 — backend called exactly twice (original + 1 retry).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // ── ASSERT 5 — first call uses backend default (hard lock):
    // `frozen_phases` populated, NO `frozen_lock_mode` field.
    const firstBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(Array.isArray(firstBody.frozen_phases)).toBe(true);
    expect(firstBody.frozen_phases.length).toBeGreaterThan(0);
    expect(firstBody.frozen_lock_mode).toBeUndefined();
    // F-W10-07: apply-whatif must always disable the L2 warm-start loader
    // so the previous OPTIMAL plan does NOT inject hints into the new
    // solve under the changed constraint set.
    expect(firstBody.force_cold_start).toBe(true);

    // ── ASSERT 6 — KEY contract — retry call carries
    // `frozen_lock_mode: 'hint'` AND the SAME frozen_phases list (the
    // consolidated set is preserved as soft hint, not wiped).
    const retryBody = JSON.parse(
      (fetchMock.mock.calls[1][1] as RequestInit).body as string,
    );
    expect(retryBody.frozen_lock_mode).toBe('hint');
    expect(Array.isArray(retryBody.frozen_phases)).toBe(true);
    expect(retryBody.frozen_phases.length).toBe(firstBody.frozen_phases.length);
    // F-W10-07: retry must also force-cold-start. The retry is the same
    // logical solve attempt with relaxed locks — must not pick up a
    // warm-start from a now-stale plan.
    expect(retryBody.force_cold_start).toBe(true);
  });

  it('machine_unavailability + OPTIMAL on first solve -> NO retry, NO frozen_lock_mode anywhere', async () => {
    // Regression guard: the hint-retry must fire ONLY on INFEASIBLE.
    // If the first solve succeeds, the BFF must not arm the retry path
    // and must not stamp `frozen_lock_mode` on the (single) backend
    // request.
    anthropicCreate.mockResolvedValueOnce(
      fakeHaikuReply({
        intent_id: 'machine_unavailability',
        entities: { machine_id: 'M01', start_min: 0, end_min: 1200 },
        confidence: 'high',
        fallback_reasoning: null,
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
      wave7: {
        cutoff_min: 120,
        locked_count: 3,
        frozen_phases: [],
        apply_rules: [{ type: 'unavailable_machines', key: 'unavailable_machines' }],
      },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'M01 fuori uso tutto il primo turno' },
        '10.0.98.2',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    expect(events).not.toContain('lock_relaxing');
    expect(events).toContain('solved');

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      status: string;
      warnings: string[];
    };
    expect(solved.status).toBe('OPTIMAL');
    expect(solved.warnings).not.toContain('lock_relaxed_to_soft');
    expect(solved.warnings).not.toContain('lock_relaxed_to_soft__consolidated_preserved_as_hint');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(firstBody.frozen_lock_mode).toBeUndefined();
    // F-W10-07: apply-whatif always disables L2 warm-start, even on the
    // happy path where there is no retry.
    expect(firstBody.force_cold_start).toBe(true);
  });
});
