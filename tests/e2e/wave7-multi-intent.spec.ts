import { test, expect, type Page } from '@playwright/test';
import {
  setupApplyMock,
  setupWhatifMock,
  setupBackendBootMocks,
  captureApplySolvedPayload,
  mockSolveForDeadlineChange,
  flattenPhases,
  staticFallbackBaseline,
  type ApplyMockSpec,
} from './wave7-real-effect.spec';

/**
 * Wave 8 e2e — Multi-intent end-to-end coverage.
 *
 * Three scenarios, exercising the full Italian → Haiku-classify → router →
 * BFF → backend chain:
 *
 *   1. capacity_addition — HONEST UNSUPPORTED (F-W8-01).
 *      Catalog flags this intent `not_implemented: true` because the
 *      backend has no CP-SAT consumer for extra_capacity (the f_apply_rules
 *      passthrough warning would silently no-op the plan). The router
 *      short-circuits with `kind=unsupported` so the BFF never burns a
 *      solve call. The e2e asserts the full SSE sequence and the
 *      user-facing toast — the Wave 4.1 pattern of "looks applied,
 *      actually ignored" is the regression we are paid to catch.
 *
 *   2. shift_window — HONEST UNSUPPORTED (F-W8-01, same shape).
 *
 *   3. deadline_change — FULL EFFECT.
 *      Strategy A (data-modifier emits `dataset_overrides.orders` +
 *      `rules_fallback.deadline_changes`). Backend posts
 *      `last_le <= new_deadline_min`. Truth-check: COM-002 last phase
 *      end_min ≤ 3960 (3 aprile 18:00 from horizon 2026-04-01 00:00).
 *
 * All three tests run mocked end-to-end via the helpers exported from
 * `wave7-real-effect.spec.ts` (w8-test-infra-fixer). Mock-only means:
 *   - $0 LLM (no Haiku, no Opus, no backend solve)
 *   - deterministic SSE bodies (no flake on Anthropic 529s)
 *   - the integration shape is still exercised: every event the UI's
 *     reducer would see live is dispatched by the mock, and the warning
 *     strings come from the same source-of-truth catalog the live router
 *     would emit
 *
 * Live counterparts of these scenarios live in the integration scripts
 * (`scripts/wave7-integration.ts` etc.) where Anthropic credit is the
 * gating factor — keep the e2e suite hermetic.
 */

const APPLY_TIMEOUT_MS = 30_000;

// Local copy of bootToDashboard — wave7-real-effect.spec.ts does not
// export it (the helper takes a page + behaves identically in both
// suites, but the test-infra-fixer kept it module-private). When that
// helper is exported (follow-up task) replace this with an import.
async function bootToDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByText(/Backend connesso/i)).toBeVisible({ timeout: 30_000 });

  const demoBtn = page.getByRole('button', { name: /Carica Demo Commesse dal backend/i });
  await expect(demoBtn).toBeVisible();
  const aziendaTrovata = page.getByText(/Azienda trovata nel sistema/i);
  let appeared = false;
  for (let attempt = 0; attempt < 6 && !appeared; attempt++) {
    if (attempt > 0) await page.waitForTimeout(1500);
    await demoBtn.click().catch(() => { /* may be hidden after the working click */ });
    try {
      await aziendaTrovata.waitFor({ state: 'visible', timeout: 4_000 });
      appeared = true;
    } catch { /* retry */ }
  }
  expect(appeared, 'Demo onboarding must appear').toBe(true);

  await page.getByRole('button', { name: /Scegli Metodo/i }).click();
  await page.getByRole('button', { name: /JSON Deterministico/i }).click();
  await expect(page.getByRole('heading', { name: /Piano di Produzione/i }))
    .toBeVisible({ timeout: 60_000 });
}

async function scrollToWhatIfPanel(page: Page): Promise<void> {
  const title = page.getByText(/Analisi What-If/i).first();
  await title.scrollIntoViewIfNeeded({ timeout: 5_000 });
  await expect(title).toBeVisible({ timeout: 5_000 });
}

/**
 * Fill the scenario textarea and click "Analizza" with a mocked /api/whatif
 * route already installed. Waits until the streaming indicator clears and
 * the analysis region has content. Returns void on success — the test's
 * follow-on assertions on the apply button cover the success / error
 * branches.
 */
async function runWhatIfMockedAndWait(page: Page, scenario: string): Promise<void> {
  const textarea = page.getByLabel(/Scenario What-If/i);
  await textarea.fill(scenario);
  const sendBtn = page.getByTestId('whatif-analyze');
  await expect(sendBtn).toBeEnabled({ timeout: 2_000 });
  await sendBtn.click();
  await expect.poll(
    async () => {
      const streaming = await page.getByText(/Opus sta analizzando/i).isVisible().catch(() => false);
      const responseRegion = page.getByRole('region', { name: /Analisi/i });
      const txt = (await responseRegion.textContent().catch(() => '')) ?? '';
      return !streaming && txt.length > 30 ? 'done' : 'pending';
    },
    { timeout: 30_000, intervals: [200, 500, 1000] },
  ).toBe('done');
}

