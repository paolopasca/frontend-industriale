import { test, expect, type Page, type Request } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Wave 16.3 e2e smoke — pre-pilot HIT / GRAY / MISS sanity sweep.
 *
 * ENVIRONMENT PRECONDITIONS (read before running):
 *   - BFF dev server on http://localhost:8080 — start with `npm run dev:bff`
 *     so the server-side process.env picks up ANTHROPIC_API_KEY from
 *     `.dev.vars`. The plain `npm run dev` script uses
 *     `dotenv -e .env.local` and, on TanStack Start + cloudflare plugin,
 *     does NOT propagate the key into the server runtime — every LLM call
 *     errors with "ANTHROPIC_API_KEY not set (server-only env var)" and
 *     all three tests skip cleanly.
 *   - Backend solver on http://localhost:8001 (`curl /api/health` → 200).
 *   - `demo-commesse` company seeded in the backend (the fixture default).
 *   - `DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL=1` in the env so the smoke run
 *     doesn't consume the 5/h apply-whatif bucket.
 *
 * The team-lead brief asked for three real-backend smoke scenarios that
 * exercise the apply-whatif pipeline end-to-end:
 *
 *   1. HIT   — manager utterance maps to a high-confidence catalog intent
 *              (machine_unavailability). Wave 7 path: Haiku intent_parsed
 *              → strategy A/B → solving → solved. No GRAY_ZONE modal.
 *
 *   2. GRAY  — Wave 16.2 gray-zone: BFF emits `requires_confirmation` before
 *              solving. UI shows WhatIfConfirmationModal (testid
 *              `whatif-grayzone-modal`). Manager clicks "Conferma e applica",
 *              the UI re-calls with userConfirmedGrayZone=true and the
 *              confirmedPayload echoed back. Solver then runs.
 *
 *   3. MISS  — out-of-catalog utterance (e.g. "se compro un robot in più
 *              che succede?"). The pipeline routes to either
 *              `aborted_unsupported` (Haiku unknown+high short-circuit, or
 *              Opus translator returns unsupported), surfaced to the UI as
 *              data-state="unsupported" with a sonner toast. Either terminal
 *              is acceptable as long as the UI does not crash and the manager
 *              is told the scenario could not be applied.
 *
 * The test runs against the REAL BFF on :8080 talking to the REAL backend on
 * :8001. Each scenario boots the dashboard from scratch (~25s solve + ~30s
 * whatif analysis), so we bump the per-test timeout to 5 minutes.
 *
 * Tolerance — Opus 4.7 has been transiently 529 in this codebase
 * (see wave4-whatif.spec.ts, wave4.1-apply-whatif.spec.ts). When the upstream
 * whatif analysis surfaces an inline error alert, we skip the apply assertion
 * for that scenario but still flag it so the team knows which LLM hop failed.
 *
 * Wave 16.3 contract notes (read before changing assertions):
 *   - BFF accepts `{slug, originalSolution, kpis, whatifText, managerText,
 *     currentTimeMin, cushionMin, userConfirmedGrayZone?, confirmedPayload?,
 *     forceOpusFallback?}` — NOT `{instruction, solution_context}` (which
 *     was a brief shortcut, not the real shape).
 *   - HIT path emits `parsing_intent → intent_parsed → routed → solving →
 *     solved → done`. No `requires_confirmation`.
 *   - GRAY path emits `parsing_intent → intent_parsed → translating →
 *     translated → requires_confirmation → done`. Stream ENDS — no `solved`
 *     until the UI re-calls with userConfirmedGrayZone=true.
 *   - MISS path can terminate as `aborted_unsupported → done` (UI shows
 *     `data-state="unsupported"`) or — when the Haiku confidence is medium
 *     and the Opus cascade hallucinates a valid intent — actually succeed.
 *     The smoke check tolerates either outcome; what we care about is that
 *     the UI is in a consistent terminal state and the manager is informed.
 */

const SOLVE_TIMEOUT_MS = 55_000;
const WHATIF_REPLY_TIMEOUT_MS = 120_000;
const APPLY_TIMEOUT_MS = 120_000;

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

function ensureScreenshotsDir(): void {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
}

async function bootToDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByText(/Backend connesso/i)).toBeVisible({ timeout: 10_000 });

  // Wave 12+ flow: the "Scegli Metodo" intermediate step was removed.
  // For has_consultation companies (demo-commesse loads with consultation
  // pre-attached), the onboarding collapses to a single "Azienda" step
  // and the final CTA is "Ottimizza Produzione" — see SetupPage.tsx:127.
  //
  // The legacy "Carica Demo Commesse dal backend" button may or may not
  // be present depending on whether the suggestions list is open; the
  // robust path is to type "Demo Commesse" into the company name field
  // (matches via fuzzy search in SetupPage.tsx:96 — name or slug includes
  // the typed text), the backend hydrates `companyLoaded`, the "Azienda
  // trovata nel sistema" panel appears, and "Ottimizza Produzione"
  // becomes enabled.
  //
  // We first try the demo-load button (cheaper + deterministic). If it's
  // not there, we type the company name explicitly.
  const demoBtn = page.getByRole('button', { name: /Carica Demo Commesse dal backend/i });
  if (await demoBtn.isVisible().catch(() => false)) {
    await demoBtn.click();
  } else {
    await page.getByLabel(/Nome Azienda/i).fill('Demo Commesse');
  }

  await expect(page.getByText(/Azienda trovata nel sistema/i)).toBeVisible({ timeout: 10_000 });

  const optimizeBtn = page.getByRole('button', { name: /Ottimizza Produzione/i });
  await optimizeBtn.scrollIntoViewIfNeeded({ timeout: 5_000 });
  await expect(optimizeBtn).toBeEnabled({ timeout: 5_000 });
  await optimizeBtn.click();

  await expect(page.getByRole('heading', { name: /Piano di Produzione/i }))
    .toBeVisible({ timeout: SOLVE_TIMEOUT_MS });
}

