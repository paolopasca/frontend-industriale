import { test, expect, type Page } from '@playwright/test';

/**
 * Wave 5 e2e — Sub-order decomposition panel (SplitSuggestion, Opus 4.7).
 *
 * Mirrors the bootstrap from wave3-chat.spec.ts: load demo company, run the
 * deterministic JSON solve, then assert the SplitSuggestion card is visible
 * on the dashboard. Streaming/copy flows tolerate Opus 4.7 transient 529.
 */

const SOLVE_TIMEOUT_MS = 55_000;
const SPLIT_REPLY_TIMEOUT_MS = 60_000;

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

test.describe('Wave 5 — SplitSuggestion panel', () => {
  test('panel visible post-solve with populated commesse dropdown', async ({ page }) => {
    await bootToDashboard(page);

    // The card title "Sotto-commesse" identifies the SplitSuggestion card.
    const splitTitle = page.getByText(/Sotto-commesse/i).first();
    await expect(splitTitle).toBeVisible({ timeout: 10_000 });

    // Dropdown with aria-label "Commessa da decomporre".
    const dropdown = page.getByLabel(/Commessa da decomporre/i);
    await expect(dropdown).toBeVisible({ timeout: 5_000 });
    await expect(dropdown).toBeEnabled();

    // Dropdown must have at least 1 option (extractCandidates produced something).
    const optionCount = await dropdown.locator('option').count();
    expect(optionCount).toBeGreaterThanOrEqual(1);

    // First option text should follow the "COM-XXX — N op., M min, K macchina/e" pattern.
    const firstOptionText = await dropdown.locator('option').first().textContent();
    expect(firstOptionText).toMatch(/—\s+\d+\s+op\./);

    // "Suggerisci split" button visible + enabled (since a candidate is preselected).
    const splitBtn = page.getByRole('button', { name: /Suggerisci split/i });
    await expect(splitBtn).toBeVisible();
    await expect(splitBtn).toBeEnabled();
  });

  test('click Suggerisci split streams output then either reply or graceful error', async ({ page }) => {
    await bootToDashboard(page);

    await expect(page.getByText(/Sotto-commesse/i).first()).toBeVisible({ timeout: 10_000 });

    const splitBtn = page.getByRole('button', { name: /Suggerisci split/i });
    await expect(splitBtn).toBeEnabled();
    await splitBtn.click();

    // While streaming the button label flips to "Analisi…".
    await expect(page.getByRole('button', { name: /Analisi/i }))
      .toBeVisible({ timeout: 5_000 });

    // Streaming region with aria-label "Analisi split in corso".
    const region = page.getByRole('region', { name: /Analisi split in corso|Proposta di split/i });
    await expect(region).toBeVisible({ timeout: 10_000 });

    // Wait until either:
    //   (a) the button label returns to "Suggerisci split" AND the region has content > 200 chars, OR
    //   (b) an alert or error toast appears (acceptable on Opus 4.7 529 overload).
    await expect.poll(
      async () => {
        const streamingBtn = await page.getByRole('button', { name: /Analisi/i }).isVisible().catch(() => false);
        const errorAlert = await page.getByRole('alert').isVisible().catch(() => false);
        const errorToast = await page.locator('[role="status"], [data-sonner-toast]').first().isVisible().catch(() => false);
        const regionText = (await region.textContent().catch(() => '')) ?? '';
        const hasReply = regionText.length > 200;
        if (!streamingBtn && (hasReply || errorAlert || errorToast)) return 'done';
        return 'pending';
      },
      { timeout: SPLIT_REPLY_TIMEOUT_MS, intervals: [500, 1000, 2000] },
    ).toBe('done');
  });

  test('Copia button copies the proposal to clipboard', async ({ page, context }) => {
    // Grant clipboard permissions for this test.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await bootToDashboard(page);
    await expect(page.getByText(/Sotto-commesse/i).first()).toBeVisible({ timeout: 10_000 });

    const splitBtn = page.getByRole('button', { name: /Suggerisci split/i });
    await splitBtn.click();

    // Wait for streaming to finish (button returns to "Suggerisci split") OR for an alert.
    await expect.poll(
      async () => {
        const streamingBtn = await page.getByRole('button', { name: /Analisi/i }).isVisible().catch(() => false);
        const errorAlert = await page.getByRole('alert').isVisible().catch(() => false);
        if (!streamingBtn || errorAlert) return 'done';
        return 'pending';
      },
      { timeout: SPLIT_REPLY_TIMEOUT_MS, intervals: [500, 1000, 2000] },
    ).toBe('done');

    // If we got an error toast/alert (Opus overloaded), skip the copy assertion.
    const errorVisible = await page.getByRole('alert').isVisible().catch(() => false);
    if (errorVisible) {
      test.info().annotations.push({ type: 'note', description: 'Opus 4.7 returned an error; copy assertion skipped.' });
      return;
    }

    // Copy button has aria-label "Copia".
    const copyBtn = page.getByRole('button', { name: /^Copia$/i });
    await expect(copyBtn).toBeVisible({ timeout: 5_000 });
    await copyBtn.click();

    // Sonner toast "Copiato" should appear briefly.
    await expect(page.getByText(/Copiato/i).first()).toBeVisible({ timeout: 5_000 });

    // Verify clipboard contents non-empty (browser permission may still block
    // navigator.clipboard.readText in headless; tolerate that gracefully).
    const clip = await page.evaluate(async () => {
      try { return await navigator.clipboard.readText(); }
      catch { return null; }
    });
    if (clip != null) {
      expect(clip.length).toBeGreaterThan(50);
      expect(clip).toMatch(/## Diagnosi|## Proposta di split/i);
    }
  });
});
