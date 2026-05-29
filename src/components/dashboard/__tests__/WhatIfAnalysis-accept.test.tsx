import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Wave 16.5 A3 — "Accetta" updates the dashboard with a fully-shaped plan.
 *
 * Regression target: Wave 16.4 A7 fed `onAcceptResult` only solution+kpis
 * (the accept-candidate envelope), losing time_config / maintenance /
 * operator_config. `adaptResult` reads those off the result root, so the
 * Gantt/KPI/OperationalPlan rendered degraded (minute-counter labels, no
 * maintenance shading, all operators "Mattina"). The fix merges the
 * candidate's solution+kpis OVER the original full backend envelope.
 *
 * We drive the component through the apply-whatif SSE stream (mocked) into
 * the `done` state, click "Accetta", and assert the object handed to
 * `onAcceptResult` carries BOTH the candidate plan AND the original
 * time_config/operator_config/maintenance.
 */

// Scripted SSE events keyed by endpoint URL. /api/whatif must yield a
// non-empty analysis (so the "Esegui" CTA enables); /api/apply-whatif
// yields a solved candidate then done (so SolutionDiff renders).
const WHATIF_EVENTS = [
  { event: 'chunk', data: { text: 'Analisi di esempio. ' } },
  { event: 'chunk', data: { text: 'Raccomandazione: procedi.' } },
  { event: 'done', data: { cost_usd: 0.001 } },
];

// The what-if moved the operation onto machine M02 but kept operator OP-03,
// so we can observe that the operator shift is hydrated from the ORIGINAL
// operator_config preserved by the merge (OP-03 → pomeriggio).
const CANDIDATE_SOLUTION = {
  'COM-001': {
    fasi: [
      {
        operazione: 'Taglio',
        macchina: 'M02',
        operatore: 'OP-03',
        start_min: 60,
        end_min: 180,
        processing_min: 100,
        setup_min: 20,
      },
    ],
    ritardo_min: 0,
    scadenza_min: 960,
    priorita: 5,
  },
};

// newKpis carries a nested `carico_macchine` dict at runtime (the very
// shape that motivated the A2 Zod fix) to prove the merge passes it through
// without choking adaptResult / the accept path.
const CANDIDATE_KPIS = {
  makespan_min: 180,
  tardiness_totale_min: 0,
  costo_totale_operatori: 50,
  costo_totale_setup: 10,
  carico_macchine: { M02: 120 },
} as unknown as Record<string, number>;

const APPLY_EVENTS = [
  { event: 'translating', data: {} },
  { event: 'solving', data: {} },
  {
    event: 'solved',
    data: {
      newSolution: CANDIDATE_SOLUTION,
      newKpis: CANDIDATE_KPIS,
      deltaKpis: {},
      warnings: ['lock_relaxed_to_soft'],
      status: 'OPTIMAL',
      objective_value: 1234,
      strategy: 'B',
      locked_count: 0,
      modified_count: 1,
      skipped_rules_count: 0,
      frozen_count: 0,
    },
  },
  { event: 'done', data: { cost_usd: 0.002 } },
];

vi.mock('@/lib/streamingFetch', () => ({
  // Branch on the endpoint so the analyze and apply phases get distinct
  // scripted streams.
  sseStream: vi.fn(async function* (url: string) {
    const events = url.includes('/api/apply-whatif') ? APPLY_EVENTS : WHATIF_EVENTS;
    for (const e of events) {
      yield e;
    }
  }),
  friendlyErrorMessage: (e: { message?: string }) => e?.message ?? null,
}));

import { WhatIfAnalysis } from '../WhatIfAnalysis';

// The original full backend envelope the dashboard was rendering BEFORE the
// what-if. adaptResult reads time_config / maintenance / operator_config off
// this root; the merge must preserve them.
const ORIGINAL_BACKEND_RESULT = {
  status: 'OPTIMAL',
  solution: {
    'COM-001': {
      fasi: [
        {
          operazione: 'Taglio',
          macchina: 'M01',
          operatore: 'OP-03',
          start_min: 0,
          end_min: 120,
          processing_min: 100,
          setup_min: 20,
        },
      ],
      ritardo_min: 0,
      scadenza_min: 960,
      priorita: 5,
    },
  },
  kpis: { makespan_min: 120 },
  time_config: {
    company_start_hour: 6,
    company_end_hour: 22,
    day_length_min: 960,
    start_date: '2026-04-01',
    start_weekday: 2,
  },
  maintenance: { M01: [5] },
  operator_config: [{ operatore_id: 'OP-03', turno: 'pomeriggio', macchine: ['M01'] }],
  cost_usd: 0,
};