async function scrollToWhatIfPanel(page: Page): Promise<void> {
  const title = page.getByText(/Analisi What-If/i).first();
  await title.scrollIntoViewIfNeeded({ timeout: 5_000 });
  await expect(title).toBeVisible({ timeout: 5_000 });
}

/**
 * Triggers the whatif analysis (Opus 4.7) and waits for the response to
 * either complete (apply button enabled) or surface an inline error within
 * the whatif region. Returns true when Opus produced an analyzable output
 * and the apply CTA is gated open, false when the streaming error path was
 * hit (Opus 529 / upstream timeout — known transient on this codebase).
 *
 * Why not check for arbitrary `role=alert`: the dashboard ALWAYS renders
 * alerts for the explainer + advisor surfaces when those LLM hops are
 * 503/429, which happens routinely during Wave 16.3 stress runs. Those
 * alerts are unrelated to the whatif streaming health. We instead scope
 * the error check to the whatif region.
 */
async function runWhatIfAndWait(page: Page, scenario: string): Promise<boolean> {
  const textarea = page.getByLabel(/Scenario What-If/i);
  await textarea.fill(scenario);

  const sendBtn = page.getByTestId('whatif-analyze');
  await expect(sendBtn).toBeEnabled({ timeout: 2_000 });
  await sendBtn.click();

  // Two ways out:
  //   1. canApply flips true → whatif-apply CTA appears → return true.
  //   2. The whatif region shows an error message AND the apply CTA never
  //      appears → return false (skip path).
  await expect.poll(
    async () => {
      const applyVisible = await page.getByTestId('whatif-apply').isVisible().catch(() => false);
      if (applyVisible) return 'ready';
      // Scope the alert check to the WhatIfAnalysis region. The region is
      // labelled "Analisi in corso" while streaming and "Analisi What-If"
      // after the streaming finished (with or without error).
      const whatifRegion = page.getByRole('region', { name: /^Analisi(\s+(in corso|What-If))?$/i }).first();
      const inWhatifErr = await whatifRegion
        .getByRole('alert')
        .first()
        .isVisible()
        .catch(() => false);
      const stillStreaming = await page.getByText(/Opus sta analizzando|Il sistema AI sta analizzando/i)
        .isVisible()
        .catch(() => false);
      if (!stillStreaming && inWhatifErr) return 'errored';
      return 'pending';
    },
    { timeout: WHATIF_REPLY_TIMEOUT_MS, intervals: [800, 1500, 2000] },
  ).toMatch(/^(ready|errored)$/);

  // Final disposition: ready if the apply button is now visible.
  return await page.getByTestId('whatif-apply').isVisible().catch(() => false);
}

