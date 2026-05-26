import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { AdvisorPanel } from '../AdvisorPanel';

/**
 * Wave 16.3 #37 — mirror of ExplanationPanel coverage. Both panels share the
 * same retry shape (transient → 2 retries → friendly banner) but run against
 * /api/advise. Keeping the test surface independent so a regression in
 * either panel surfaces immediately.
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
  'event: chunk\ndata: {"text":"1. \\ud83d\\udd27 Riduci il setup della macchina M-3 per liberare 90 minuti di capacita."}\n\n',
  'event: done\ndata: {"cost_usd":0.002,"tokens_in":150,"tokens_out":60}\n\n',
].join('');

const SSE_ADVISOR_FAILED = [
  'event: error\ndata: {"code":"advisor_failed","message":"upstream timeout"}\n\n',
].join('');

const SOLUTION = { status: 'OPTIMAL', fasi: [{ id: 'p1' }] };
const KPIS = { makespan_min: 2880, on_time_rate: 0.95 };

describe('AdvisorPanel — retry & error state', () => {
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

  it('streams advice when the BFF succeeds', async () => {
    fetchMock.mockResolvedValueOnce(buildResponse({ kind: 'ok', sseBody: SUCCESS_SSE }));

    render(<AdvisorPanel slug="acme" solution={SOLUTION} kpis={KPIS} />);

    await waitFor(() => {
      expect(screen.getByText(/Riduci il setup della macchina M-3/)).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('automatically retries on a 503 and surfaces the streamed content', async () => {
    fetchMock
      .mockResolvedValueOnce(
        buildResponse({
          kind: 'error_status',
          status: 503,
          body: { error: 'service_unavailable', message: 'overloaded' },
        }),
      )
      .mockResolvedValueOnce(buildResponse({ kind: 'ok', sseBody: SUCCESS_SSE }));

    render(<AdvisorPanel slug="acme" solution={SOLUTION} kpis={KPIS} />);

    await waitFor(
      () => {
        expect(screen.getByText(/Riduci il setup della macchina M-3/)).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('automatically retries when the SSE emits `advisor_failed`', async () => {
    fetchMock
      .mockResolvedValueOnce(buildResponse({ kind: 'ok', sseBody: SSE_ADVISOR_FAILED }))
      .mockResolvedValueOnce(buildResponse({ kind: 'ok', sseBody: SUCCESS_SSE }));

    render(<AdvisorPanel slug="acme" solution={SOLUTION} kpis={KPIS} />);

    await waitFor(
      () => {
        expect(screen.getByText(/Riduci il setup della macchina M-3/)).toBeInTheDocument();
      },
      { timeout: 4000 },
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shows the friendly banner only after the retry budget exhausts', async () => {
    fetchMock.mockResolvedValue(
      buildResponse({
        kind: 'error_status',
        status: 503,
        body: { error: 'service_unavailable', message: 'overloaded' },
      }),
    );

    render(<AdvisorPanel slug="acme" solution={SOLUTION} kpis={KPIS} />);

    await waitFor(
      () => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      },
      { timeout: 6000 },
    );
    expect(screen.getByText(/Consigli non disponibili/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry permanent 4xx errors', async () => {
    fetchMock.mockResolvedValue(
      buildResponse({
        kind: 'error_status',
        status: 400,
        body: { error: 'invalid_body', message: 'kpis: Required' },
      }),
    );

    render(<AdvisorPanel slug="acme" solution={SOLUTION} kpis={KPIS} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears stale error on prop-change re-fetch', async () => {
    fetchMock
      .mockResolvedValueOnce(
        buildResponse({
          kind: 'error_status',
          status: 400,
          body: { error: 'invalid_body', message: 'kpis: Required' },
        }),
      )
      .mockResolvedValueOnce(buildResponse({ kind: 'ok', sseBody: SUCCESS_SSE }));

    const { rerender } = render(
      <AdvisorPanel slug="acme" solution={SOLUTION} kpis={KPIS} />,
    );

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    rerender(
      <AdvisorPanel
        slug="acme"
        solution={SOLUTION}
        kpis={{ ...KPIS, makespan_min: 9000 }}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText(/Riduci il setup della macchina M-3/)).toBeInTheDocument();
    });
  });

  it('renders empty-state when inputs are missing', async () => {
    render(<AdvisorPanel slug={null} solution={null} kpis={{}} />);
    await act(async () => {});

    expect(screen.getByText(/non ancora disponibile/i)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aborts in-flight retries on unmount', async () => {
    fetchMock.mockResolvedValueOnce(
      buildResponse({
        kind: 'error_status',
        status: 503,
        body: { error: 'service_unavailable', message: 'overloaded' },
      }),
    );

    const { unmount } = render(
      <AdvisorPanel slug="acme" solution={SOLUTION} kpis={KPIS} />,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((r) => setTimeout(r, 1500));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
