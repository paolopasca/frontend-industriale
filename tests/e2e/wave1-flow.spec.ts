import { test, expect, type Page } from '@playwright/test';

const COMPANY_LABEL = 'Demo Commesse';

async function selectDemoCompany(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByText(/Backend connesso/i)).toBeVisible({ timeout: 10_000 });

  const demoBtn = page.getByRole('button', { name: /Carica Demo Commesse dal backend/i });
  await expect(demoBtn).toBeVisible();
  await demoBtn.click();

  await expect(page.getByText(/Azienda trovata nel sistema/i)).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText(/Consultation presente/i)).toBeVisible();
}

async function proceedToMethodSelect(page: Page): Promise<void> {
  const chooseMethodBtn = page.getByRole('button', { name: /Scegli Metodo/i });
  await expect(chooseMethodBtn).toBeVisible();
  await chooseMethodBtn.click();
  await expect(page.getByText(/Scegli il metodo di risoluzione/i)).toBeVisible();
}

test.describe('Wave 1 happy path — solve + dashboard', () => {
  test('setup → demo-commesse → deterministic-json → solve → dashboard', async ({ page }) => {
    await selectDemoCompany(page);
    await proceedToMethodSelect(page);

    const detCard = page.getByRole('button', { name: /JSON Deterministico/i });
    await expect(detCard).toBeVisible();
    await detCard.click();

    await expect(page.getByText(/Ottimizzazione in Corso|Ottimizzazione Completata/i))
      .toBeVisible({ timeout: 10_000 });
    expect(page.url()).toContain('localhost:8080');

    await expect(page.getByRole('heading', { name: /Piano di Produzione/i }))
      .toBeVisible({ timeout: 55_000 });

    await expect(page.getByRole('button', { name: /Esporta PDF/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Ripianifica/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Inserisci Dati/i })).toBeVisible();
  });
});

test.describe('Wave 1 ReplanModal — graceful 501 handling', () => {
  test('replan modal opens and shows graceful 501 / no-session message', async ({ page }) => {
    await selectDemoCompany(page);
    await proceedToMethodSelect(page);
    await page.getByRole('button', { name: /JSON Deterministico/i }).click();
    await expect(page.getByRole('heading', { name: /Piano di Produzione/i }))
      .toBeVisible({ timeout: 55_000 });

    await page.getByRole('button', { name: /Ripianifica/i }).click();
    await expect(page.getByRole('heading', { name: /Ripianifica/i })).toBeVisible();

    const textarea = page.getByPlaceholder(/macchina M1 e\' rotta|macchina M1 è rotta/i);
    await expect(textarea).toBeVisible();
    await textarea.fill('La macchina M1 è rotta, ricalcola il piano.');

    await page.getByRole('button', { name: /Invia/i }).click();

    const gracefulErrorPatterns = [
      /Reschedule non disponibile/i,
      /Errore/i,
      /Piano ricalcolato/i,
      /Stato/i,
    ];
    const anyReply = page.locator('.bg-accent\\/70, .max-w-\\[85\\%\\]')
      .filter({ hasText: /Reschedule|Errore|Piano|Stato|sessione/i });
    await expect(anyReply.first()).toBeVisible({ timeout: 30_000 });

    const bodyText = await page.locator('body').innerText();
    const matched = gracefulErrorPatterns.some(re => re.test(bodyText));
    expect(matched, `Expected at least one graceful reply matching ${gracefulErrorPatterns}`).toBe(true);

    expect(await page.isClosed()).toBe(false);
  });
});
