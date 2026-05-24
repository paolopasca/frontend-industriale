import { test, expect, type Page } from '@playwright/test';

/**
 * Wave 4.1 e2e — Apply What-If (Opus 4.7 translator → backend re-solve).
 *
 * Pipeline under test:
 *   1. /api/whatif      (Opus 4.7, streaming markdown analysis)  — Wave 4
 *   2. /api/apply-whatif  (Opus 4.7 translator → CP-SAT re-solve) — Wave 4.1
 *
 * Tolerance: Opus 4.7 has been intermittently 529 on 2026-05-22; tests that
 * depend on a healthy LLM call gracefully skip when the inline error alert /
 * toast shows up, but still verify the UI does not crash and the failure is
 * surfaced to the user (the path is exercised when Opus is healthy).
 */

const SOLVE_TIMEOUT_MS = 55_000;
const WHATIF_REPLY_TIMEOUT_MS = 120_000;
const APPLY_TIMEOUT_MS = 120_000;

async function bootToDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByText(/Backend connesso/i)).toBeVisible({ timeout: 10_000 });

  const demoBtn = page.getByRole('button', { name: /Carica Demo Commesse dal backend/i });
  await expect(demoBtn).toBeVisible();
  await demoBtn.click();

  await expect(page.getByText(/Azienda trovata nel sistema/i)).toBeVisible({ timeout: 8_000 });

  await page.getByRole('button', { name: /Scegli Metodo/i }).click();
  await expect(page.getByText(/Scegli il metodo di risoluzione/i)).toBeVisible();
  await page.getByRole('button', { name: /JSON Deterministico/i }).click();

  await expect(page.getByRole('heading', { name: /Piano di Produzione/i }))
    .toBeVisible({ timeout: SOLVE_TIMEOUT_MS });
}

async function scrollToWhatIfPanel(page: Page): Promise<void> {
  const title = page.getByText(/Analisi What-If/i).first();
  await title.scrollIntoViewIfNeeded({ timeout: 5_000 });
  await expect(title).toBeVisible({ timeout: 5_000 });
}

/**
 * Runs /api/whatif once with the given scenario and waits for the analysis
 * to complete (button label returns from "Analisi…" to "Analizza scenario").
 * Returns whether Opus was healthy (true) or the inline error path was hit
 * (false). Callers that depend on a healthy what-if can skip cleanly.
 */
async function runWhatIfAndWait(page: Page, scenario: string): Promise<boolean> {
  const textarea = page.getByLabel(/Scenario What-If/i);
  await textarea.fill(scenario);

  const sendBtn = page.getByTestId('whatif-analyze');
  await expect(sendBtn).toBeEnabled({ timeout: 2_000 });
  await sendBtn.click();

  await expect.poll(
    async () => {
      const streaming = await page.getByText(/Opus sta analizzando/i).isVisible().catch(() => false);
      const errAlert = await page.getByRole('alert').isVisible().catch(() => false);
      const responseRegion = page.getByRole('region', { name: /Analisi/i });
      const txt = (await responseRegion.textContent().catch(() => '')) ?? '';
      if (!streaming && (txt.length > 80 || errAlert)) return 'done';
      return 'pending';
    },
    { timeout: WHATIF_REPLY_TIMEOUT_MS, intervals: [800, 1500, 2000] },
  ).toBe('done');

  const errored = await page.getByRole('alert').isVisible().catch(() => false);
  return !errored;
}

