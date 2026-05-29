import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReplanModal } from '../ReplanModal';

/**
 * Wave 16.5 B1 (devil-advocate HIGH + test-gaming) — seam test.
 *
 * The BFF reschedule-fresh tests pass currentTimeMin EXPLICITLY, so they
 * prove the freeze works given the field but NOT that the real caller sends
 * it. This test drives the actual ReplanModal fresh-solve primary path with
 * the literal placeholder utterance ("macchina M1 è rotta, risolvi") — which
 * carries NO temporal phrase — and asserts the POST body to
 * /api/reschedule-fresh contains a derived currentTimeMin > 0.
 *
 * Without the Wave 16.5 fix this body omitted currentTimeMin, so the BFF
 * cutoff was undefined and the solver reshuffled already-completed work
 * (regression class F-W10-01: tests must mirror the real caller shape).
 */

// Baseline anchored at 06:00 on a fixed date with time_config — exactly the
// shape backendResult carries for deterministic-json.
const START_DATE = '2026-06-01';
const BASELINE = {
  status: 'OPTIMAL',
  time_config: { start_date: START_DATE, company_start_hour: 6, day_length_min: 960 },
  solution: {
    'COM-001': {
      fasi: [
        { operazione: 'Taglio', macchina: 'M-1', operatore: 'W-1', start_min: 0, end_min: 120 },
      ],
    },
  },
  kpis: {},
};

function freshOkResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      code: 'solved_fresh',
      cutoff_min: 480,
      frozen_count: 1,
      result: {
        status: 'OPTIMAL',
        method: 'deterministic-template',
        solution: {},
        kpis: {},
        objective_value: 0,
        warnings: [],
        cost_usd: 0,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('ReplanModal fresh-solve primary path (real caller shape)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('derives currentTimeMin from the baseline time_config and POSTs it', async () => {
    // Pin "now" to 14:00 on the start date → 8h after the 06:00 anchor = 480 min.
    // Mock only Date.now (not the whole timer system) so userEvent + React
    // effects keep real timers and don't deadlock.
    const nowMs = Date.parse(`${START_DATE}T14:00:00`);
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);

    const fetchMock = vi.fn().mockResolvedValue(freshOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();

    render(
      <ReplanModal
        open
        onClose={() => {}}
        companySlug="acme"
        originalSolution={BASELINE}
        // solverMethod undefined → usesFreshSolve true (the product default).
        onResult={() => {}}
      />,
    );

    const textarea = screen.getByPlaceholderText(/macchina M1/i);
    await user.type(textarea, 'macchina M1 è rotta, risolvi');
    await user.click(screen.getByRole('button', { name: /Invia/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/reschedule-fresh');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.slug).toBe('acme');
    expect(body.message).toBe('macchina M1 è rotta, risolvi');
    expect(body.baselineSolution).toBeTruthy();
    // The crux: the real caller derives and sends currentTimeMin (8h = 480).
    expect(body.currentTimeMin).toBe(480);
  });

  it('omits currentTimeMin when the baseline carries no derivable anchor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(freshOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();

    render(
      <ReplanModal
        open
        onClose={() => {}}
        companySlug="acme"
        // No time_config, no start_datetime on fasi → anchor not derivable.
        originalSolution={{ solution: { 'COM-001': { fasi: [{ macchina: 'M-1' }] } } }}
        onResult={() => {}}
      />,
    );

    await user.type(screen.getByPlaceholderText(/macchina M1/i), 'macchina M1 è rotta');
    await user.click(screen.getByRole('button', { name: /Invia/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // Never send 0 (no-lock = same bug) — the field must be absent entirely.
    expect('currentTimeMin' in body).toBe(false);
  });
});
