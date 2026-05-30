import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 16.6 — low-confidence interpreter outcomes (OBSOLETE-PREMISE rewrite of
 * F-W8-07).
 *
 * Legacy premise (F-W8-07): the Haiku intent PARSER returned a confidence and
 * the BFF, on a low-confidence HIT, still solved while tagging
 * `low_confidence_classification` on solved.warnings (+ a structured
 * console.warn), and `unknown + low` cascaded to the Opus translator
 * (Strategy C). The Wave 16.6 closed-set instruction interpreter changed this
 * fundamentally:
 *
 *   - A low/medium-confidence parse is now classified as GRAY by the
 *     deterministic gate (instruction-interpreter.ts: `isGray = confidence !==
 *     'high' || assumption`). The route therefore emits `requires_confirmation`
 *     and STOPS — it does NOT solve, so a `solved` event with a
 *     `low_confidence_classification` warning is no longer produced on this
 *     path (the route's hit-branch low-confidence push is dead code because a
 *     HIT always carries confidence 'high'). The manager confirms the gray
 *     payload to proceed (covered by the gray-zone fast-path elsewhere).
 *   - A high-confidence parse is a HIT and solves cleanly (no warning).
 *   - `unknown` at ANY confidence is a structural REJECT →
 *     `aborted_unsupported`, with NO Opus cascade (the interpreter is
 *     authoritative — verified in apply-whatif-wave7-infeasible.test.ts).
 *
 * These tests are rewritten to assert that real behaviour with equal rigor,
 * preserving each original scenario's distinct utterance/confidence.
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
// whose input is the FLAT entity shape, NOT the legacy parseIntent TEXT block
// with nested `entities`.
function fakeInterpreterReply(input: object) {
  return {
    content: [{ type: 'tool_use', name: 'emit_constraint', input }],
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

describe('F-W8-07 — low_confidence_classification warning', () => {
  it('confidence=low + supported intent → GRAY requires_confirmation, no solve (Wave 16.6)', async () => {
    // OBSOLETE-PREMISE rewrite: a low-confidence parse used to solve with a
    // `low_confidence_classification` warning. The interpreter's deterministic
    // gate now classifies low/medium confidence as GRAY → the route emits
    // `requires_confirmation` and STOPS before the solver. No `solved`, no
    // backend call, no warning. (The manager confirms the gray payload to
    // proceed via the gray-zone fast-path.)
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({
        intent_id: 'machine_unavailability',
        machine_id: 'M02',
        start_min: 720,
        end_min: 1080,
        confidence: 'low',
        assumption: "evento passato ('ieri sera'), assunzione su finestra",
      }),
    );

    // No backend call expected — the gray pause bails before the solver.
    const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected backend call'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'M2 in panne ieri sera' },
        '10.0.97.1',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // Gray pause sequence: parsing_intent → intent_parsed → routed →
    // requires_confirmation → done. No solve, no abort, no error.
    expect(events).toContain('parsing_intent');
    expect(events).toContain('intent_parsed');
    expect(events).toContain('routed');
    expect(events).toContain('requires_confirmation');
    expect(events).toContain('done');
    expect(events).not.toContain('solving');
    expect(events).not.toContain('solved');
    expect(events).not.toContain('aborted_unsupported');
    expect(events).not.toContain('error');

    // The confirmation carries the gated payload + the low confidence so the
    // UI can render the confirm modal.
    const confirm = chunks.find((c) => c.event === 'requires_confirmation')!.data as {
      confidence: string;
      confirmedPayload: { unavailable_machines?: Record<string, unknown> };
    };
    expect(confirm.confidence).toBe('low');
    // M02 is already canonical in this fixture's closed set (machines M01/M02/M03).
    expect(confirm.confirmedPayload.unavailable_machines).toBeDefined();

    // Backend never reached — interpreter is the only LLM call.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
  });

  it('confidence=medium → GRAY requires_confirmation, no solve (Wave 16.6)', async () => {
    // OBSOLETE-PREMISE rewrite: medium confidence used to solve (no warning).
    // It is now GRAY → requires_confirmation, no solve. Distinct scenario
    // preserved (whole-day default assumption).
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({
        intent_id: 'machine_unavailability',
        machine_id: 'M02',
        start_min: 2880,
        end_min: 4320,
        confidence: 'medium',
        assumption: 'whole_day_default_no_explicit_time',
      }),
    );

    const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected backend call'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'M02 in panne gg3' },
        '10.0.97.2',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    expect(events).toContain('requires_confirmation');
    expect(events).not.toContain('solved');
    expect(events).not.toContain('aborted_unsupported');

    const confirm = chunks.find((c) => c.event === 'requires_confirmation')!.data as {
      confidence: string;
    };
    expect(confirm.confidence).toBe('medium');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('confidence=high → HIT solves cleanly, no low_confidence_classification warning', async () => {
    // Still valid post-16.6: a high-confidence parse is a HIT and solves. The
    // `low_confidence_classification` marker must NOT appear (it only ever rode
    // a low/medium HIT, which the gate no longer produces).
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({
        intent_id: 'order_priority',
        order_ids: ['COM-001'],
        confidence: 'high',
      }),
    );

    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({
        status: 'OPTIMAL',
        method: 'cp-sat',
        solution: { 'COM-001': { fasi: [{ macchina: 'M01', start_min: 0, end_min: 60 }] } },
        kpis: { makespan_min: 2900 },
        objective_value: 2900,
        warnings: [],
        cost_usd: 0,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'priorità COM-001' },
        '10.0.97.3',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);
    expect(events).toContain('solved');
    expect(events).not.toContain('requires_confirmation');

    const solved = chunks.find((c) => c.event === 'solved')!.data as {
      warnings: string[];
    };
    expect(solved.warnings).not.toContain('low_confidence_classification');
  });

  it('unknown + confidence=low → reject (aborted_unsupported), NO Opus cascade (Wave 16.6)', async () => {
    // OBSOLETE-PREMISE rewrite: `unknown + low` used to cascade to the Opus
    // translator (Strategy C) as a rescue and tag the low-confidence warning.
    // The closed-set interpreter is now authoritative: `unknown` at ANY
    // confidence is a structural REJECT → aborted_unsupported, with NO second
    // Opus call and no `low_confidence_classification` warning.
    anthropicCreate.mockResolvedValueOnce(
      fakeInterpreterReply({ intent_id: 'unknown', confidence: 'low' }),
    );

    // No backend call — the reject bails before the solver.
    const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected backend call'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await invokeRoute(
      makeRequest(
        { ...baseBody, managerText: 'qualcosa di un po incerto su COM-001' },
        '10.0.97.4',
      ),
    );
    expect(res.status).toBe(200);
    const chunks = parseSse(await streamToString(res.body!));
    const events = chunks.map((c) => c.event);

    // Reject path: aborted_unsupported, never solved.
    expect(events).toContain('aborted_unsupported');
    expect(events).not.toContain('solved');
    // No Opus cascade — translating/translated MUST be absent.
    expect(events).not.toContain('translating');
    expect(events).not.toContain('translated');

    const routed = chunks.find((c) => c.event === 'routed')!.data as { strategy: string };
    expect(routed.strategy).toBe('unsupported');

    // Interpreter only — exactly ONE LLM call, no second Opus call.
    expect(anthropicCreate).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('low-confidence "M2" alias resolves to canonical M02 and GRAYs (no solve, no audit log)', async () => {
    // OBSOLETE-PREMISE rewrite: the legacy audit channel emitted a structured
    // console.warn tagged `low_confidence_classification` on a low-confidence
    // SOLVE. That solve no longer happens — a low-confidence parse is GRAY →
    // requires_confirmation. We assert the real behaviour: (a) no
    // `low_confidence_classification` console.warn is produced on this path,
    // and (b) the alias "M2" the manager typed is canonicalised by the gate to
    // "M02" (the fixture's real id) inside the gray confirmedPayload — pinning
    // the closed-set resolution rather than a vacuous check.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      anthropicCreate.mockResolvedValueOnce(
        fakeInterpreterReply({
          intent_id: 'machine_unavailability',
          machine_id: 'M2',
          start_min: 0,
          confidence: 'low',
          assumption: 'evento passato',
        }),
      );
      // No backend call — gray pause bails before the solver.
      const fetchMock = vi.fn().mockRejectedValue(new Error('unexpected backend call'));
      vi.stubGlobal('fetch', fetchMock);

      const res = await invokeRoute(
        makeRequest(
          { ...baseBody, managerText: 'M2 in panne ieri sera' },
          '10.0.97.5',
        ),
      );
      const chunks = parseSse(await streamToString(res.body!));
      const events = chunks.map((c) => c.event);

      // Gray pause, not a solve.
      expect(events).toContain('requires_confirmation');
      expect(events).not.toContain('solved');
      expect(fetchMock).not.toHaveBeenCalled();

      // CANONICALISATION: the manager typed "M2"; the gate re-resolves it
      // against the closed set (machines M01/M02/M03) to "M02". The gray
      // payload key is therefore the canonical "M02".
      const confirm = chunks.find((c) => c.event === 'requires_confirmation')!.data as {
        confirmedPayload: { unavailable_machines?: Record<string, unknown> };
      };
      const unavail = confirm.confirmedPayload.unavailable_machines ?? {};
      expect(Object.keys(unavail)).toEqual(['M02']);

      // The legacy structured audit log for low_confidence_classification is
      // gone (the route no longer console.warns on this path).
      const lowConfidenceLog = warnSpy.mock.calls.find((call) =>
        call.some(
          (arg) =>
            typeof arg === 'string' && arg.includes('low_confidence_classification'),
        ),
      );
      expect(lowConfidenceLog).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