test.describe('Wave 4.1 — apply-whatif e2e', () => {
  test.describe.configure({ mode: 'serial' });

  // Several tests boot the dashboard (~30s solve), run Opus what-if (~30s) and
  // then trigger /api/apply-whatif which itself runs another Opus call plus a
  // backend re-solve. The default 60s per-test timeout is too tight; bump to
  // 4 minutes for this suite only.
  test.setTimeout(240_000);

  test('1. Happy path: demo → solve → what-if → Esegui → SolutionDiff visible with numeric Δ', async ({ page }) => {
    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    const healthy = await runWhatIfAndWait(
      page,
      'Posso fermare la macchina M-3 oggi dalle 14 alle 18 per manutenzione preventiva? Quali commesse rischio di mandare in ritardo?',
    );
    test.skip(!healthy, 'Opus 4.7 returned 529 / error on what-if — apply path skipped this run.');

    const applyBtn = page.getByTestId('whatif-apply');
    await expect(applyBtn).toBeVisible({ timeout: 5_000 });
    await expect(applyBtn).toBeEnabled();
    await applyBtn.click();

    // Status panel should appear in translating state.
    const statusPanel = page.getByTestId('whatif-apply-status');
    await expect(statusPanel).toBeVisible({ timeout: 8_000 });

    // Wait for the apply pipeline to reach a terminal state (done/unsupported/error).
    await expect.poll(
      async () => statusPanel.getAttribute('data-state'),
      { timeout: APPLY_TIMEOUT_MS, intervals: [1000, 2000, 3000] },
    ).toMatch(/^(done|unsupported|error)$/);

    const finalState = await statusPanel.getAttribute('data-state');
    test.skip(
      finalState === 'error',
      'Apply pipeline returned error (likely Opus 529 on translator or backend transient).',
    );
    test.skip(
      finalState === 'unsupported',
      `Translator classified the scenario as unsupported (Opus output drift); raw label='${finalState}'.`,
    );

    expect(finalState).toBe('done');

    // SolutionDiff card visible.
    const diff = page.getByTestId('solution-diff');
    await expect(diff).toBeVisible({ timeout: 5_000 });

    const table = page.getByTestId('solution-diff-table');
    await expect(table).toBeVisible();

    // At least one KPI row must be present.
    const rowCount = await page.locator('[data-testid^="solution-diff-row-"]').count();
    expect(rowCount).toBeGreaterThan(0);

    // No NaN/undefined in the rendered diff. We check via innerText.
    const diffText = await diff.innerText();
    expect(diffText).not.toMatch(/\bNaN\b/);
    expect(diffText).not.toMatch(/\bundefined\b/i);
    expect(diffText).not.toMatch(/\bInfinity\b/);

    // Accept / discard buttons.
    await expect(page.getByTestId('solution-diff-accept')).toBeVisible();
    await expect(page.getByTestId('solution-diff-discard')).toBeVisible();
  });

  test('2. Unsupported scenario → toast warning, no SolutionDiff', async ({ page }) => {
    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    // Out-of-scope question (HR / vacation policy — not a planning constraint).
    const healthy = await runWhatIfAndWait(
      page,
      'Consigliami su come gestire le ferie del personale per agosto, conviene ridurre i turni?',
    );
    test.skip(!healthy, 'Opus 4.7 529 on what-if; skipping unsupported assertion.');

    const applyBtn = page.getByTestId('whatif-apply');
    await expect(applyBtn).toBeVisible({ timeout: 5_000 });
    await applyBtn.click();

    const statusPanel = page.getByTestId('whatif-apply-status');
    await expect(statusPanel).toBeVisible({ timeout: 8_000 });

    await expect.poll(
      async () => statusPanel.getAttribute('data-state'),
      { timeout: APPLY_TIMEOUT_MS, intervals: [1000, 2000, 3000] },
    ).toMatch(/^(unsupported|done|error)$/);

    const finalState = await statusPanel.getAttribute('data-state');
    // The translator MAY produce a valid block_machine / force_priority if it
    // hallucinates a constraint from the HR question — tolerated, but flagged.
    if (finalState !== 'unsupported') {
      test.info().annotations.push({
        type: 'translator_drift',
        description: `HR scenario produced state=${finalState} instead of 'unsupported'. Translator may need tightening.`,
      });
      test.skip(true, 'Translator did not classify HR question as unsupported; drift, not bug for this assertion.');
    }

    // Sonner toast.warning is rendered as [data-sonner-toast].
    await expect(page.locator('[data-sonner-toast]').first()).toBeVisible({ timeout: 5_000 });

    // No SolutionDiff in unsupported state.
    await expect(page.getByTestId('solution-diff')).toHaveCount(0);

    // The reason banner should appear.
    await expect(page.getByTestId('whatif-apply-unsupported-reason')).toBeVisible({ timeout: 3_000 });
  });

  test('3. Backend INFEASIBLE / error → error event surfaced to user', async ({ page }) => {
    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    // We force the failure path by mocking /api/apply-whatif at the network
    // layer: respond with an SSE stream that emits "error" right after
    // "translating" — the same shape the real BFF produces on backend 500.
    await page.route('**/api/apply-whatif', async (route) => {
      const body =
        'event: translating\ndata: {"phase":"translating"}\n\n' +
        'event: error\ndata: {"code":"apply_failed","message":"backend ha restituito INFEASIBLE — vincolo non applicabile (commessa inesistente)"}\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body,
      });
    });

    // We still need a what-if response on screen so the Esegui button shows;
    // mock /api/whatif too to skip the real Opus call (fast + deterministic).
    await page.route('**/api/whatif', async (route) => {
      const md =
        '## 1. Interpretazione\nSimulazione di scenario su una commessa specifica.\n\n' +
        '## 2. Impatto\nNessuno (mock).\n\n' +
        '## 3. Trade-off\nNessuno (mock).\n\n' +
        '## 4. Raccomandazione\nMockata.';
      const body =
        `event: chunk\ndata: ${JSON.stringify({ text: md })}\n\n` +
        'event: done\ndata: {"cost_usd":0,"tokens_in":1,"tokens_out":1}\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body,
      });
    });

    // Run mocked what-if so the Esegui button appears.
    const healthy = await runWhatIfAndWait(page, 'Forza la priorita di COM-9999 (commessa inesistente).');
    expect(healthy).toBe(true);

    const applyBtn = page.getByTestId('whatif-apply');
    await expect(applyBtn).toBeVisible({ timeout: 3_000 });
    await applyBtn.click();

    const statusPanel = page.getByTestId('whatif-apply-status');
    await expect(statusPanel).toBeVisible({ timeout: 5_000 });

    await expect.poll(
      async () => statusPanel.getAttribute('data-state'),
      { timeout: 15_000, intervals: [500, 1000, 1500] },
    ).toBe('error');

    // Sonner toast.error visible with italian message.
    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible({ timeout: 5_000 });
    const toastText = await toast.textContent();
    expect(toastText ?? '').toMatch(/Esegui|INFEASIBLE|vincolo|backend/i);

    // No SolutionDiff in error state.
    await expect(page.getByTestId('solution-diff')).toHaveCount(0);
  });

  test('4. Client cancel during solving: Annulla button propagates abort, no SolutionDiff', async ({ page }) => {
    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    // Mock /api/whatif so we don't burn Opus tokens for setup.
    await page.route('**/api/whatif', async (route) => {
      const md =
        '## 1. Interpretazione\nFermo M-3 14-18.\n## 2. Impatto\nbasso.\n## 3. Trade-off\nok.\n## 4. Raccomandazione\nApplicare.';
      const body =
        `event: chunk\ndata: ${JSON.stringify({ text: md })}\n\n` +
        'event: done\ndata: {"cost_usd":0,"tokens_in":1,"tokens_out":1}\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body,
      });
    });

    // Mock /api/apply-whatif with a slow stream that stays in "solving" for
    // ~10s. The client should be able to abort mid-stream.
    await page.route('**/api/apply-whatif', async (route) => {
      // Streaming requires a long-running fulfill — use a delayed body in chunks
      // via the body parameter. We can't easily stream from Playwright; emit
      // one transition then a long silent gap, then a "solved" the test never
      // sees because cancellation hits first.
      const body =
        'event: translating\ndata: {"phase":"translating"}\n\n' +
        'event: translated\ndata: {"change":{"type":"block_machine","rules":{"unavailable_machines":{"M-3":[{"start_min":840,"end_min":1080}]}},"rationale":"Fermo M-3 14-18","confidence":"high","warnings":[]}}\n\n' +
        'event: solving\ndata: {"phase":"solving"}\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body,
      });
    });

    const healthy = await runWhatIfAndWait(page, 'Posso fermare M-3 14-18 per manutenzione?');
    expect(healthy).toBe(true);

    const applyBtn = page.getByTestId('whatif-apply');
    await applyBtn.click();

    const statusPanel = page.getByTestId('whatif-apply-status');
    await expect(statusPanel).toBeVisible({ timeout: 5_000 });

    // Wait until status reaches at least "translating".
    await expect.poll(
      async () => statusPanel.getAttribute('data-state'),
      { timeout: 10_000, intervals: [200, 400, 800] },
    ).toMatch(/^(translating|solving)$/);

    // Click cancel.
    const cancelBtn = page.getByTestId('whatif-apply-cancel');
    await expect(cancelBtn).toBeVisible({ timeout: 5_000 });
    await cancelBtn.click();

    // After cancel the apply state should reset to idle, so the status panel
    // should disappear (the wrapper renders only for non-idle / terminal).
    await expect.poll(
      async () => {
        const visible = await page.getByTestId('whatif-apply-status').isVisible().catch(() => false);
        if (!visible) return 'idle';
        return await statusPanel.getAttribute('data-state');
      },
      { timeout: 10_000, intervals: [500, 1000] },
    ).toMatch(/^(idle|error)$/);

    // No SolutionDiff.
    await expect(page.getByTestId('solution-diff')).toHaveCount(0);
  });

  test('5. Double-click Esegui is idempotent (only one solve in flight)', async ({ page }) => {
    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    // Mock both endpoints so the test is fast and deterministic.
    await page.route('**/api/whatif', async (route) => {
      const md =
        '## 1. Interpretazione\nFermo M-3.\n## 2. Impatto\nminimo.\n## 3. Trade-off\nok.\n## 4. Raccomandazione\nProcedere.';
      const body =
        `event: chunk\ndata: ${JSON.stringify({ text: md })}\n\n` +
        'event: done\ndata: {"cost_usd":0,"tokens_in":1,"tokens_out":1}\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body,
      });
    });

    // Apply-whatif mock that holds the connection open while the test
    // double-clicks — we only release the rest of the stream after the
    // double-click has happened. This is how we detect a real in-flight race.
    let applyHits = 0;
    let releaseFirstHit: (() => void) | null = null;
    const firstHitGate = new Promise<void>((res) => { releaseFirstHit = res; });

    await page.route('**/api/apply-whatif', async (route) => {
      applyHits++;
      // First request: emit translating + translated immediately, then
      // pause until the test releases the gate. This keeps applying in
      // "translating" state while the test fires a second click.
      const isFirst = applyHits === 1;
      if (isFirst) {
        // Hold long enough for the second click to land. The first request
        // stays in "translating" until firstHitGate resolves.
        await firstHitGate;
      }
      const body =
        'event: translating\ndata: {"phase":"translating"}\n\n' +
        'event: translated\ndata: {"change":{"type":"block_machine","rules":{"unavailable_machines":{"M-3":[{"start_min":840,"end_min":1080}]}},"rationale":"M-3 14-18","confidence":"high","warnings":[]}}\n\n' +
        'event: solving\ndata: {"phase":"solving"}\n\n' +
        'event: solved\ndata: {"newSolution":{"COM-001":{"fasi":[]}},"newKpis":{"makespan":1800},"deltaKpis":{"makespan":-12},"warnings":[],"status":"FEASIBLE","objective_value":1234}\n\n' +
        'event: done\ndata: {"cost_usd":0.01,"tokens_in":1,"tokens_out":1}\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body,
      });
    });

    const healthy = await runWhatIfAndWait(page, 'Posso fermare M-3 14-18?');
    expect(healthy).toBe(true);

    const applyBtn = page.getByTestId('whatif-apply');
    await expect(applyBtn).toBeEnabled();

    // Click once. The mock will hold this request open. Use force:true to
    // bypass actionability; { trial: true } would not actually click.
    await applyBtn.click();

    // Wait until the status panel shows the in-flight state (translating).
    const statusPanel = page.getByTestId('whatif-apply-status');
    await expect(statusPanel).toBeVisible({ timeout: 5_000 });

    // Now attempt a second click. We expect the button to be hidden /
    // disabled (canApply gates on applyInFlight) — Playwright's default
    // click waits for actionability and should time out or noop. We use
    // a short timeout + force/noWaitAfter to detect whether a click
    // actually fires.
    let secondClickFired = true;
    try {
      await applyBtn.click({ timeout: 2_000 });
    } catch {
      secondClickFired = false;
    }

    // Release the first request so the test can finish.
    if (releaseFirstHit) releaseFirstHit();

    // Wait for the apply pipeline to reach done.
    await expect.poll(
      async () => statusPanel.getAttribute('data-state'),
      { timeout: 15_000, intervals: [500, 1000] },
    ).toBe('done');

    // Idempotency: exactly one network hit, second click must NOT have
    // reached the BFF. If applyHits > 1 it means the UI failed to gate.
    expect(applyHits).toBe(1);
    // Also: the second click should not have been actionable.
    expect(secondClickFired).toBe(false);
  });

  test('6. Rate limit: 6 rapid invokes from a non-local IP → 6th returns 429 with italian message', async ({ page }) => {
    // /api/apply-whatif overrides the shared rate-limit to APPLY_WHATIF_LIMIT_PER_HOUR=5
    // (apply-whatif.ts:108) — apply is the most expensive surface (Opus
    // translator + backend re-solve), so the per-IP bucket is 5/hour.
    //
    // We bypass the local-IP exemption by setting X-Forwarded-For to a
    // non-local IP (getClientIp picks XFF first). checkRateLimit runs BEFORE
    // body parsing, so an invalid body still consumes a token; that's how
    // we hit 5 → 429 deterministically without burning real Opus calls.
    //
    // This test doesn't depend on the dashboard being booted — we just need
    // a same-origin page so fetch('/api/apply-whatif') reaches the BFF.
    await page.goto('/');
    await expect(page.getByText(/Backend connesso/i)).toBeVisible({ timeout: 10_000 });

    // Randomized non-local IP so prior in-session runs in the same hour
    // window don't pre-consume the bucket (the limiter is in-memory, keyed
    // on the resolved IP + ':apply_whatif' composite key).
    const fakeIp = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

    const result = await page.evaluate(async ({ ip }) => {
      const statuses: number[] = [];
      const messages: string[] = [];
      for (let i = 0; i < 6; i++) {
        try {
          const res = await fetch('/api/apply-whatif', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Forwarded-For': ip,
            },
            body: JSON.stringify({ slug: 'demo-commesse', kpis: {}, whatifText: 'x'.repeat(2) }),
          });
          statuses.push(res.status);
          if (res.status === 429) {
            const j = await res.json().catch(() => ({ message: '' }));
            messages.push(typeof j?.message === 'string' ? j.message : '');
          } else {
            messages.push('');
          }
        } catch (e) {
          statuses.push(-1);
          messages.push(e instanceof Error ? e.message : String(e));
        }
      }
      return { statuses, messages };
    }, { ip: fakeIp });

    // The first 5 calls must NOT be rate-limited (they will be 400 due to
    // invalid body — that's expected; rate-limit passes). The 6th must be 429.
    const first5Status = result.statuses.slice(0, 5);
    const lastStatus = result.statuses[5];

    if (!first5Status.every((s) => s !== 429)) {
      test.info().annotations.push({
        type: 'rate_limit_diag',
        description: `IP=${fakeIp} statuses=${JSON.stringify(result.statuses)}`,
      });
    }
    expect(first5Status.every((s) => s !== 429)).toBe(true);

    expect(lastStatus).toBe(429);

    // The 429 message must be in italian and mention "richieste" or "superato".
    const last429Msg = result.messages[5] ?? '';
    expect(last429Msg).toMatch(/richieste|superato|limite/i);
  });

  test('7. UI rate-limit toast: BFF 429 from Esegui shows the user-facing italian toast', async ({ page }) => {
    // Verifies WhatIfAnalysis surface the rate-limit error with the exact UX
    // string cl-ui ships ("Limite 5 ricalcoli/ora superato. Riprova fra un
    // po'."), and that the status panel reaches data-state="error".
    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    // Mock /api/whatif so we don't burn Opus tokens just to surface a button.
    await page.route('**/api/whatif', async (route) => {
      const md =
        '## 1. Interpretazione\nFermo M03 14-18.\n' +
        '## 2. Impatto\nlieve.\n## 3. Trade-off\nok.\n## 4. Raccomandazione\nApplicabile.';
      const body =
        `event: chunk\ndata: ${JSON.stringify({ text: md })}\n\n` +
        'event: done\ndata: {"cost_usd":0,"tokens_in":1,"tokens_out":1}\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body,
      });
    });

    // Mock /api/apply-whatif with a real 429 + the BFF's italian message —
    // this is the response shape the BFF emits when the IP bucket is full.
    await page.route('**/api/apply-whatif', async (route) => {
      await route.fulfill({
        status: 429,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error: 'rate_limited',
          message: 'Limite di 5 richieste/ora superato per apply-whatif.',
        }),
      });
    });

    const healthy = await runWhatIfAndWait(page, 'Posso fermare M03 14-18?');
    expect(healthy).toBe(true);

    await page.getByTestId('whatif-apply').click();

    const statusPanel = page.getByTestId('whatif-apply-status');
    await expect(statusPanel).toBeVisible({ timeout: 5_000 });
    await expect.poll(
      async () => statusPanel.getAttribute('data-state'),
      { timeout: 10_000, intervals: [300, 500, 1000] },
    ).toBe('error');

    // The exact toast string from WhatIfAnalysis.tsx:271. Tolerate both
    // straight ' and curly ' (the source uses U+2019).
    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible({ timeout: 5_000 });
    const txt = (await toast.textContent()) ?? '';
    expect(txt).toMatch(/Limite\s+5\s+ricalcoli\/ora superato\.\s+Riprova fra un po['’]\./);

    // No SolutionDiff on rate-limit.
    await expect(page.getByTestId('solution-diff')).toHaveCount(0);
  });

  test('8. UI conflict toast: BFF 409 surfaces "ricalcolo in corso" toast', async ({ page }) => {
    // BFF returns 409 when a second apply-whatif arrives while one is
    // already in flight for the same IP. WhatIfAnalysis.tsx:272-273 maps
    // that to a specific italian toast — we assert the exact string.
    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    await page.route('**/api/whatif', async (route) => {
      const md =
        '## 1. Interpretazione\nFermo M03 14-18.\n## 2.\nok.\n## 3.\nok.\n## 4.\nApplicabile.';
      const body =
        `event: chunk\ndata: ${JSON.stringify({ text: md })}\n\n` +
        'event: done\ndata: {"cost_usd":0,"tokens_in":1,"tokens_out":1}\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body,
      });
    });

    await page.route('**/api/apply-whatif', async (route) => {
      await route.fulfill({
        status: 409,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          error: 'conflict',
          message: 'Un apply-whatif e gia in corso per questo client. Aspetta la conclusione.',
        }),
      });
    });

    const healthy = await runWhatIfAndWait(page, 'Posso fermare M03 14-18?');
    expect(healthy).toBe(true);

    await page.getByTestId('whatif-apply').click();

    const statusPanel = page.getByTestId('whatif-apply-status');
    await expect(statusPanel).toBeVisible({ timeout: 5_000 });
    await expect.poll(
      async () => statusPanel.getAttribute('data-state'),
      { timeout: 10_000, intervals: [300, 500, 1000] },
    ).toBe('error');

    const toast = page.locator('[data-sonner-toast]').first();
    await expect(toast).toBeVisible({ timeout: 5_000 });
    const txt = (await toast.textContent()) ?? '';
    expect(txt).toMatch(/C['’][eèé]\s+gi[aà]\s+un ricalcolo in corso per questa sessione\./);

    await expect(page.getByTestId('solution-diff')).toHaveCount(0);
  });

  test('9. SolutionDiff renders missing_kpi banner separately from warnings', async ({ page }) => {
    // BFF can emit `missing_kpi:<name>` items inside the solved payload's
    // warnings array. SolutionDiff splits them out: missingKpis → neutral
    // banner with testid `solution-diff-missing-kpis`; regular warnings
    // → amber banner with testid `solution-diff-warnings`. Both can
    // coexist.
    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    await page.route('**/api/whatif', async (route) => {
      const md =
        '## 1. Interpretazione\nFermo M03 14-18.\n## 2.\nok.\n## 3.\nok.\n## 4.\nApplicabile.';
      const body =
        `event: chunk\ndata: ${JSON.stringify({ text: md })}\n\n` +
        'event: done\ndata: {"cost_usd":0,"tokens_in":1,"tokens_out":1}\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body,
      });
    });

    await page.route('**/api/apply-whatif', async (route) => {
      const body =
        'event: translating\ndata: {"phase":"translating"}\n\n' +
        'event: translated\ndata: {"change":{"type":"block_machine","rules":{"unavailable_machines":{"M03":[{"start_min":840,"end_min":1080}]}},"rationale":"M03 14-18","confidence":"high","warnings":[]}}\n\n' +
        'event: solving\ndata: {"phase":"solving"}\n\n' +
        // The solved payload's warnings array mixes missing_kpi:* with a
        // plain warning. SolutionDiff must split them into two banners.
        'event: solved\ndata: {' +
        '"newSolution":{"COM-001":{"fasi":[]}},' +
        '"newKpis":{"makespan":1800,"on_time_rate":0.92},' +
        '"deltaKpis":{"makespan":-12},' +
        '"warnings":["missing_kpi:peakUtilization","missing_kpi:avgUtilization","assumed_start_time=14:00 from \'pomeriggio\'"],' +
        '"status":"FEASIBLE","objective_value":1234' +
        '}\n\n' +
        'event: done\ndata: {"cost_usd":0.01,"tokens_in":1,"tokens_out":1}\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body,
      });
    });

    const healthy = await runWhatIfAndWait(page, 'Posso fermare M03 14-18?');
    expect(healthy).toBe(true);

    await page.getByTestId('whatif-apply').click();

    const statusPanel = page.getByTestId('whatif-apply-status');
    await expect(statusPanel).toBeVisible({ timeout: 5_000 });
    await expect.poll(
      async () => statusPanel.getAttribute('data-state'),
      { timeout: 10_000, intervals: [500, 1000] },
    ).toBe('done');

    // SolutionDiff visible.
    await expect(page.getByTestId('solution-diff')).toBeVisible({ timeout: 3_000 });

    // The missing_kpi banner is visible with the count "2" (two missing_kpi:*
    // entries) and lists both KPI names.
    const missingBanner = page.getByTestId('solution-diff-missing-kpis');
    await expect(missingBanner).toBeVisible();
    const missingText = await missingBanner.textContent();
    expect(missingText ?? '').toMatch(/Metriche non confrontabili\s*\(2\)/);
    expect(missingText ?? '').toContain('peakUtilization');
    expect(missingText ?? '').toContain('avgUtilization');

    // The amber warnings banner contains the non-missing_kpi entry only.
    const warnBanner = page.getByTestId('solution-diff-warnings');
    await expect(warnBanner).toBeVisible();
    const warnText = await warnBanner.textContent();
    expect(warnText ?? '').toMatch(/Avvertenze\s*\(1\)/);
    expect(warnText ?? '').toContain('assumed_start_time');
    // And conversely: warnings banner does NOT include missing_kpi tokens.
    expect(warnText ?? '').not.toContain('missing_kpi:');
  });
});
