import { test, expect, type Page, type Request } from '@playwright/test';

/**
 * Wave 2 e2e — ExplanationPanel + AdvisorPanel.
 *
 * Each test drives the full onboarding → solve → dashboard flow on the
 * `demo-commesse` company, then exercises a panel-specific behaviour.
 *
 * The panels stream via SSE from `/api/explain` and `/api/advise`. Tests
 * assert the loading state appears quickly and the streamed body lands
 * within a generous 35s budget (Sonnet 4.6 worst-case TTFT + full body).
 */

const SOLVE_TIMEOUT_MS = 55_000;
const PANEL_TEXT_TIMEOUT_MS = 35_000;
const LOADING_HINT_TIMEOUT_MS = 1_500;

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

test.describe('Wave 2 — ExplanationPanel', () => {
  test('shows loading hint then renders italian text from /api/explain', async ({ page }) => {
    const explainCalls: Request[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/explain') && req.method() === 'POST') {
        explainCalls.push(req);
      }
    });

    await bootToDashboard(page);

    // Loading hint appears almost immediately after the dashboard mounts.
    await expect(page.getByText(/DAINO AI sta analizzando il piano/i))
      .toBeVisible({ timeout: LOADING_HINT_TIMEOUT_MS + 2_000 });

    // The card title "Spiegazione AI" is the most stable anchor for the panel.
    const panel = page.locator('div').filter({
      has: page.getByRole('heading', { name: /Spiegazione AI/i }).or(page.getByText(/Spiegazione AI/i)),
    }).first();
    await expect(panel).toBeVisible();

    // Wait for the streamed body to land. Italian text heuristic: 60+ chars
    // including at least one common Italian word.
    await expect.poll(
      async () => {
        const txt = await panel.innerText();
        // Strip the title/cost line away (looking for body content).
        return txt.length;
      },
      { timeout: PANEL_TEXT_TIMEOUT_MS, intervals: [500, 1000] },
    ).toBeGreaterThan(80);

    const fullText = await panel.innerText();
    expect(fullText).toMatch(/(pianificazione|commesse|macchina|setup|costo|tempi|saturazione|on-time|piano|ottimale)/i);

    expect(explainCalls.length).toBeGreaterThanOrEqual(1);
  });

  test('"Rigenera" button triggers a second /api/explain call', async ({ page }) => {
    const explainCalls: Request[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/explain') && req.method() === 'POST') {
        explainCalls.push(req);
      }
    });

    await bootToDashboard(page);

    // Wait for the first stream to complete (cost stamp `· $0.xxxx` appears
    // once the SSE `done` event fires, replacing the loading state).
    await expect(page.locator('text=/·\\s*\\$/').first())
      .toBeVisible({ timeout: PANEL_TEXT_TIMEOUT_MS });

    const callsBeforeRegenerate = explainCalls.length;
    expect(callsBeforeRegenerate).toBeGreaterThanOrEqual(1);

    // Click "Rigenera spiegazione" (the explainer regenerate button).
    const regenerateBtn = page.getByRole('button', { name: /Rigenera spiegazione/i });
    await expect(regenerateBtn).toBeEnabled({ timeout: 5_000 });
    await regenerateBtn.click();

    // Second call should fire shortly after click.
    await expect.poll(
      () => explainCalls.length,
      { timeout: 5_000, intervals: [100, 250, 500] },
    ).toBeGreaterThan(callsBeforeRegenerate);
  });

  test('"Copia" button places explanation text into clipboard', async ({ page, context }) => {
    // Grant clipboard permissions before navigating.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await bootToDashboard(page);

    // Wait for stream completion (cost stamp appears).
    await expect(page.locator('text=/·\\s*\\$/').first())
      .toBeVisible({ timeout: PANEL_TEXT_TIMEOUT_MS });

    const copyBtn = page.getByRole('button', { name: /Copia spiegazione/i });
    await expect(copyBtn).toBeEnabled({ timeout: 5_000 });
    await copyBtn.click();

    // Clipboard should contain non-empty italian explanation text.
    const clipboard = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return '';
      }
    });
    expect(clipboard.length).toBeGreaterThan(40);
    expect(clipboard).toMatch(/(pianificazione|commesse|macchina|setup|costo|piano|ottimale|saturazione)/i);
  });
});

test.describe('Wave 2 — AdvisorPanel', () => {
  test('streams numbered recommendations with at least 3 bullets', async ({ page }) => {
    await bootToDashboard(page);

    // Loading hint for advisor.
    await expect(page.getByText(/DAINO AI sta cercando opportunita/i))
      .toBeVisible({ timeout: LOADING_HINT_TIMEOUT_MS + 2_000 });

    // Scope to the Consigli AI card.
    const advisorCard = page.locator('div').filter({
      has: page.getByText(/Consigli AI/i),
    }).first();
    await expect(advisorCard).toBeVisible();

    // The advisor renders each numbered recommendation as a <li> inside a
    // <ul>. AdvisorPanel.splitParagraphs() strips the leading "1." numbering,
    // so we count the rendered <li> elements directly rather than searching
    // for "1." / "2." prefixes in innerText.
    const bullets = advisorCard.locator('ul > li');

    await expect.poll(
      async () => bullets.count(),
      { timeout: PANEL_TEXT_TIMEOUT_MS, intervals: [500, 1000] },
    ).toBeGreaterThanOrEqual(3);

    const fullText = await advisorCard.innerText();
    // Must contain at least one of the prescribed advisor emoji markers.
    expect(fullText).toMatch(/(⚠️|🟡|✅|📋)/);
  });
});
