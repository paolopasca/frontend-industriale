import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Wave 16.6 bug-fix — the interpreter REJECT must be VISIBLE.
 *
 * Regression target: when the closed-set Haiku interpreter rejects a What-If
 * scenario (entity not in the plan / non-catalog / out of horizon), the route
 * emits `aborted_unsupported` with NO `translated` event. The UI previously
 * gated the "Motivo" box on `translatorChange?.unsupportedReason` ONLY, which
 * is null on that path → the box never rendered → the manager saw a vanishing
 * toast and "niente si aggiorna" with no explanation. The fix stores the reason
 * in `unsupportedReason` state and renders the box from
 * `translatorChange?.unsupportedReason ?? unsupportedReason`.
 *
 * This test drives apply-whatif to `aborted_unsupported` (no `translated`
 * event, mirroring the interpreter path) and asserts the reason box appears.
 */

const REASON = 'Lo scenario cita una commessa che non è nel piano corrente.';

// /api/whatif → a non-empty analysis (enables "Esegui"); /api/apply-whatif →
// translating → aborted_unsupported (NO `translated`, NO `solved`) → done.
const WHATIF_EVENTS = [
  { event: 'chunk', data: { text: 'Analisi di esempio. ' } },
  { event: 'chunk', data: { text: 'Raccomandazione: valuta.' } },
  { event: 'done', data: { cost_usd: 0.001 } },
];

const APPLY_EVENTS = [
  { event: 'translating', data: {} },
  { event: 'aborted_unsupported', data: { reason: REASON, warnings: ['interpreter_reject'] } },
  { event: 'done', data: { cost_usd: 0.0014 } },
];

vi.mock('@/lib/streamingFetch', () => ({
  sseStream: vi.fn(async function* (url: string) {
    const events = url.includes('/api/apply-whatif') ? APPLY_EVENTS : WHATIF_EVENTS;
    for (const e of events) yield e;
  }),
  friendlyErrorMessage: (e: { message?: string }) => e?.message ?? null,
}));

import { WhatIfAnalysis } from '../WhatIfAnalysis';

const SOLUTION_PROP = { status: 'OPTIMAL', fasi: [{ commessa: 'COM-001' }], commesse: {} };
const KPIS_PROP = { makespan_min: 120 };

describe('WhatIfAnalysis — interpreter reject is surfaced (Wave 16.6)', () => {
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

  it('renders the "Motivo" box on aborted_unsupported even without a `translated` event', async () => {
    const user = userEvent.setup();
    render(
      <WhatIfAnalysis
        slug="acme-spa"
        solution={SOLUTION_PROP}
        kpis={KPIS_PROP}
        onAcceptResult={vi.fn()}
        originalBackendResult={{ status: 'OPTIMAL', solution: {}, kpis: {} }}
      />,
    );

    // Analyze → enables "Esegui".
    await user.type(
      screen.getByRole('textbox', { name: /scenario what-if/i }),
      'Anticipa la commessa COM-999 (inesistente)',
    );
    await user.click(screen.getByTestId('whatif-analyze'));
    await waitFor(() => expect(screen.getByTestId('whatif-apply')).toBeInTheDocument());

    // Esegui → apply-whatif SSE → aborted_unsupported.
    await user.click(screen.getByTestId('whatif-apply'));

    // The reason box must appear (it did NOT before the fix on this path) and
    // carry non-trivial text (the humanized reason, not just the "Motivo:" label).
    const box = await screen.findByTestId('whatif-apply-unsupported-reason');
    expect(box).toBeInTheDocument();
    expect((box.textContent ?? '').replace(/Motivo:?/i, '').trim().length).toBeGreaterThan(5);

    // And NO candidate diff is shown (the solve was aborted, not solved).
    expect(screen.queryByTestId('solution-diff-accept')).not.toBeInTheDocument();
  });
});