// The `solution`/`kpis` props are the AiInputs-shaped values the route
// passes; for this test they only need to satisfy planReady (truthy
// solution + non-empty kpis).
const SOLUTION_PROP = { status: 'OPTIMAL', fasi: [{ commessa: 'COM-001' }], commesse: {} };
const KPIS_PROP = { makespan_min: 120 };

describe('WhatIfAnalysis — Accetta merges candidate over original (Wave 16.5 A3)', () => {
  beforeEach(() => {
    // Audit echo to /api/accept-candidate is fire-and-forget; stub a 200.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true, result: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function driveToCandidate() {
    const user = userEvent.setup();
    const onAcceptResult = vi.fn();
    render(
      <WhatIfAnalysis
        slug="acme-spa"
        solution={SOLUTION_PROP}
        kpis={KPIS_PROP}
        onAcceptResult={onAcceptResult}
        originalBackendResult={ORIGINAL_BACKEND_RESULT}
      />,
    );

    // 1) Analyze a scenario → produces the analysis text → enables "Esegui".
    await user.type(
      screen.getByRole('textbox', { name: /scenario what-if/i }),
      'Fermo M02 dalle 14 alle 18',
    );
    await user.click(screen.getByTestId('whatif-analyze'));
    await waitFor(() =>
      expect(screen.getByTestId('whatif-apply')).toBeInTheDocument(),
    );

    // 2) Esegui → apply-whatif SSE → solved → done → SolutionDiff appears.
    await user.click(screen.getByTestId('whatif-apply'));
    await waitFor(() =>
      expect(screen.getByTestId('solution-diff-accept')).toBeInTheDocument(),
    );

    return { user, onAcceptResult };
  }

  it('hands onAcceptResult a merged plan: candidate solution+kpis + original time_config/maintenance/operator_config', async () => {
    const { user, onAcceptResult } = await driveToCandidate();

    await user.click(screen.getByTestId('solution-diff-accept'));

    await waitFor(() => expect(onAcceptResult).toHaveBeenCalledTimes(1));
    const merged = onAcceptResult.mock.calls[0][0] as Record<string, unknown>;

    // Candidate plan swapped in.
    expect(merged.solution).toEqual(CANDIDATE_SOLUTION);
    expect(merged.kpis).toEqual(CANDIDATE_KPIS);
    expect(merged.status).toBe('OPTIMAL');

    // Original render context preserved — this is the whole point of A3.
    expect(merged.time_config).toEqual(ORIGINAL_BACKEND_RESULT.time_config);
    expect(merged.maintenance).toEqual(ORIGINAL_BACKEND_RESULT.maintenance);
    expect(merged.operator_config).toEqual(ORIGINAL_BACKEND_RESULT.operator_config);
  });

  it('produces a shape adaptResult consumes whole (deterministic-json path renders candidate machines + original shifts)', async () => {
    const { user, onAcceptResult } = await driveToCandidate();
    await user.click(screen.getByTestId('solution-diff-accept'));
    await waitFor(() => expect(onAcceptResult).toHaveBeenCalledTimes(1));
    const merged = onAcceptResult.mock.calls[0][0];

    // Feed the merged envelope through the real adapter exactly as the route
    // does (method 'deterministic-json'). It must render the candidate plan
    // AND hydrate the operator shift from the original operator_config.
    const { adaptResult } = await import('@/data/resultAdapter');
    const dash = adaptResult(merged, 'deterministic-json');

    // Candidate machine M02 is present (not the original M01-only plan).
    expect(dash.machines.map((m) => m.id)).toContain('M02');
    // Operator shift hydrated from the ORIGINAL operator_config (pomeriggio).
    const op03 = dash.operators.find((o) => o.id === 'OP-03');
    expect(op03?.shift).toBe('Pomeriggio');
    // time_config survived → costUsd + kpis wired from candidate.
    expect(dash.kpis.costoTotale).toBe(60); // 50 operatori + 10 setup
  });

  it('still updates the dashboard even if the audit echo fails (fire-and-forget)', async () => {
    // Make the accept-candidate audit POST reject.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const { user, onAcceptResult } = await driveToCandidate();
    await user.click(screen.getByTestId('solution-diff-accept'));

    // The plan update must NOT depend on the audit echo succeeding.
    await waitFor(() => expect(onAcceptResult).toHaveBeenCalledTimes(1));
    const merged = onAcceptResult.mock.calls[0][0] as Record<string, unknown>;
    expect(merged.solution).toEqual(CANDIDATE_SOLUTION);
  });
});
