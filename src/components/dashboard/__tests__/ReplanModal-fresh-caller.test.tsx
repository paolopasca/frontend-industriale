import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReplanModal } from '../ReplanModal';

/**
 * Wave 16.5 B1 (devil-advocate refinement) — seam test / regression guard.
 *
 * The fresh-solve primary path must NOT send currentTimeMin. Day-0 is anchored
 * to min(deadline) of the dataset (data_normalizer.py:379-381), not the system
 * clock, so a wall-clock-derived cutoff would be meaningless: today is usually
 * AFTER the demo deadlines, which would push the cutoff past the horizon,
 * freeze every phase, and leave the solver nothing to reschedule for
 * "M1 rotta" (INFEASIBLE/no-op — worse than replanning from zero).
 *
 * This drives the real ReplanModal with the literal placeholder utterance and
 * asserts the POST to /api/reschedule-fresh carries the baseline but NEVER a
 * currentTimeMin / cushionMin field, so a future "naive now - start_date" fix
 * can't silently reintroduce the cutoff>horizon bug.
 */

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
      cutoff_min: null,
      frozen_count: 0,
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

  it('POSTs slug + message + baseline, and does NOT send a wall-clock cutoff', async () => {
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
    // Regression guard: day-0 is deadline-anchored, so no wall-clock cutoff is
    // sent. Re-adding these naively would push the cutoff past the horizon.
    expect('currentTimeMin' in body).toBe(false);
    expect('cushionMin' in body).toBe(false);
  });

  it('surfaces the result as a full replan from the horizon start', async () => {
    const fetchMock = vi.fn().mockResolvedValue(freshOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();

    render(
      <ReplanModal
        open
        onClose={() => {}}
        companySlug="acme"
        originalSolution={BASELINE}
        onResult={() => {}}
      />,
    );

    await user.type(screen.getByPlaceholderText(/macchina M1/i), 'macchina M1 è rotta');
    await user.click(screen.getByRole('button', { name: /Invia/i }));

    // The assistant reply must make the full-horizon replan explicit so the
    // manager knows the early schedule may have moved (no frozen window).
    await waitFor(() =>
      expect(screen.getByText(/ricalcolato da inizio orizzonte/i)).toBeInTheDocument(),
    );
  });
});