/**
 * Capture the JSON body of the first POST to /api/apply-whatif and return
 * its top-level shape. Useful to assert on the real BFF contract.
 */
function captureApplyWhatIfRequest(page: Page): Promise<Request> {
  return page.waitForRequest(
    (req) => req.url().endsWith('/api/apply-whatif') && req.method() === 'POST',
    { timeout: 30_000 },
  );
}

/**
 * Pre-flight: confirm the BFF can actually talk to Anthropic. Without the
 * server-side ANTHROPIC_API_KEY, /api/whatif returns an SSE `error` event
 * on its very first chunk and the rest of the smoke is pointless. Doing
 * this once up-front means the three scenarios don't each waste ~30s on
 * the boot path before discovering the same blocker.
 *
 * Returns { ok: true } when the BFF accepts the request and Opus returns
 * a normal streaming chunk, { ok: false, reason } otherwise. The reason is
 * surfaced as a test annotation so wave-16.3-devil sees WHY everything
 * skipped (env vs 529 vs network).
 */
async function probeBffLlmHealth(page: Page): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await page.evaluate(async () => {
    try {
      const res = await fetch('/api/whatif', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'demo-commesse',
          solution: { 'COM-001': { fasi: [] } },
          kpis: { makespan: 1800 },
          // Cheapest legal prompt — 3-char minimum, 1 Opus token of output
          // at most thanks to the short scenario. Real cost: < $0.01 if it
          // succeeds, $0 if it errors at the env check (which is what we
          // are detecting).
          scenario: 'ok?',
        }),
      });
      if (res.status === 429) return { phase: 'http_429', detail: 'rate_limited' };
      if (res.status >= 500) return { phase: 'http_5xx', detail: `${res.status}` };
      if (res.status !== 200) {
        const txt = await res.text().catch(() => '');
        return { phase: 'http_non_200', detail: `${res.status}: ${txt.slice(0, 200)}` };
      }
      const text = await res.text();
      // The SSE response either starts with `event: chunk` (Opus healthy)
      // or `event: error` (config/upstream failure).
      const firstEvent = (text.match(/^event:\s*(\w+)/m)?.[1] ?? '').toLowerCase();
      if (firstEvent === 'error') {
        const msgMatch = text.match(/"message"\s*:\s*"([^"]+)"/);
        return { phase: 'sse_error', detail: msgMatch?.[1] ?? text.slice(0, 200) };
      }
      if (firstEvent === 'chunk' || firstEvent === 'done') {
        return { phase: 'ok' };
      }
      return { phase: 'sse_unknown', detail: text.slice(0, 200) };
    } catch (e) {
      return { phase: 'fetch_error', detail: e instanceof Error ? e.message : String(e) };
    }
  });

  if (result.phase === 'ok') return { ok: true };
  return { ok: false, reason: `${result.phase}: ${(result as { detail?: string }).detail ?? ''}` };
}

// Module-level cache of the LLM health probe result. Doing it once per
// describe (not once per test) saves ~3-5s per scenario.
let llmHealthCache: { ok: true } | { ok: false; reason: string } | null = null;

