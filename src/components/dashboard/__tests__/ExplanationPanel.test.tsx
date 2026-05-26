import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { ExplanationPanel } from '../ExplanationPanel';

/**
 * Wave 16.3 #37 — "explain/advise stuck in error dopo 503→200 retry".
 *
 * Live in Chrome dev (StrictMode + auto-fire after solve) the panel
 * occasionally showed "Servizio AI temporaneamente non disponibile" even
 * though a subsequent /api/explain call returned 200 OK with the proper
 * SSE chunks. We address this in two complementary ways:
 *   (1) client-side exponential-backoff retry inside the panel itself,
 *       so the manager doesn't have to click "Riprova" for transient
 *       upstream 503s; while retrying the panel shows "riprovo..." copy
 *       instead of the destructive error banner.
 *   (2) defence-in-depth: as soon as a real chunk streams from a fresh
 *       attempt, any lingering `error` state is cleared.
 *
 * These tests pin both behaviours.
 */

type StreamScript =
  | { kind: 'ok'; sseBody: string }
  | { kind: 'error_status'; status: number; body?: unknown };

function buildResponse(script: StreamScript): Response {
  if (script.kind === 'error_status') {
    return new Response(
      script.body !== undefined ? JSON.stringify(script.body) : null,
      {
        status: script.status,
        headers: { 'content-type': 'application/json' },
      },
    );
  }
  return new Response(script.sseBody, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

const SUCCESS_SSE = [
  'event: chunk\ndata: {"text":"Pianificazione "}\n\n',
  'event: chunk\ndata: {"text":"OK al 100%."}\n\n',
  'event: done\ndata: {"cost_usd":0.001,"tokens_in":100,"tokens_out":40}\n\n',
].join('');

const SSE_EXPLAINER_FAILED = [
  'event: error\ndata: {"code":"explainer_failed","message":"upstream boom"}\n\n',
].join('');

const SOLUTION = { status: 'OPTIMAL', fasi: [{ id: 'p1' }] };
const KPIS = { makespan_min: 2880, on_time_rate: 0.95 };

// Helper: advance through any pending setTimeout-based backoff sleeps the
// panel scheduled. We use real timers so React's act/waitFor can settle
// async state transitions naturally; the test backoff (≤ 1.05s) is short
// enough that real-time waiting is fine in CI.

describe('ExplanationPanel — retry & error state', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('streams chunks to the user when the BFF succeeds on the first attempt', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ kind: 'ok', sseBody: SUCCESS_SSE }));

    render(<ExplanationPanel slug="acme" solution={SOLUTION} kpis={KPIS} />);

    await waitFor(() => {
      expect(screen.getByText(/Pianificazione OK al 100%\./)).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('automatically retries on a 503 from the BFF and surfaces the streamed content (UI never gets stuck in error)', async () => {
    // First call: 503 transient. Second call: 200 + chunks.
    fetchMock
      .mockResolvedValueOnce(
        buildResponse({
          kind: 'error_status',
          status: 503,
          body: { error: 'service_unavailable', message: 'overloaded' },
        }),
      )
      .mockResolvedValueOnce(buildResponse({ kind: 'ok', sseBody: SUCCESS_SSE }));

    render(<ExplanationPanel slug="acme" solution={SOLUTION} kpis={KPIS} />);

    // After the retry settles, content is visible AND error banner is gone.
    await waitFor(
      () => {
        expect(screen.getByText(/Pianificazione OK al 100%\./)).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('automatically retries when the BFF SSE emits `error` with explainer_failed', async () => {
    // BFF returns 200 status but the SSE stream is just an error event
    // (matches the Wave 16.3 live shape: Anthropic 503 caught server-side,
    // BFF emits SSE error event). The client must still retry transparently.
    fetchMock
      .mockResolvedValueOnce(buildResponse({ kind: 'ok', sseBody: SSE_EXPLAINER_FAILED }))
      .mockResolvedValueOnce(buildResponse({ kind: 'ok', sseBody: SUCCESS_SSE }));

    render(<ExplanationPanel slug="acme" solution={SOLUTION} kpis={KPIS} />);

    await waitFor(
      () => {
        expect(screen.getByText(/Pianificazione OK al 100%\./)).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('surfaces the friendly error banner ONLY after the retry budget is exhausted (2 retries → 3 calls)', async () => {
    // All attempts come back 503 — no recovery possible.
    fetchMock.mockResolvedValue(
      buildResponse({
        kind: 'error_status',
        status: 503,
        body: { error: 'service_unavailable', message: 'overloaded' },
      }),
    );

    render(<ExplanationPanel slug="acme" solution={SOLUTION} kpis={KPIS} />);

    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      },
      { timeout: 6000 },
    );
    expect(screen.getByText(/Spiegazione non disponibile/i)).toBeInTheDocument();
    // 1 initial + 2 retries = 3 calls. No more (no busy-spin).
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry permanent failures (4xx invalid body) — surfaces immediately, single call', async () => {
    fetchMock.mockResolvedValue(
      buildResponse({
        kind: 'error_status',
        status: 400,
        body: { error: 'invalid_body', message: 'kpis: Required' },
      }),
    );

    render(<ExplanationPanel slug="acme" solution={SOLUTION} kpis={KPIS} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    // Single call: the permanent error short-circuits the retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a rate-limit (429) — surfaces immediately so the manager waits the cooldown', async () => {
    // BFF returns 429 with code='rate_limited'. The hour-window cap won't
    // clear within a 4-second retry budget — retrying just wastes attempts.
    fetchMock.mockResolvedValue(
      buildResponse({
        kind: 'error_status',
        status: 429,
        body: { error: 'rate_limited', message: 'Limite superato.' },
      }),
    );

    render(<ExplanationPanel slug="acme" solution={SOLUTION} kpis={KPIS} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears stale error when a prop-change re-fetch streams real content (defence in depth)', async () => {
    // First mount: panel renders error after retries exhaust.
    fetchMock
      .mockResolvedValueOnce(
        buildResponse({ kind: 'error_status', status: 400, body: { error: 'invalid_body', message: 'kpis: Required' } }),
      )
      // Second mount (prop change): success on first attempt.
      .mockResolvedValueOnce(buildResponse({ kind: 'ok', sseBody: SUCCESS_SSE }));

    const { rerender } = render(
      <ExplanationPanel slug="acme" solution={SOLUTION} kpis={KPIS} />,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    rerender(
      <ExplanationPanel
        slug="acme"
        solution={SOLUTION}
        kpis={{ ...KPIS, makespan_min: 2881 }}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText(/Pianificazione OK al 100%\./)).toBeInTheDocument();
    });
  });

  it('renders the empty-state when inputs are missing — no fetch fired, no error', async () => {
    render(<ExplanationPanel slug={null} solution={null} kpis={{}} />);
    await act(async () => {});

    expect(screen.getByText(/non ancora disponibile/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts in-flight retries when the component unmounts (no late setState on dead component)', async () => {
    // First call: 503. Test unmounts during the backoff sleep — no second fetch fires.
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        kind: 'error_status',
        status: 503,
        body: { error: 'service_unavailable', message: 'overloaded' },
      }),
    );

    const { unmount } = render(
      <ExplanationPanel slug="acme" solution={SOLUTION} kpis={KPIS} />,
    );

    // Let the first fetch resolve and the backoff start.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Unmount before the retry budget expires.
    unmount();

    // Wait long enough for any retry to have fired if cleanup wasn't honoured.
    await new Promise((r) => setTimeout(r, 1500));

    // No further fetch — retry was aborted.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
