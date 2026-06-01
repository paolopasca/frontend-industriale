import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Wave 16.6 (Option A) — the inherited-constraints panel.
 *
 * Root cause of the "anticipo COM-007 → tutto a G2" surprise: the applied-rules
 * ledger silently folds every prior accepted reschedule/what-if into the next
 * What-If (priorRules). Stale "M01 ferma giorno 1" + "COM-012 prioritaria" from
 * earlier experiments forced every order to day 2 — invisibly. Option A keeps
 * the (intentional) carry-over but SHOWS it and lets the manager clear it.
 *
 * These tests assert the panel surfaces the carried constraints and the
 * "Azzera" button calls back to the parent (which clears the ledger).
 */

vi.mock('@/lib/streamingFetch', () => ({
  sseStream: vi.fn(async function* () {
    // no events needed — these tests never run an analysis/apply.
  }),
  friendlyErrorMessage: (e: { message?: string }) => e?.message ?? null,
}));

import { WhatIfAnalysis } from '../WhatIfAnalysis';

const SOLUTION_PROP = { status: 'OPTIMAL', fasi: [{ commessa: 'COM-001' }], commesse: {} };
const KPIS_PROP = { makespan_min: 120 };

// The EXACT folded priorRules captured live from the failing session.
const PRIOR_RULES = {
  unavailable_machines: {
    M02: [{ start_min: 1440, end_min: 2880 }],
    M01: [{ start_min: 0, end_min: 960, date: '2026-04-01' }],
  },
  day_anchor: 1,
  priority_orders: ['COM-012', 'COM-007'],
};

describe('WhatIfAnalysis — inherited-constraints panel (Wave 16.6 Option A)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: true }), {
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

  it('surfaces every carried constraint in plain Italian', () => {
    render(
      <WhatIfAnalysis
        slug="acme-spa"
        solution={SOLUTION_PROP}
        kpis={KPIS_PROP}
        onAcceptResult={vi.fn()}
        originalBackendResult={{ status: 'OPTIMAL', solution: {}, kpis: {} }}
        priorRules={PRIOR_RULES}
        onClearPriorRules={vi.fn()}
      />,
    );
    const panel = screen.getByTestId('whatif-inherited-constraints');
    expect(panel).toBeInTheDocument();
    const text = panel.textContent ?? '';
    expect(text).toContain('M01 ferma (giorno 1)');
    expect(text).toContain('M02 ferma (giorno 2)');
    expect(text).toContain('COM-012 prioritaria');
    expect(text).toContain('COM-007 prioritaria');
    // The day_anchor meta key must NOT leak into the UI.
    expect(text).not.toContain('day_anchor');
  });

  it('the "Azzera" button calls onClearPriorRules', async () => {
    const user = userEvent.setup();
    const clearMock = vi.fn();
    render(
      <WhatIfAnalysis
        slug="acme-spa"
        solution={SOLUTION_PROP}
        kpis={KPIS_PROP}
        onAcceptResult={vi.fn()}
        originalBackendResult={{ status: 'OPTIMAL', solution: {}, kpis: {} }}
        priorRules={PRIOR_RULES}
        onClearPriorRules={clearMock}
      />,
    );
    await user.click(screen.getByTestId('whatif-clear-inherited'));
    expect(clearMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT render the panel when there are no inherited constraints', () => {
    render(
      <WhatIfAnalysis
        slug="acme-spa"
        solution={SOLUTION_PROP}
        kpis={KPIS_PROP}
        onAcceptResult={vi.fn()}
        originalBackendResult={{ status: 'OPTIMAL', solution: {}, kpis: {} }}
        priorRules={{}}
        onClearPriorRules={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('whatif-inherited-constraints')).not.toBeInTheDocument();
  });
});
