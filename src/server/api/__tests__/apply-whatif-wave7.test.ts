import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 7 — apply-whatif orchestrator tests.
 *
 * Exercises the new Strategy A / B / C routing introduced when the
 * client sends `managerText` + `currentTimeMin`. The Wave 4.1
 * backward-compat path is covered by ./apply-whatif.test.ts and stays
 * intact: this file ONLY covers Wave 7 paths.
 *
 * Mocks:
 *   - `@anthropic-ai/sdk` for both Haiku (intent-parser) and Opus
 *     (constraint-translator fallback).
 *   - `globalThis.fetch` for the backend resolveTemplate call.
 *
 * Coverage:
 *   1. Strategy A — machine_unavailability becomes a dataset_overrides
 *      payload sent on the backend body. No Opus call.
 *   2. Strategy B — order_priority becomes a `rules.priority_orders`
 *      payload. No Opus call.
 *   3. Strategy C — Haiku says intent_id=unknown → Opus translator
 *      runs as before.
 *   4. Frozen-window — currentTimeMin produces a non-empty frozen_phases
 *      list on the wire.
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

// Wave 16.6 §A — the managerText path now drives the Haiku instruction-
// interpreter, which reads a forced `tool_use` block (name 'emit_constraint')
// whose input is the FLAT entity shape (intent_id + machine_id/order_ids/…),
// NOT the legacy parseIntent TEXT block with nested `entities`. `input` here is
// that flat tool input; the gate re-resolves ids against the plan's closed set
// and builds the canonical rules payload.
function fakeInterpreterReply(input: object, usage?: Partial<{
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}>) {
  return {
    content: [{ type: 'tool_use', name: 'emit_constraint', input }],
    usage: {
      input_tokens: usage?.input_tokens ?? 200,
      output_tokens: usage?.output_tokens ?? 30,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

// Wave 7 baseline uses the nested {commessa: {fasi: [...]}} shape that
// the FJSP solver returns. The router/builder both accept this.
const nestedSolution = {
  'COM-001': {
    fasi: [
      { operazione: 'OP-1', macchina: 'M01', operatore: 'OP-A', start_min: 0, end_min: 60 },
      { operazione: 'OP-2', macchina: 'M02', operatore: 'OP-A', start_min: 60, end_min: 120 },
      { operazione: 'OP-3', macchina: 'M02', operatore: 'OP-A', start_min: 2400, end_min: 2520 },
    ],
  },
  'COM-007': {
    fasi: [
      { operazione: 'OP-1', macchina: 'M03', operatore: 'OP-B', start_min: 0, end_min: 80 },
    ],
  },
  // Wave 16.8: buildSolutionContext reads time_config from originalSolution and
  // the interpreter grounds machine_unavailability's SYMBOLIC day/clock refs
  // against it. A 24h/midnight tc reproduces the legacy absolute minutes
  // (giorno N = N*1440, ora = h*60) so the on-the-wire window is unchanged.
  // With currentTimeMin=120 < 1440 the dayAnchor folds to index 0 ("oggi"=day 0).
  // (extractCommesse ignores this key — it carries no `fasi` array.)
  time_config: { day_length_min: 1440, company_start_hour: 0, start_date: '2026-06-01' },
};

const baseBodyWave7 = {
  slug: 'acme-spa',
  originalSolution: nestedSolution,
  kpis: { makespan_min: 2880, on_time_rate: 0.85 },
  whatifText: '## 1. Interpretazione\n…',
  consultationMd: '## Tipo problema: fjsp\n',
  currentTimeMin: 120,
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

describe('Wave 7 — POST /api/apply-whatif', () => {
  it('Strategy B (machine_unavailability via rule_addition, team-lead 2026-05-22 directive)', async () => {
    // Haiku returns machine_unavailability. Per the catalog change, the
    // primary strategy is now rule_addition (not data_modification), so
    // the BFF ships rules.unavailable_machines directly without any
    // dataset_overrides.
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({
        intent_id: 'machine_unavailability',
        machine_id: 'M01',
        // Wave 16.8: SYMBOLIC. "dalle 12 alle 18" oggi → [720, 1080] on the
        // 24h/midnight tc (start_hour 12 → 720, end_hour 18 → 1080).
        day_ref: 'oggi',
        start_hour: 12,
        end_hour: 18,
        confidence: 'high',
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL',
          method: 'cp-sat',
          solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } },
          kpis: { makespan_min: 3000 },
          objective_value: 3000,
          warnings: [],
          cost_usd: 0,
          wave7: {
            cutoff_min: 150,
            locked_count: 1,
            frozen_phases: [],
            apply_rules: [
              { type: 'unavailable_machine_block', machine_id: 'M01', start_min: 720, end_min: 1080 },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBodyWave7, managerText: 'M1 rotta dalle 12 alle 18' },
        '10.0.7.1',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    expect(events).toContain('parsing_intent');
    expect(events).toContain('intent_parsed');
    expect(events).toContain('routed');
    expect(events).toContain('solving');
    expect(events).toContain('solved');
    expect(events).toContain('done');
    // Opus translator MUST NOT run — Haiku produced a valid intent.
    expect(events).not.toContain('translating');
    expect(events).not.toContain('translated');

    const routed = chunks.find((c) => c.event === 'routed')!.data as { strategy: string };
    expect(routed.strategy).toBe('B');

    // Verify the backend received the works-today rules.unavailable_machines
    // payload. dataset_overrides is NOT sent — the catalog's primary
    // strategy for machine_unavailability is now rule_addition.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.cutoff_min).toBe(150); // 120 + 30
    expect(sentBody.dataset_overrides).toBeUndefined();
    expect(sentBody.rules).toBeDefined();
    expect(sentBody.rules.unavailable_machines).toBeDefined();
    expect(sentBody.rules.unavailable_machines.M01).toEqual([
      { start_min: 720, end_min: 1080 },
    ]);
    expect(Array.isArray(sentBody.frozen_phases)).toBe(true);
    // COM-001/OP-1 ends at 60 ≤ cutoff 150 → frozen. OP-2 ends at 120 ≤ 150 → frozen.
    expect(sentBody.frozen_phases.length).toBe(3);
    const frozenJobs = sentBody.frozen_phases.map((fp: { job_id: string }) => fp.job_id).sort();
    expect(frozenJobs).toContain('COM-001');
    expect(frozenJobs).toContain('COM-007');

    // Anthropic SDK called exactly ONCE (Haiku), not twice (no Opus fallback).
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('Strategy B (order_priority): emits rules.priority_orders without Opus translator', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({
        intent_id: 'order_priority',
        order_ids: ['COM-007'],
        confidence: 'high',
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat',
          solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } }, kpis: { makespan_min: 2700 },
          objective_value: 2700, warnings: [], cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBodyWave7, managerText: 'priorità a COM-007', currentTimeMin: undefined },
        '10.0.7.2',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const routed = chunks.find((c) => c.event === 'routed')!.data as { strategy: string };
    expect(routed.strategy).toBe('B');

    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.rules.priority_orders).toEqual(['COM-007']);
    expect(sentBody.dataset_overrides).toBeUndefined();
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('managerText + unknown intent → aborted_unsupported via interpreter, NO Opus cascade (Wave 16.6)', async () => {
    // OBSOLETE-PREMISE rewrite (Wave 16.6): the legacy premise was
    // "managerText + unknown + low confidence → fall back to the Opus
    // translator (Strategy C)". That cascade no longer exists. When
    // managerText is set, the route ALWAYS runs the closed-set instruction
    // interpreter, which is AUTHORITATIVE: an `intent_id:'unknown'` is a
    // structural reject → `routed` strategy 'unsupported' then
    // `aborted_unsupported`, and the stream ends WITHOUT ever reaching the
    // Opus translator. We pin the replacement behaviour with equal rigor:
    // the interpreter is the ONLY LLM call (no second Opus call), and no
    // translating/translated/solved event appears.
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({ intent_id: 'unknown', confidence: 'low' }),
    );

    // No backend call expected — the reject bails before the solver. A
    // failing fetch impl makes any unexpected call loud.
    const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected backend call'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBodyWave7, managerText: 'aiuto non so cosa fare' },
        '10.0.7.3',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    expect(events).toContain('parsing_intent');
    expect(events).toContain('intent_parsed');
    expect(events).toContain('routed');
    expect(events).toContain('aborted_unsupported');
    // The Opus translator (Strategy C) path must NOT be reached.
    expect(events).not.toContain('translating');
    expect(events).not.toContain('translated');
    expect(events).not.toContain('solving');
    expect(events).not.toContain('solved');

    const routed = chunks.find((c) => c.event === 'routed')!.data as { strategy: string };
    expect(routed.strategy).toBe('unsupported');

    // Interpreter only — exactly ONE LLM call, never a second Opus call.
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Frozen-window: cutoff is currentTimeMin + cushionMin and frozen_phases reflects baseline', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({
        intent_id: 'order_priority',
        order_ids: ['COM-001'],
        confidence: 'high',
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat',
          solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } }, kpis: {},
          objective_value: 0, warnings: [], cost_usd: 0,
          locked_count: 2,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBodyWave7, managerText: 'priorità COM-001', currentTimeMin: 90, cushionMin: 30 },
        '10.0.7.4',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));

    const sentBody = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(sentBody.cutoff_min).toBe(120);
    // COM-001/OP-1 ends at 60 ≤ 120 → frozen. COM-001/OP-2 ends at 120 ≤ 120 → frozen.
    // COM-001/OP-3 starts at 2400 > 120 → not frozen.
    // COM-007/OP-1 ends at 80 ≤ 120 → frozen.
    // F-W8-09 (devils 2026-05-22): seq is 1-based to match backend op["sequenza"] key.
    const seqs = sentBody.frozen_phases.map((fp: { job_id: string; seq: number }) =>
      `${fp.job_id}:${fp.seq}`,
    ).sort();
    expect(seqs).toEqual(['COM-001:1', 'COM-001:2', 'COM-007:1']);

    // The solved event must expose locked_phases for the UI accordion.
    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      locked_phases: Array<{
        commessa: string; operazione: string; macchina: string;
        start_min: number; end_min: number; job_id: string; seq: number;
      }>;
      frozen_count: number;
    };
    expect(solved.frozen_count).toBe(3);
    expect(solved.locked_phases).toHaveLength(3);
    // Each entry exposes both UI-legacy (commessa/operazione/macchina) and
    // backend-required (job_id/seq/machine_id) field names.
    const first = solved.locked_phases[0];
    expect(first.commessa).toBeDefined();
    expect(first.operazione).toBeDefined();
    expect(first.macchina).toBeDefined();
    expect(first.job_id).toBe(first.commessa);
  });

  it('F-W7-02 — INFEASIBLE with frozen_phases triggers soft retry + lock_relaxed_to_soft warning', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({
        intent_id: 'order_priority',
        order_ids: ['COM-001'],
        confidence: 'high',
      }),
    );

    // First backend call: INFEASIBLE with wave7 diagnostics (commit
    // bba231a — apply_rules populated even on INFEASIBLE).
    // Second: OPTIMAL (relaxed lock).
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'INFEASIBLE',
            method: 'cp-sat',
            solution: {},
            kpis: {},
            objective_value: 0,
            warnings: ['cpsat:infeasible'],
            cost_usd: 0,
            wave7: {
              cutoff_min: 120,
              locked_count: 3,
              frozen_phases: [
                { type: 'frozen_phase_locked', job_id: 'COM-001', seq: 0 },
                { type: 'frozen_phase_locked', job_id: 'COM-001', seq: 1 },
                { type: 'frozen_phase_locked', job_id: 'COM-007', seq: 0 },
              ],
              apply_rules: [
                { type: 'priority_orders_applied', priority_jobs: ['COM-001'], pairs_posted: 2 },
              ],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'OPTIMAL',
            method: 'cp-sat',
            solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } },
            kpis: { makespan_min: 2900 },
            objective_value: 2900,
            warnings: [],
            cost_usd: 0,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBodyWave7, managerText: 'priorità COM-001', currentTimeMin: 90, cushionMin: 30 },
        '10.0.7.5',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // The lock_relaxing event carries the failed attempt's diagnostic
    // counts so the UI can render "Locks tentati: 3, Regole tentate: 1".
    const lockRelaxing = chunks.find((c) => c.event === 'lock_relaxing')!.data as {
      reason: string;
      frozen_count: number;
      attempted_locks: number;
      attempted_rules: number;
    };
    expect(lockRelaxing.reason).toBe('infeasible_with_hard_lock');
    expect(lockRelaxing.attempted_locks).toBe(3);
    expect(lockRelaxing.attempted_rules).toBe(1);
    expect(events).toContain('lock_relaxing');
    expect(events).toContain('solved');

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      status: string;
      warnings: string[];
    };
    expect(solved.status).toBe('OPTIMAL');
    expect(solved.warnings).toContain('lock_relaxed_to_soft');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(firstBody.frozen_phases.length).toBeGreaterThan(0);
    // F-W8-06 Wave 9 OPT 1: the retry now preserves the consolidated set
    // as soft hint instead of wiping it (Wave 8 Opt 2 fallback). The
    // payload includes the SAME frozen_phases list plus `frozen_lock_mode: 'hint'`.
    expect(Array.isArray(secondBody.frozen_phases)).toBe(true);
    expect(secondBody.frozen_phases.length).toBe(firstBody.frozen_phases.length);
    expect(secondBody.frozen_lock_mode).toBe('hint');
    // First call must NOT set frozen_lock_mode — the backend default 'hard'
    // is the intended behaviour for the initial solve.
    expect(firstBody.frozen_lock_mode).toBeUndefined();
  });

  it('F-W7-04 — concurrent apply-whatif on same slug from different IPs returns 409 slug_conflict', async () => {
    let release: (() => void) | null = null;
    const pending = new Promise<void>((r) => { release = r; });
    anthropicCreate.mockImplementation(async () => {
      await pending;
      return fakeInterpreterReply({
        intent_id: 'order_priority',
        order_ids: ['COM-001'],
        confidence: 'high',
      });
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        status: 'OPTIMAL', method: 'cp-sat',
        solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } }, kpis: {}, objective_value: 0,
        warnings: [], cost_usd: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const firstReq = invokeRoute(
      makeRequest(
        { ...baseBodyWave7, slug: 'acme-spa', managerText: 'priorità COM-001' },
        '10.0.7.6',
      ),
    );
    await new Promise<void>((r) => setTimeout(r, 20));

    const secondRes = await invokeRoute(
      makeRequest(
        { ...baseBodyWave7, slug: 'acme-spa', managerText: 'priorità COM-001' },
        '10.0.7.7',
      ),
    );
    expect(secondRes.status).toBe(409);
    const errBody = await secondRes.json() as { error: string };
    expect(errBody.error).toBe('slug_conflict');

    if (release) (release as () => void)();
    const firstRes = await firstReq;
    await streamToString(firstRes.body!);
  });

  it('F-W7-08 — machine_unavailability under Strategy B echoes the canonical applied rule (Wave 16.6)', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({
        intent_id: 'machine_unavailability',
        machine_id: 'M02',
        // Wave 16.8: SYMBOLIC. "domani dalle 12 alle 18" → day index 1 (anchor 0)
        // on the 24h/midnight tc → [1*1440+720, 1*1440+1080] = [2160, 2520],
        // the exact window the applied_rules assertion below pins.
        day_ref: 'domani',
        start_hour: 12,
        end_hour: 18,
        confidence: 'high',
      }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'OPTIMAL', method: 'cp-sat',
        solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } }, kpis: { makespan_min: 3000 },
        objective_value: 3000, warnings: [], cost_usd: 0,
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBodyWave7, managerText: 'M02 rotta dalle 12 alle 18' },
        '10.0.7.8',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      dataset_overrides_summary: string[];
      strategy: string;
      applied_rules: { unavailable_machines?: Record<string, Array<{ start_min: number; end_min: number }>> };
    };
    // OBSOLETE-PREMISE rewrite (Wave 16.6): the legacy premise was that
    // machine_unavailability under Strategy B populated
    // `dataset_overrides_summary` (the dead Strategy A audit channel). That
    // channel is gone — `dataset_overrides_summary` is now always empty. The
    // REPLACEMENT audit signal is `applied_rules`, the canonical rules slot
    // the interpreter built; the UI appends it to the ledger. Assert the same
    // facts (M02 + 2160 + 2520) on that authoritative channel, plus strategy B.
    expect(solved.strategy).toBe('B');
    // M02 is already canonical in this fixture's closed set (machines = M01/M02/M03).
    expect(solved.applied_rules.unavailable_machines).toBeDefined();
    expect(solved.applied_rules.unavailable_machines!.M02).toEqual([
      { start_min: 2160, end_min: 2520 },
    ]);
  });

  it('Wave7 envelope: reads locked_count from response.wave7.locked_count and modified_count from apply_rules.length', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({
        intent_id: 'order_priority',
        order_ids: ['COM-001'],
        confidence: 'high',
      }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'OPTIMAL', method: 'cp-sat',
        solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } }, kpis: {},
        objective_value: 0, warnings: [], cost_usd: 0,
        wave7: {
          cutoff_min: 120,
          locked_count: 3,
          frozen_phases: [
            { type: 'frozen_phase_locked', job_id: 'COM-001', seq: 0 },
            { type: 'frozen_phase_locked', job_id: 'COM-001', seq: 1 },
            { type: 'frozen_phase_locked', job_id: 'COM-007', seq: 0 },
          ],
          apply_rules: [
            { type: 'priority_orders_applied', priority_jobs: ['COM-001'], pairs_posted: 2 },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBodyWave7, managerText: 'priorità COM-001', currentTimeMin: 90, cushionMin: 30 },
        '10.0.7.9',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      locked_count: number;
      modified_count: number;
      wave7: { locked_count: number; apply_rules: unknown[] } | null;
    };
    expect(solved.locked_count).toBe(3);
    expect(solved.modified_count).toBe(1);
    expect(solved.wave7).not.toBeNull();
    expect(solved.wave7!.locked_count).toBe(3);
    expect(solved.wave7!.apply_rules).toHaveLength(1);
  });

  it('Wave7 envelope: modified_count excludes skipped and passthrough entries (backend caveat)', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({
        intent_id: 'order_priority',
        order_ids: ['COM-001'],
        confidence: 'high',
      }),
    );
    // Mix of applied + skipped + passthrough entries.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'OPTIMAL', method: 'cp-sat',
        solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } }, kpis: {},
        objective_value: 0, warnings: [], cost_usd: 0,
        wave7: {
          cutoff_min: 120,
          locked_count: 0,
          frozen_phases: [],
          apply_rules: [
            { type: 'unavailable_machine_block', machine_id: 'M01', start_min: 720, end_min: 1080 },
            { type: 'priority_orders_applied', priority_jobs: ['COM-001'], pairs_posted: 2 },
            { type: 'deadline_change_applied', job_id: 'COM-002', new_deadline_min: 1440 },
            { type: 'unavailable_machine_skipped', machine_id: 'M99', reason: 'unknown_machine' },
            { type: 'priority_order_skipped', job_id: 'COM-XXX' },
            { type: 'extra_capacity_data_layer_passthrough', warning: 'use dataset_overrides' },
            { type: 'shift_changes_data_layer_passthrough', warning: 'use dataset_overrides' },
            { type: 'apply_rules_failed', error: 'something_bad' },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBodyWave7, managerText: 'priorità COM-001' },
        '10.0.7.14',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      modified_count: number;
      skipped_rules_count: number;
      wave7: { apply_rules: unknown[] } | null;
    };
    // 3 applied: unavailable_machine_block + priority_orders_applied + deadline_change_applied
    // 5 not-applied: 2 *_skipped + 2 *_data_layer_passthrough + 1 apply_rules_failed
    expect(solved.modified_count).toBe(3);
    expect(solved.skipped_rules_count).toBe(5);
    // Raw envelope still passes through unfiltered (devil/UI can introspect).
    expect(solved.wave7!.apply_rules).toHaveLength(8);
  });

  it('Wave7 envelope: locked_count defaults to 0 when backend returns no wave7 field (legacy/Wave 4.1)', async () => {
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({
        intent_id: 'order_priority',
        order_ids: ['COM-001'],
        confidence: 'high',
      }),
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({
        status: 'OPTIMAL', method: 'cp-sat',
        solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } }, kpis: {},
        objective_value: 0, warnings: [], cost_usd: 0,
        // no wave7 field — backend ran in legacy mode
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBodyWave7, managerText: 'priorità COM-001' },
        '10.0.7.10',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      locked_count: number;
      modified_count: number;
      wave7: unknown;
    };
    expect(solved.locked_count).toBe(0);
    expect(solved.modified_count).toBe(0);
    expect(solved.wave7).toBeNull();
  });

  it('Watchdog (w7-tester finding): slug lock self-heals after solve-timeout + 30s grace if cleanup never fires', async () => {
    // Repro the leak: simulate a backend fetch that never resolves AND
    // a client that never reads/cancels the SSE stream. Both the normal
    // finally cleanup and cancel() would not fire in this case, so the
    // slug lock would leak without the watchdog.
    //
    // Fake timers let us fast-forward past the watchdog deadline.
    vi.useFakeTimers();
    try {
      anthropicCreate.mockResolvedValueOnce(
        fakeInterpreterReply({
          intent_id: 'order_priority',
          order_ids: ['COM-001'],
          confidence: 'high',
        }),
      );
      // A fetch that never resolves — simulates a hung backend.
      const fetchMock = vi.fn().mockImplementation(() => new Promise(() => undefined));
      vi.stubGlobal('fetch', fetchMock);

      const slug = 'tester-leak-test';
      // First request: starts the apply-whatif, hangs on backend.
      const firstResPromise = invokeRoute(
        makeRequest({ ...baseBodyWave7, slug, managerText: 'priorità COM-001' }, '10.0.7.11'),
      );
      // Pump microtasks so the route runs up to fetch().
      await vi.advanceTimersByTimeAsync(50);

      // Verify second request is locked out NOW (slug_conflict).
      const secondResLocked = await invokeRoute(
        makeRequest({ ...baseBodyWave7, slug, managerText: 'priorità COM-001' }, '10.0.7.12'),
      );
      expect(secondResLocked.status).toBe(409);
      expect((await secondResLocked.json() as { error: string }).error).toBe('slug_conflict');

      // Fast-forward past the watchdog deadline (devils F-W8-05 2026-05-22:
      // budget is now SOLVE_TIMEOUT_MS * 2 + 30s = 150s to cover the
      // F-W7-02 retry path; previously was 90s which could fire mid-retry).
      await vi.advanceTimersByTimeAsync(151_000);

      // Now a third request for the same slug should succeed (lock self-healed).
      // Provide a resolving backend so this one completes.
      fetchMock.mockImplementationOnce(() => Promise.resolve(
        new Response(JSON.stringify({
          status: 'OPTIMAL', method: 'cp-sat',
          solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } }, kpis: {}, objective_value: 0, warnings: [], cost_usd: 0,
        }), { status: 200, headers: { 'content-type': 'application/json' } }),
      ));
      // Re-arm Haiku reply for the third request.
      anthropicCreate.mockResolvedValueOnce(
        fakeInterpreterReply({
          intent_id: 'order_priority',
          order_ids: ['COM-001'],
          confidence: 'high',
        }),
      );
      const thirdRes = await invokeRoute(
        makeRequest({ ...baseBodyWave7, slug, managerText: 'priorità COM-001' }, '10.0.7.13'),
      );
      expect(thirdRes.status).toBe(200); // not 409 → lock cleared

      // Cleanup the hanging first request (cancel its stream so vitest exits).
      try { (await firstResPromise).body?.cancel(); } catch { /* already cancelled */ }
    } finally {
      vi.useRealTimers();
    }
  });
});
