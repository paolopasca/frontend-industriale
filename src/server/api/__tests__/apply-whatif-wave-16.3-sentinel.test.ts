import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 16.3 CRITICAL-1 — Reject sentinel "?" target in apply-whatif retry.
 *
 * Devil-advocate finding (post Wave 16.3 round-2 review):
 *   The backend deterministic extractor emits an `unavailable_machines:
 *   {"?": [...]}` sentinel when the manager utters a target ("linea 99",
 *   "macchina", a typo) that does NOT resolve to a canonical machine_id.
 *   The GRAY_ZONE band surfaces this to the manager with a confirmation
 *   modal. Pre-Wave-16.3, if the manager clicked "Conferma e applica"
 *   (the green CTA), the BFF route at src/routes/api/apply-whatif.ts:597
 *   would assign `rulesForSolve = input.confirmedPayload` without
 *   unwrapping the sentinel, the solver would receive `{"?": [...]}`,
 *   `_apply_unavailable_machines` would log+skip the unknown key, and
 *   the solver would return the BASELINE schedule unchanged. The UI
 *   would render a "solved" event with all-zero deltas, and the manager
 *   would believe a constraint was applied when nothing happened.
 *
 *   This is the same class as F-W10-01 (BFF silent no-op without an
 *   explicit flag).
 *
 *   The fix adds a check before the assignment: if the confirmedPayload
 *   carries `unavailable_machines["?"]`, the route aborts with
 *   `aborted_unsupported` and surfaces a clear warning, forcing the
 *   manager to either cancel or re-issue via the Opus translator
 *   ("Riformula con AI").
 *
 * This test reproduces the GRAY_ZONE confirm path with a sentinel
 * payload and asserts the abort sequence.
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

const baseSolution = {
  status: 'OPTIMAL',
  fasi: [
    { commessa: 'COM-001', macchina: 'M-1', operatore: 'OP-1', start_min: 0, end_min: 60 },
    { commessa: 'COM-007', macchina: 'M-3', operatore: 'OP-2', start_min: 60, end_min: 120 },
  ],
  machines: ['M-1', 'M-3'],
  orders: ['COM-001', 'COM-007'],
};

const baseBody = {
  slug: 'acme-spa',
  originalSolution: baseSolution,
  kpis: { makespan_min: 2880, on_time_rate: 0.85, ritardo_totale_min: 120 },
  whatifText:
    '## 1. Interpretazione\nFermo della linea 99 dalle 14 alle 18.\n## 4. Raccomandazione\nApplicabile.',
  consultationMd: '## Tipo problema: fjsp\n\nFabbrica acme.',
};

function makeRequest(body: unknown, ip = '127.0.0.1'): Request {
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

describe('Wave 16.3 CRITICAL-1 — sentinel "?" rejection on GRAY confirm', () => {
  it('aborts with aborted_unsupported when confirmedPayload contains unavailable_machines["?"]', async () => {
    // The backend extractor emitted GRAY_ZONE with a sentinel-key payload
    // (alias miss on "linea 99"). The frontend modal echoed it back with
    // userConfirmedGrayZone=true. The route MUST refuse to forward this
    // to the solver — it would silently no-op.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        unavailable_machines: {
          '?': [{ start_min: 840, end_min: 1080, raw_target: 'linea 99' }],
        },
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.0.2'));
    expect(res.status).toBe(200);

    const text = await streamToString(res.body!);
    const chunks = parseSse(text);
    const events = chunks.map((c) => c.event);

    // The route MUST NOT call the solver — we want the no-op to be visible.
    expect(fetchMock).not.toHaveBeenCalled();

    // It MUST NOT emit `solving` or `solved` — those would tell the UI a
    // schedule was computed, which is exactly the silent no-op illusion.
    expect(events).not.toContain('solving');
    expect(events).not.toContain('solved');

    // It MUST emit `aborted_unsupported` with the diagnostic warning.
    expect(events).toContain('aborted_unsupported');
    const aborted = chunks.find((c) => c.event === 'aborted_unsupported')!.data as {
      reason: string;
      warnings: string[];
    };
    expect(aborted.reason).toBe('unresolved_machine_target');
    expect(aborted.warnings).toContain('gray_zone_sentinel_target');
    expect(aborted.warnings).toContain('use_opus_fallback_to_disambiguate');

    // It MUST close the stream with `done` so the UI's SSE reader can exit.
    expect(events).toContain('done');
  });

  it('passes through cleanly when confirmedPayload has a real machine_id (no sentinel)', async () => {
    // Sanity: a confirmedPayload with a canonical machine_id should NOT
    // be rejected by the sentinel guard.
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          status: 'OPTIMAL',
          method: 'cp-sat',
          solution: { status: 'OPTIMAL', fasi: [] },
          kpis: { makespan_min: 3120, on_time_rate: 0.78, ritardo_totale_min: 180 },
          objective_value: 3120,
          warnings: [],
          cost_usd: 0,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const body = {
      ...baseBody,
      userConfirmedGrayZone: true,
      confirmedPayload: {
        unavailable_machines: {
          'M-3': [{ start_min: 840, end_min: 1080, label: 'manutenzione' }],
        },
      },
    };

    const res = await invokeRoute(makeRequest(body, '10.0.0.3'));
    expect(res.status).toBe(200);

    const text = await streamToString(res.body!);
    const chunks = parseSse(text);
    const events = chunks.map((c) => c.event);

    // The route MUST proceed to the solver (real machine_id).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toContain('solving');
    expect(events).toContain('solved');
    expect(events).not.toContain('aborted_unsupported');
  });
});