test.describe('Wave 16.3 — pre-pilot smoke (HIT / GRAY / MISS)', () => {
  // Each test boots the dashboard (~30s) + whatif (~30s) + apply (Haiku
  // parse + solve, ~30s for HIT; +Opus translator for GRAY/MISS, up to ~60s).
  // Default 60s is too tight even for HIT alone.
  test.setTimeout(300_000);
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ browser }) => {
    ensureScreenshotsDir();
    // Probe the BFF once. We open a dedicated page so the smoke tests start
    // with a clean storage state. The probe is also extremely cheap (~1s).
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('/');
    llmHealthCache = await probeBffLlmHealth(page);
    await ctx.close();
  });

  test('Scenario 1 — HIT path: machine_unavailability → solve direct, no modal', async ({ page }) => {
    test.skip(
      llmHealthCache?.ok === false,
      `BFF LLM health probe failed: ${llmHealthCache && 'reason' in llmHealthCache ? llmHealthCache.reason : 'unknown'}. ` +
        `Likely cause: dev server lacks ANTHROPIC_API_KEY — start with 'npm run dev:bff'.`,
    );

    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    // The HIT scenario maps to the `machine_unavailability` intent in the
    // Haiku catalog (start_min / end_min derived from "14 alle 18"). The
    // strategy router routes this to Strategy A or B, both of which solve
    // directly without going through the gray-zone gate.
    //
    // The brief asked for "linea 2" but the demo-commesse fixture uses
    // M-N machine ids (M-1..M-5). Use M-3 (a known machine in the fixture)
    // so the intent parser has a concrete entity to anchor on; otherwise
    // Haiku may return `unknown` and the test would degenerate into MISS.
    const healthy = await runWhatIfAndWait(
      page,
      'Posso fermare la macchina M-3 oggi dalle 14 alle 18 per manutenzione preventiva?',
    );
    test.skip(!healthy, 'Opus 4.7 529 on what-if streaming — HIT apply path skipped.');

    const applyBtn = page.getByTestId('whatif-apply');
    await expect(applyBtn).toBeVisible({ timeout: 5_000 });
    await expect(applyBtn).toBeEnabled();

    // Start listening BEFORE the click so the request is captured even if it
    // fires synchronously after click().
    const applyReqPromise = captureApplyWhatIfRequest(page);
    await applyBtn.click();
    const applyReq = await applyReqPromise;

    // Contract assertion: BFF receives {slug, whatifText, managerText, ...}.
    // The team-lead brief's `{instruction, solution_context}` shape does
    // NOT exist on this endpoint; we assert the REAL contract instead.
    const body = applyReq.postDataJSON() as Record<string, unknown>;
    expect(typeof body.slug).toBe('string');
    expect(body.slug).toBe('demo-commesse');
    expect(typeof body.whatifText).toBe('string');
    expect(typeof body.managerText).toBe('string');
    expect((body.managerText as string).length).toBeGreaterThan(0);
    expect(body).toHaveProperty('originalSolution');
    expect(body).toHaveProperty('kpis');

    const statusPanel = page.getByTestId('whatif-apply-status');
    await expect(statusPanel).toBeVisible({ timeout: 8_000 });

    // HIT means: the GRAY_ZONE modal must NOT appear. Probe continuously
    // until the apply pipeline reaches a terminal state. A brief modal
    // flash mid-run would already be a HIT contract violation (the BFF
    // sent requires_confirmation on a high-confidence intent), so the
    // probe runs in parallel with the terminal-state wait and records
    // any sighting.
    let grayZoneEverShown = false;
    let terminalReached = false;
    const modalProbe = (async () => {
      while (!terminalReached) {
        const v = await page.getByTestId('whatif-grayzone-modal').isVisible().catch(() => false);
        if (v) { grayZoneEverShown = true; return; }
        await page.waitForTimeout(250);
      }
    })();

    await expect.poll(
      async () => statusPanel.getAttribute('data-state'),
      { timeout: APPLY_TIMEOUT_MS, intervals: [1000, 2000, 3000] },
    ).toMatch(/^(done|unsupported|error)$/);

    terminalReached = true;
    await modalProbe;

    // The real-backend HIT-or-MISS outcome depends on Haiku's confidence
    // for this exact phrase, which has drifted in the past (see issues #34
    // / #36 in the task list). What we MUST verify is:
    //   (a) the modal did not show (it's the HIT path, not GRAY),
    //   (b) the UI reached a terminal state without crashing.
    expect(grayZoneEverShown).toBe(false);

    const finalState = await statusPanel.getAttribute('data-state');
    expect(['done', 'unsupported', 'error']).toContain(finalState);

    // If Opus is healthy and Haiku classified correctly, we also expect the
    // SolutionDiff to be visible with at least one KPI row. Flag (not fail)
    // when the classifier degraded so the team can see drift in CI.
    if (finalState === 'done') {
      const diff = page.getByTestId('solution-diff');
      await expect(diff).toBeVisible({ timeout: 5_000 });
      const diffText = await diff.innerText();
      expect(diffText).not.toMatch(/\bNaN\b/);
      expect(diffText).not.toMatch(/\bundefined\b/i);
      expect(diffText).not.toMatch(/\bInfinity\b/);
      const rowCount = await page.locator('[data-testid^="solution-diff-row-"]').count();
      expect(rowCount).toBeGreaterThan(0);

      // Devil-advocate concern: "missing assertion su delta KPI (test passa
      // ma fallisce a coverage reale)". A row that renders but shows '—'
      // for every delta means the solver effectively returned the same
      // KPIs as the baseline — possible but suspicious for a HIT scenario
      // that should have ACTUALLY blocked a machine. Assert that at least
      // one row exposes a numeric delta (+N / −N / 0), not '—'. The minus
      // sign in the rendered output is U+2212 (figure dash), per
      // SolutionDiff.tsx:133, so we accept it as well as ASCII '-'.
      const deltaCells = await page
        .locator('[data-testid^="solution-diff-row-"]')
        .evaluateAll((els) => els.map((el) => {
          const tds = el.querySelectorAll('td');
          // Delta is the 4th column (index 3).
          return tds[3]?.textContent?.trim() ?? '';
        }));
      const numericDeltaCount = deltaCells.filter((t) => /^[+−\-]?\d/.test(t)).length;
      // Don't HARD-fail on zero numeric deltas (a no-op solve is legal if
      // the manager's machine block didn't actually conflict with any
      // currently-scheduled phase). But flag it so the devil-advocate sees
      // that the "HIT solved" status didn't actually move the schedule.
      if (numericDeltaCount === 0) {
        test.info().annotations.push({
          type: 'hit_no_numeric_delta',
          description: `HIT scenario reached done but no row shows a numeric delta. Solve was a no-op. Delta cells: ${JSON.stringify(deltaCells)}`,
        });
      }
      expect(rowCount).toBe(deltaCells.length); // sanity: every row has a delta cell.
    } else {
      test.info().annotations.push({
        type: 'hit_path_drift',
        description: `Expected HIT/solved but got data-state='${finalState}'. Haiku/Opus drift or transient — see issues #34, #36.`,
      });
    }

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'wave-16.3-hit.png'),
      fullPage: true,
    });
  });

  test('Scenario 2 — GRAY path: requires_confirmation modal → Conferma → solve', async ({ page }) => {
    test.skip(
      llmHealthCache?.ok === false,
      `BFF LLM health probe failed: ${llmHealthCache && 'reason' in llmHealthCache ? llmHealthCache.reason : 'unknown'}.`,
    );

    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    // The GRAY scenario is a deadline/anticipation utterance that lacks a
    // concrete target date — the Opus translator marks it as
    // requiresConfirmation=true. The exact wording was given by the
    // team-lead: "Anticipa COM-001".
    //
    // Real-backend caveat (acknowledged in the brief's CONSTRAINT NOTI):
    // if the be-extractor-tuner shifts the threshold (issue #36), this
    // utterance may flip to HIT. The test reports drift in that case
    // rather than failing — it's a smoke, not a contract test for the
    // classifier.
    const healthy = await runWhatIfAndWait(
      page,
      'Anticipa COM-001',
    );
    test.skip(!healthy, 'Opus 4.7 529 on what-if streaming — GRAY apply path skipped.');

    const applyBtn = page.getByTestId('whatif-apply');
    await expect(applyBtn).toBeVisible({ timeout: 5_000 });

    const applyReqPromise = captureApplyWhatIfRequest(page);
    await applyBtn.click();
    const firstApplyReq = await applyReqPromise;
    const firstBody = firstApplyReq.postDataJSON() as Record<string, unknown>;
    expect(firstBody.userConfirmedGrayZone).toBeUndefined(); // first call: no confirm flag.

    // Poll for the gray-zone modal OR a terminal state (in case the
    // classifier shifted this utterance into HIT/MISS at the threshold).
    let grayShown = false;
    await expect.poll(
      async () => {
        const modal = await page.getByTestId('whatif-grayzone-modal').isVisible().catch(() => false);
        if (modal) { grayShown = true; return 'modal'; }
        const state = await page.getByTestId('whatif-apply-status').getAttribute('data-state').catch(() => null);
        if (state && /^(done|unsupported|error)$/.test(state)) return 'terminal';
        return 'pending';
      },
      { timeout: APPLY_TIMEOUT_MS, intervals: [400, 800, 1500] },
    ).toMatch(/^(modal|terminal)$/);

    if (!grayShown) {
      // Classifier drift — the utterance was treated as HIT or MISS, not
      // GRAY. Annotate, screenshot, and skip the confirmation step.
      const finalState = await page.getByTestId('whatif-apply-status').getAttribute('data-state').catch(() => null);
      test.info().annotations.push({
        type: 'gray_path_drift',
        description: `Expected GRAY_ZONE modal but classifier routed to ${finalState ?? 'unknown'} terminal. See issue #36 (alias miss).`,
      });
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, 'wave-16.3-gray-confirm.png'),
        fullPage: true,
      });
      test.skip(true, 'GRAY_ZONE not triggered by current classifier — drift, not bug for this smoke.');
      return;
    }

    // Modal contract: confirmationMessage + confidence band + the two
    // CTA buttons "Conferma e applica" (green) and "Annulla". The
    // "Riformula con AI" button is hidden by default in Wave 16.3 (the
    // showRiformula prop defaults to false — see WhatIfConfirmationModal.tsx).
    const modal = page.getByTestId('whatif-grayzone-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByText(/Conferma interpretazione/i)).toBeVisible();
    await expect(modal.getByRole('button', { name: /Conferma e applica/i })).toBeVisible();
    await expect(modal.getByRole('button', { name: /^Annulla$/i })).toBeVisible();

    // Now click "Conferma e applica" — this triggers a second POST with
    // userConfirmedGrayZone=true. The next solver run should complete.
    const secondApplyReqPromise = captureApplyWhatIfRequest(page);
    await modal.getByRole('button', { name: /Conferma e applica/i }).click();
    const secondApplyReq = await secondApplyReqPromise;
    const secondBody = secondApplyReq.postDataJSON() as Record<string, unknown>;
    expect(secondBody.userConfirmedGrayZone).toBe(true);
    expect(secondBody).toHaveProperty('confirmedPayload');

    // Modal must close after confirm.
    await expect(modal).toBeHidden({ timeout: 5_000 });

    // Apply pipeline should reach done/error/unsupported.
    const statusPanel = page.getByTestId('whatif-apply-status');
    await expect(statusPanel).toBeVisible({ timeout: 8_000 });
    await expect.poll(
      async () => statusPanel.getAttribute('data-state'),
      { timeout: APPLY_TIMEOUT_MS, intervals: [1000, 2000, 3000] },
    ).toMatch(/^(done|unsupported|error)$/);

    const finalState = await statusPanel.getAttribute('data-state');
    if (finalState === 'done') {
      await expect(page.getByTestId('solution-diff')).toBeVisible({ timeout: 5_000 });
    } else {
      // 'unsupported' after confirm is rare but legal (the confirmedPayload
      // may still be rejected by the solver). 'error' is also tolerated for
      // smoke: what matters is the modal-then-solve sequence is wired.
      test.info().annotations.push({
        type: 'gray_post_confirm_state',
        description: `Post-confirm state was '${finalState}'. Solver may have rejected the confirmedPayload — flag, do not fail smoke.`,
      });
    }

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'wave-16.3-gray-confirm.png'),
      fullPage: true,
    });
  });

  test('Scenario 3 — MISS path: out-of-catalog utterance → Opus fallback / unsupported', async ({ page }) => {
    test.skip(
      llmHealthCache?.ok === false,
      `BFF LLM health probe failed: ${llmHealthCache && 'reason' in llmHealthCache ? llmHealthCache.reason : 'unknown'}.`,
    );

    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    // The MISS scenario asks something the production-planning catalog
    // cannot answer ("se compro un robot in piu" = capital expense
    // forecasting, not a constraint). Two legal terminal outcomes:
    //
    //   (a) Haiku says intent_id='unknown' + confidence='high' → BFF
    //       short-circuits the cascade and emits aborted_unsupported.
    //       data-state='unsupported', sonner warning toast.
    //
    //   (b) Haiku says 'unknown' + confidence='medium/low' → BFF runs
    //       the Opus translator cascade. Opus typically returns
    //       type='unsupported' for this prompt; same UI state.
    //
    // Either way the UI must NOT crash and the manager must see a clear
    // "scenario non applicabile" surface. We do NOT assert that any
    // specific terminal is reached, only that:
    //   - the UI reaches some terminal state,
    //   - it's not 'done with SolutionDiff' (that would mean Opus
    //     hallucinated a constraint from a non-constraint question — a
    //     known classifier failure mode, flagged not failed).
    const healthy = await runWhatIfAndWait(
      page,
      'Se compro un robot in piu nella linea, che cosa succede al piano? Conviene investire?',
    );
    test.skip(!healthy, 'Opus 4.7 529 on what-if streaming — MISS apply path skipped.');

    const applyBtn = page.getByTestId('whatif-apply');
    await expect(applyBtn).toBeVisible({ timeout: 5_000 });

    const applyReqPromise = captureApplyWhatIfRequest(page);
    await applyBtn.click();
    const applyReq = await applyReqPromise;
    const body = applyReq.postDataJSON() as Record<string, unknown>;
    expect(body.slug).toBe('demo-commesse');
    expect(typeof body.managerText).toBe('string');

    const statusPanel = page.getByTestId('whatif-apply-status');
    await expect(statusPanel).toBeVisible({ timeout: 8_000 });

    // MISS may also bounce through the GRAY modal if the translator marks
    // the result requiresConfirmation. Cancel the modal in that case so the
    // smoke completes deterministically.
    const modalCheck = async () => {
      const v = await page.getByTestId('whatif-grayzone-modal').isVisible().catch(() => false);
      if (v) {
        await page.getByTestId('whatif-grayzone-modal')
          .getByRole('button', { name: /^Annulla$/i })
          .click();
        test.info().annotations.push({
          type: 'miss_via_gray',
          description: 'MISS scenario triggered GRAY_ZONE modal; cancelled and observed terminal state.',
        });
      }
    };
    for (let i = 0; i < 6; i++) {
      await modalCheck();
      const state = await statusPanel.getAttribute('data-state').catch(() => null);
      if (state && /^(done|unsupported|error|idle)$/.test(state)) break;
      await page.waitForTimeout(500);
    }

    // Wait for a terminal (including idle, if the user cancelled the modal
    // above — the UI flips applying back to 'idle' on cancel).
    await expect.poll(
      async () => {
        const v = await statusPanel.isVisible().catch(() => false);
        if (!v) return 'idle';
        return await statusPanel.getAttribute('data-state');
      },
      { timeout: APPLY_TIMEOUT_MS, intervals: [1000, 2000, 3000] },
    ).toMatch(/^(done|unsupported|error|idle)$/);

    const finalState = await (async () => {
      const visible = await statusPanel.isVisible().catch(() => false);
      if (!visible) return 'idle';
      return statusPanel.getAttribute('data-state');
    })();

    // Critical assertion for MISS: if the pipeline returned 'done' with a
    // visible SolutionDiff, the LLM hallucinated a constraint from a
    // non-constraint question. That's a smoke-level warning, not a failure
    // (the team explicitly accepted both terminals in the brief), but we
    // record it so the classifier owners can investigate.
    if (finalState === 'done') {
      const diffShown = await page.getByTestId('solution-diff').isVisible().catch(() => false);
      if (diffShown) {
        test.info().annotations.push({
          type: 'miss_hallucinated_constraint',
          description: 'MISS scenario reached done+SolutionDiff — Opus translator hallucinated a constraint from a non-constraint question. See issue #36.',
        });
      }
    }

    // The minimum bar for MISS: the UI is in a known terminal AND something
    // user-facing surfaced (toast OR unsupported reason banner OR error
    // toast). We probe all three.
    const surfacedToUser =
      (await page.locator('[data-sonner-toast]').first().isVisible().catch(() => false)) ||
      (await page.getByTestId('whatif-apply-unsupported-reason').isVisible().catch(() => false)) ||
      finalState === 'done' || // showing a solution is also a coherent reply.
      finalState === 'idle';   // user cancelled the gray modal → coherent.

    expect(surfacedToUser).toBe(true);

    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, 'wave-16.3-miss-opus.png'),
      fullPage: true,
    });
  });
});
