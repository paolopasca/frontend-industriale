import { test, expect, type Page } from '@playwright/test';

/**
 * Wave 7 e2e — cutoff cushion UI selector.
 *
 * The cutoff selector (WhatIfAnalysis.tsx, w7-ui-cutoff-diff) lets the
 * manager choose how soon after `now` the BFF starts recalculating:
 *   - Adesso       (cushion=0)
 *   - +30 min      (cushion=30, default)
 *   - +1 h         (cushion=60)
 *   - Personalizza (datetime-local input → custom cutoff timestamp)
 *
 * The component must:
 *   1. start with +30 active (default)
 *   2. update aria-checked when a radio is clicked (Radix Button role=radio)
 *   3. show the datetime-local input only when Personalizza is active
 *
 * These tests do NOT trigger /api/apply-whatif end-to-end (covered in
 * wave7-real-effect.spec.ts Test 6). They only verify the selector primitive.
 */

const SOLVE_TIMEOUT_MS = 90_000;

async function bootToDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByText(/Backend connesso/i)).toBeVisible({ timeout: 30_000 });

  // SetupPage.tsx fires listCompanies() on mount; the demo button needs
  // the resolved list to look up `demo-commesse` and trigger the auto-
  // populate flow. Until the list arrives the onClick is a silent no-op.
  // Retry the click until Azienda trovata appears.
  const demoBtn = page.getByRole('button', { name: /Carica Demo Commesse dal backend/i });
  await expect(demoBtn).toBeVisible();

  const aziendaTrovata = page.getByText(/Azienda trovata nel sistema/i);
  let appeared = false;
  for (let attempt = 0; attempt < 6 && !appeared; attempt++) {
    if (attempt > 0) await page.waitForTimeout(1500);
    await demoBtn.click().catch(() => { /* hidden after the working click */ });
    try {
      await aziendaTrovata.waitFor({ state: 'visible', timeout: 4_000 });
      appeared = true;
    } catch { /* retry */ }
  }
  expect(appeared, 'Demo onboarding must appear').toBe(true);

  await page.getByRole('button', { name: /Scegli Metodo/i }).click();
  await page.getByRole('button', { name: /JSON Deterministico/i }).click();

  await expect(page.getByRole('heading', { name: /Piano di Produzione/i }))
    .toBeVisible({ timeout: SOLVE_TIMEOUT_MS });
}

async function scrollToWhatIfPanel(page: Page): Promise<void> {
  const title = page.getByText(/Analisi What-If/i).first();
  await title.scrollIntoViewIfNeeded({ timeout: 5_000 });
  await expect(title).toBeVisible({ timeout: 5_000 });
}

test.describe('Wave 7 — Cutoff cushion selector', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('1. defaults to +30 min on first render', async ({ page }) => {
    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    const selector = page.getByTestId('whatif-cutoff-selector');
    await expect(selector).toBeVisible({ timeout: 5_000 });

    const plus30 = page.getByTestId('whatif-cutoff-30m');
    await expect(plus30).toHaveAttribute('aria-checked', 'true');

    // The other three radios must be unchecked.
    await expect(page.getByTestId('whatif-cutoff-now')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('whatif-cutoff-1h')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('whatif-cutoff-custom')).toHaveAttribute('aria-checked', 'false');

    // datetime-local input must NOT be visible until Personalizza is active.
    await expect(page.getByTestId('whatif-cutoff-input')).toHaveCount(0);
  });

  test('2. clicking +1 h flips aria-checked and de-checks the previous radio', async ({ page }) => {
    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    const plus30 = page.getByTestId('whatif-cutoff-30m');
    const plus1h = page.getByTestId('whatif-cutoff-1h');
    await expect(plus1h).toBeVisible({ timeout: 5_000 });

    await plus1h.click();

    await expect(plus1h).toHaveAttribute('aria-checked', 'true');
    await expect(plus30).toHaveAttribute('aria-checked', 'false');
  });

  test('3. Personalizza opens datetime-local input', async ({ page }) => {
    await bootToDashboard(page);
    await scrollToWhatIfPanel(page);

    const custom = page.getByTestId('whatif-cutoff-custom');
    await expect(custom).toBeVisible({ timeout: 5_000 });

    // Pre-click: input must not be rendered.
    await expect(page.getByTestId('whatif-cutoff-input')).toHaveCount(0);

    await custom.click();
    await expect(custom).toHaveAttribute('aria-checked', 'true');

    // Post-click: input must appear.
    const dtInput = page.getByTestId('whatif-cutoff-input');
    await expect(dtInput).toBeVisible({ timeout: 3_000 });

    // Fill a future-ish value — verify the input retains it. We don't
    // exercise the request body here (Test 6 in wave7-real-effect does).
    await dtInput.fill('2026-04-02T14:30');
    await expect(dtInput).toHaveValue('2026-04-02T14:30');
  });
});