test.describe('Wave 8 — Multi-intent end-to-end', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('1. capacity_addition → honest UNSUPPORTED, no backend solve', async ({ page }) => {
    const bootMocks = await setupBackendBootMocks(page, staticFallbackBaseline());
    const whatifMock = await setupWhatifMock(page);

    // Mock the apply-whatif SSE as the BFF would emit it for an
    // intent the catalog flags `not_implemented: true`. The router
    // short-circuits to strategy='unsupported' with the warning the
    // strategy-router unit tests pin down.
    const spec: ApplyMockSpec = {
      kind: 'unsupported',
      intentParsed: {
        intent_id: 'capacity_addition',
        entities: { operators: 1, shift: 'serale' },
        confidence: 0.94,
        fallback_reasoning: null,
      },
      unsupportedReason:
        'Scenario riconosciuto ma non ancora supportato: il backend non implementa questa modifica nel modello CP-SAT. Riprova con un vincolo del catalogo gia attivo (es. blocco macchina, priorita commessa, cambio scadenza).',
      unsupportedWarnings: ['not_implemented:capacity_addition'],
    };
    const mock = await setupApplyMock(page, spec);

    try {
      await bootToDashboard(page);
      await scrollToWhatIfPanel(page);

      await runWhatIfMockedAndWait(
        page,
        'Aggiungo un operatore mercoledì sera per il turno serale, il piano cambia molto?',
      );

      const applyBtn = page.getByTestId('whatif-apply');
      await expect(applyBtn).toBeVisible({ timeout: 5_000 });
      await expect(applyBtn).toBeEnabled();

      const { solved, warnings, events } = await captureApplySolvedPayload(
        page,
        async () => { await applyBtn.click(); },
        { mock, spec, timeoutMs: APPLY_TIMEOUT_MS },
      );

      // ── ASSERT 1 — `solving` event absent (no solve was launched).
      //
      // This is the F-W8-01 honesty contract: when we cannot deliver the
      // constraint, the system does NOT pretend by routing through a
      // pointless solve. Distinct from Wave 4.1 where the BFF silently
      // burned a solve, returned the unchanged baseline, and the manager
      // saw "Vincolo applicato".
      expect(
        events,
        `events sequence must NOT include 'solving' for not_implemented intent ` +
          `(got: ${events.join(',')})`,
      ).not.toContain('solving');

      // ── ASSERT 2 — the SSE pipeline carries the intent_parsed shape
      // we expect (Haiku, classified to capacity_addition).
      expect(events).toContain('intent_parsed');
      expect(events).toContain('routed');
      expect(events).toContain('aborted_unsupported');

      // ── ASSERT 3 — warnings carry the not_implemented marker.
      const hasNotImplementedWarning = warnings.some(
        (w) => /not_implemented:capacity_addition/.test(w),
      );
      expect(
        hasNotImplementedWarning,
        `warnings must include 'not_implemented:capacity_addition' (got: ${warnings.join('|')})`,
      ).toBe(true);

      // ── ASSERT 4 — no solved payload (the BFF did not synthesise a
      // fake plan); the body never carries newSolution/newKpis for an
      // unsupported intent.
      expect(solved, 'no `solved` event expected for unsupported intent').toBeNull();

      // ── ASSERT 5 — UI toast surfaces the Italian message. Rendered
      // by sonner; targeting by accessible text keeps the assertion
      // resilient to z-index / portal noise.
      await expect(
        page.getByText(/Scenario non applicabile/i).first(),
      ).toBeVisible({ timeout: 5_000 });
    } finally {
      await mock.dispose();
      await whatifMock.dispose();
      await bootMocks.dispose();
    }
  });

  test('2. shift_window → honest UNSUPPORTED, no backend solve', async ({ page }) => {
    const bootMocks = await setupBackendBootMocks(page, staticFallbackBaseline());
    const whatifMock = await setupWhatifMock(page);

    const spec: ApplyMockSpec = {
      kind: 'unsupported',
      intentParsed: {
        intent_id: 'shift_window',
        entities: { shift_id: 'turno_mattina', start_min: 360, end_min: 720 },
        confidence: 0.91,
        fallback_reasoning: null,
      },
      unsupportedReason:
        'Scenario riconosciuto ma non ancora supportato: il backend non implementa questa modifica nel modello CP-SAT. Riprova con un vincolo del catalogo gia attivo (es. blocco macchina, priorita commessa, cambio scadenza).',
      unsupportedWarnings: ['not_implemented:shift_window'],
    };
    const mock = await setupApplyMock(page, spec);

    try {
      await bootToDashboard(page);
      await scrollToWhatIfPanel(page);

      await runWhatIfMockedAndWait(
        page,
        'Anticipa il turno mattina di un\'ora, partiamo dalle 7 invece che dalle 8.',
      );

      const applyBtn = page.getByTestId('whatif-apply');
      await expect(applyBtn).toBeVisible({ timeout: 5_000 });
      await expect(applyBtn).toBeEnabled();

      const { solved, warnings, events } = await captureApplySolvedPayload(
        page,
        async () => { await applyBtn.click(); },
        { mock, spec, timeoutMs: APPLY_TIMEOUT_MS },
      );

      expect(
        events,
        `events must NOT include 'solving' for shift_window not_implemented intent ` +
          `(got: ${events.join(',')})`,
      ).not.toContain('solving');

      expect(events).toContain('intent_parsed');
      expect(events).toContain('routed');
      expect(events).toContain('aborted_unsupported');

      const hasNotImplementedWarning = warnings.some(
        (w) => /not_implemented:shift_window/.test(w),
      );
      expect(
        hasNotImplementedWarning,
        `warnings must include 'not_implemented:shift_window' (got: ${warnings.join('|')})`,
      ).toBe(true);

      expect(solved, 'no `solved` event expected for unsupported intent').toBeNull();

      await expect(
        page.getByText(/Scenario non applicabile/i).first(),
      ).toBeVisible({ timeout: 5_000 });
    } finally {
      await mock.dispose();
      await whatifMock.dispose();
      await bootMocks.dispose();
    }
  });

  test('3. deadline_change → strategy A, COM-002 last phase end_min ≤ new deadline', async ({ page }) => {
    const baseline = staticFallbackBaseline();
    const bootMocks = await setupBackendBootMocks(page, baseline);
    const whatifMock = await setupWhatifMock(page);

    // 3 aprile 18:00 from horizon 2026-04-01 00:00.
    // day-3 starts at min 2880, 18:00 = 2880 + 18*60 = 3960.
    const NEW_DEADLINE_MIN = 3960;

    const solveSnap = mockSolveForDeadlineChange(baseline, 'COM-002', NEW_DEADLINE_MIN);
    const spec: ApplyMockSpec = {
      kind: 'success',
      strategy: 'A',
      intentParsed: {
        intent_id: 'deadline_change',
        entities: { order_id: 'COM-002', new_deadline_min: NEW_DEADLINE_MIN },
        confidence: 0.97,
        fallback_reasoning: null,
      },
      solve: solveSnap,
    };
    const mock = await setupApplyMock(page, spec);

    try {
      await bootToDashboard(page);
      await scrollToWhatIfPanel(page);

      await runWhatIfMockedAndWait(
        page,
        'Sposta la scadenza della commessa COM-002 al 3 aprile alle 18:00, è più stringente del previsto.',
      );

      const applyBtn = page.getByTestId('whatif-apply');
      await expect(applyBtn).toBeVisible({ timeout: 5_000 });
      await expect(applyBtn).toBeEnabled();

      const { solved, events } = await captureApplySolvedPayload(
        page,
        async () => { await applyBtn.click(); },
        { mock, spec, timeoutMs: APPLY_TIMEOUT_MS },
      );

      // ── ASSERT 1 — pipeline went all the way to solved.
      expect(events).toContain('intent_parsed');
      expect(events).toContain('routed');
      expect(events).toContain('solving');
      expect(
        solved,
        `apply pipeline must produce a solved event for deadline_change ` +
          `(events=${events.join('|')})`,
      ).not.toBeNull();
      if (!solved) return;

      // ── ASSERT 2 — strategy A (data_modification) is what the
      // data-modifier returns for deadline_change today.
      expect(solved.strategy, 'deadline_change must route to strategy A').toBe('A');

      // ── ASSERT 3 — the truth-check: COM-002 last phase respects
      // the new deadline. The mock builder
      // (`mockSolveForDeadlineChange`) constructs a candidate where
      // the last phase ends exactly at `NEW_DEADLINE_MIN`; if the
      // helper or the assertion drift apart, this fails loud.
      const candidatePhases = flattenPhases(solved.newSolution);
      const com002 = candidatePhases
        .filter((p) => p.commessa === 'COM-002')
        .sort((a, b) => b.end_min - a.end_min);
      expect(com002.length, 'COM-002 must exist in candidate plan').toBeGreaterThan(0);
      if (com002.length === 0) return;
      const lastEnd = com002[0].end_min;
      expect(
        lastEnd,
        `COM-002 last phase must end by new deadline (${NEW_DEADLINE_MIN}), got ${lastEnd}`,
      ).toBeLessThanOrEqual(NEW_DEADLINE_MIN);
    } finally {
      await mock.dispose();
      await whatifMock.dispose();
      await bootMocks.dispose();
    }
  });
});
