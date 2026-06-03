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

  // Wave 16.6 §C — the fresh-solve HIT echoes `applied_rules`; the modal must
  // forward them as the 2nd arg of onResult so the parent appends them to the
  // applied-rules ledger (cumulative constraints across What-If/Ripianifica).
  it('forwards applied_rules to onResult so the parent can ledger them', async () => {
    const onResult = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          code: 'solved_fresh',
          cutoff_min: null,
          frozen_count: 0,
          applied_rules: { unavailable_machines: { 'M-1': [{ start_min: 0, end_min: 480 }] } },
          result: {
            status: 'OPTIMAL', method: 'deterministic-template', solution: {},
            kpis: {}, objective_value: 0, warnings: [], cost_usd: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(
      <ReplanModal open onClose={() => {}} companySlug="acme" originalSolution={BASELINE} onResult={onResult} />,
    );

    await user.type(screen.getByPlaceholderText(/macchina M1/i), 'macchina M1 è rotta, risolvi');
    await user.click(screen.getByRole('button', { name: /Invia/i }));

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    // 2nd arg carries the extracted rule slot for the ledger.
    expect(onResult.mock.calls[0][1]).toEqual({
      unavailable_machines: { 'M-1': [{ start_min: 0, end_min: 480 }] },
    });
  });

  // Wave 17 M3 — the fresh-solve route returns ok:true and passes
  // solveResult.status straight through, so an INFEASIBLE solve arrives as
  // { ok:true, result:{ status:'INFEASIBLE', solution:{} } }. The modal must
  // NOT render a green "Piano ricalcolato ... Stato: INFEASIBLE" (a solve that
  // produced no plan is not a success); it must say the constraint makes the
  // plan infeasible, distinct from an extraction failure, and NOT push the
  // empty result to the dashboard.
  it('reports INFEASIBLE as a failure, not a successful replan, and applies no result', async () => {
    const onResult = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          code: 'solved_fresh',
          cutoff_min: null,
          frozen_count: 0,
          result: {
            status: 'INFEASIBLE',
            method: 'deterministic-template',
            solution: {},
            kpis: {},
            objective_value: null,
            warnings: [],
            cost_usd: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(
      <ReplanModal open onClose={() => {}} companySlug="acme" originalSolution={BASELINE} onResult={onResult} />,
    );

    await user.type(screen.getByPlaceholderText(/macchina M1/i), 'macchina M1 è rotta, risolvi');
    await user.click(screen.getByRole('button', { name: /Invia/i }));

    // Failure message names infeasibility, NOT a green "ricalcolato".
    await waitFor(() =>
      expect(screen.getByText(/non.*soluzione|infeasible|non è risolvibile|vincoli incompatibili/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/Piano ricalcolato/i)).not.toBeInTheDocument();
    // It must be distinct from the extraction-failure copy.
    expect(screen.queryByText(/estrazione vincolo fallita/i)).not.toBeInTheDocument();
    // The empty INFEASIBLE result must NOT be applied to the dashboard.
    expect(onResult).not.toHaveBeenCalled();
  });

  // Wave 17 M3 regression — a healthy OPTIMAL replan must STILL render the
  // success message even when the test fixture uses an empty solution map
  // (the existing fresh-caller fixtures do this). The guard must key on the
  // failure status, not on emptiness, so it does not swallow real successes.
  it('still reports OPTIMAL as a successful replan (no false-failure)', async () => {
    const onResult = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(freshOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(
      <ReplanModal open onClose={() => {}} companySlug="acme" originalSolution={BASELINE} onResult={onResult} />,
    );

    await user.type(screen.getByPlaceholderText(/macchina M1/i), 'macchina M1 è rotta');
    await user.click(screen.getByRole('button', { name: /Invia/i }));

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/ricalcolato/i)).toBeInTheDocument();
  });

  // Wave 16.5-RE2 — ask-flow. When the BFF returns code 'needs_day', the modal
  // must ask which plan-day it is and NOT propagate any result to the
  // dashboard (no recalculation). Mirrors the BFF guarantee that no solve ran.
  it('asks for the plan-day and does NOT apply a result on needs_day', async () => {
    const onResult = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ ok: false, code: 'needs_day', rationale: 'manca il giorno' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(
      <ReplanModal open onClose={() => {}} companySlug="acme" originalSolution={BASELINE} onResult={onResult} />,
    );

    await user.type(screen.getByPlaceholderText(/macchina M1/i), 'm1 rotta oggi');
    await user.click(screen.getByRole('button', { name: /Invia/i }));

    await waitFor(() =>
      expect(screen.getByText(/che giorno è oggi nel piano/i)).toBeInTheDocument(),
    );
    // No dashboard update — the manager must answer the day first.
    expect(onResult).not.toHaveBeenCalled();
  });

  // Wave 16.5-RE2 — when a day anchor froze the past, the reply names the day
  // so the manager knows the earlier days were preserved (not reshuffled).
  it('reports "dal giorno N" when the BFF resolved a day_anchor', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          code: 'solved_fresh',
          cutoff_min: 960,
          cutoff_source: 'day_anchor',
          day_anchor: 2,
          frozen_count: 3,
          result: {
            status: 'OPTIMAL', method: 'deterministic-template', solution: {},
            kpis: {}, objective_value: 0, warnings: [], cost_usd: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(
      <ReplanModal open onClose={() => {}} companySlug="acme" originalSolution={BASELINE} onResult={() => {}} />,
    );

    await user.type(screen.getByPlaceholderText(/macchina M1/i), 'siamo al giorno 2, m1 rotta');
    await user.click(screen.getByRole('button', { name: /Invia/i }));

    await waitFor(() =>
      expect(screen.getByText(/ricalcolato dal giorno 2/i)).toBeInTheDocument(),
    );
  });

  // Wave 16.5 M-1 (devil) — the defensive reschedule-fresh path can return
  // day_anchor>=2 with frozen_count=0 / cutoff_min=null (baseline lacks
  // time_config.day_length_min → nothing could be frozen). The reply must NOT
  // claim "giorni precedenti congelati" then — that lies to the manager. It
  // must name the day but state plainly that nothing was frozen.
  it('does NOT claim a freeze when day_anchor>=2 but frozen_count=0', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          code: 'solved_fresh',
          cutoff_min: null,
          cutoff_source: 'none',
          day_anchor: 2,
          frozen_count: 0,
          result: {
            status: 'OPTIMAL', method: 'deterministic-template', solution: {},
            kpis: {}, objective_value: 0, warnings: [], cost_usd: 0,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const user = userEvent.setup();
    render(
      <ReplanModal open onClose={() => {}} companySlug="acme" originalSolution={BASELINE} onResult={() => {}} />,
    );

    await user.type(screen.getByPlaceholderText(/macchina M1/i), 'siamo al giorno 2, m1 rotta');
    await user.click(screen.getByRole('button', { name: /Invia/i }));

    // The honest message: names the day, explicitly says nothing was frozen.
    await waitFor(() =>
      expect(screen.getByText(/nessun giorno congelato/i)).toBeInTheDocument(),
    );
    // The lie must be absent: no "giorni precedenti congelati" claim.
    expect(screen.queryByText(/giorni precedenti congelati/i)).not.toBeInTheDocument();
  });
});
