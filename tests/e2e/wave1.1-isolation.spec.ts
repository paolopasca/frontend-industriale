import { test, expect, type Page } from '@playwright/test';

/**
 * Wave 1.1 — localStorage isolation across tenants.
 *
 * Background:
 *   Wave 1 stored chat history and session/run IDs under GLOBAL localStorage
 *   keys (`replan_chat_messages`, `daino_last_session_id`, `daino_last_run_id`).
 *   This leaked chat history and session pointers across tenants. Wave 1.1
 *   namespaced everything under `daino:<slug>:<key>` via `src/lib/storage.ts`
 *   and added `migrateLegacyKeys()` (called from ReplanModal on first mount)
 *   to clean up the old global keys.
 *
 * These tests verify the namespacing actually isolates tenants, and the
 * migration actually removes legacy keys when ReplanModal mounts.
 */

const LEGACY_KEYS = [
  'replan_chat_messages',
  'daino_last_session_id',
  'daino_last_run_id',
] as const;

async function backendHealthy(): Promise<boolean> {
  try {
    const r = await fetch('http://127.0.0.1:8001/api/health', {
      signal: AbortSignal.timeout(3_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function selectCompanyByName(page: Page, displayName: string): Promise<void> {
  // The autocomplete dropdown opens when the user types into the input;
  // the input has placeholder "es. Demo Commesse, Apex Toy...". We type
  // a prefix and then click the matching button.
  const nameInput = page.getByPlaceholder(/Demo Commesse|Apex Toy/i);
  await expect(nameInput).toBeVisible({ timeout: 10_000 });
  await nameInput.fill(displayName);
  // The autocomplete renders <button> rows; click the row whose label
  // matches the full display name.
  const row = page.getByRole('button', { name: new RegExp(`^${displayName}\\s`, 'i') }).first();
  await expect(row).toBeVisible({ timeout: 8_000 });
  await row.click();
  await expect(page.getByText(/Azienda trovata nel sistema/i)).toBeVisible({ timeout: 8_000 });
}

async function solveDeterministic(page: Page): Promise<void> {
  const sceglMetodo = page.getByRole('button', { name: /Scegli Metodo/i });
  await expect(sceglMetodo).toBeVisible({ timeout: 10_000 });
  await expect(sceglMetodo).toBeEnabled({ timeout: 10_000 });
  // The setup step row re-renders when companyLoaded.has_consultation flips
  // (the steps list shrinks from 4 to 1), which can detach the footer
  // buttons mid-click. Wait a tick for the DOM to settle.
  await page.waitForTimeout(200);
  await sceglMetodo.click();
  await expect(page.getByText(/Scegli il metodo di risoluzione/i)).toBeVisible();
  await page.getByRole('button', { name: /JSON Deterministico/i }).click();
  await expect(page.getByRole('heading', { name: /Piano di Produzione/i })).toBeVisible({
    timeout: 60_000,
  });
}

async function solveDeterministicAndOpenReplan(page: Page): Promise<void> {
  await solveDeterministic(page);
  await page.getByRole('button', { name: /Ripianifica/i }).click();
  await expect(page.getByRole('heading', { name: /Ripianifica/i })).toBeVisible();
}

function decodeJwtPayload(token: string): { user_id?: number; tenant_id?: number; exp?: number } {
  // Token shape: header.payload.signature — base64url segments.
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error(`Invalid JWT: ${parts.length} segments`);
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  // Pad to multiple of 4 for atob/Buffer.
  const pad = payload.length % 4 === 0 ? '' : '='.repeat(4 - (payload.length % 4));
  const decoded = Buffer.from(payload + pad, 'base64').toString('utf-8');
  return JSON.parse(decoded);
}

async function readChatStorageKeys(page: Page): Promise<{ keys: string[]; map: Record<string, string | null> }> {
  return page.evaluate(() => {
    const keys: string[] = [];
    const map: Record<string, string | null> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      keys.push(k);
      map[k] = localStorage.getItem(k);
    }
    return { keys, map };
  });
}

test.describe('Wave 1.1 — localStorage isolation across tenants', () => {
  test('Replan chat history is namespaced per tenant and does not bleed across switches', async ({ page }) => {
    test.skip(!(await backendHealthy()), 'backend not reachable on :8001');

    // ── Step 1: solve on demo-commesse via the "Carica Demo Commesse" button.
    await page.goto('/');
    await expect(page.getByText(/Backend connesso/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Carica Demo Commesse dal backend/i }).click();
    await expect(page.getByText(/Azienda trovata nel sistema/i)).toBeVisible({ timeout: 8_000 });
    await solveDeterministicAndOpenReplan(page);

    // ── Step 2: send a message in the Replan chat so something gets persisted.
    const demoMessage = 'Macchina M1 rotta — demo-commesse session';
    await page.getByPlaceholder(/macchina M1 e\' rotta|macchina M1 è rotta/i).fill(demoMessage);
    await page.getByRole('button', { name: /Invia/i }).click();

    // Wait for the assistant to respond (or error gracefully) — this also
    // confirms the user message has been pushed into state and persisted.
    const anyReply = page
      .locator('.bg-accent\\/70, .max-w-\\[85\\%\\]')
      .filter({ hasText: /Reschedule|Errore|Piano|Stato|sessione/i });
    await expect(anyReply.first()).toBeVisible({ timeout: 30_000 });

    // ── Step 3: verify the namespaced key was written and contains the msg.
    const demoChatKey = 'daino:demo-commesse:replan_chat_messages';
    const afterDemoSend = await readChatStorageKeys(page);
    expect(
      afterDemoSend.keys,
      `Expected namespaced chat key after demo-commesse send. Saw: ${afterDemoSend.keys.join(', ')}`,
    ).toContain(demoChatKey);
    expect(afterDemoSend.map[demoChatKey] ?? '').toContain(demoMessage);

    // The apex-toy key MUST NOT exist (no apex-toy chat has happened).
    expect(afterDemoSend.keys).not.toContain('daino:apex-toy:replan_chat_messages');

    // No legacy global keys should be present (migrateLegacyKeys runs on
    // ReplanModal mount and the app itself never writes them anymore).
    for (const legacy of LEGACY_KEYS) {
      expect(
        afterDemoSend.keys,
        `Legacy global key "${legacy}" should not be present after Wave 1.1. Keys: ${afterDemoSend.keys.join(', ')}`,
      ).not.toContain(legacy);
    }

    // ── Step 4: close the modal via backdrop click, then "Nuova Ottimizzazione".
    // NOTE: DashboardHeader.handleReset calls clearSlugScoped(companySlug),
    // which removes every `daino:demo-commesse:*` key including the chat.
    // This is intentional Wave-1.1 design (clean slate on reset for the
    // tenant being exited). The cross-tenant isolation invariant we
    // verify here is: the apex-toy chat NEVER contains demo-commesse data,
    // regardless of what survives the reset.
    await page.evaluate(() => {
      const overlay = document.querySelector('.fixed.inset-0.z-50.bg-background\\/80');
      (overlay as HTMLElement | null)?.click();
    });
    await expect(page.getByRole('heading', { name: /Ripianifica/i })).toBeHidden({ timeout: 5_000 });
    await page.getByRole('button', { name: /Nuova Ottimizzazione/i }).click();
    await expect(page.getByPlaceholder(/Demo Commesse|Apex Toy/i)).toBeVisible({ timeout: 10_000 });

    // After reset on demo-commesse, its chat key was cleared.
    const afterReset = await readChatStorageKeys(page);
    expect(
      afterReset.keys,
      `clearSlugScoped(demo-commesse) should remove the demo-commesse chat key on reset. Saw: ${afterReset.keys.join(', ')}`,
    ).not.toContain(demoChatKey);

    // ── Step 5: pick apex-toy via the autocomplete and re-solve.
    await selectCompanyByName(page, 'Apex Toy');
    await solveDeterministicAndOpenReplan(page);

    // ── Step 6: the chat in the new tenant is EMPTY (only WELCOME bubble).
    const bodyText = await page.locator('body').innerText();
    expect(
      bodyText,
      'apex-toy ReplanModal must not contain the demo-commesse user message',
    ).not.toContain(demoMessage);

    const messageBubbles = page.locator('.max-w-\\[85\\%\\]');
    const bubbleCount = await messageBubbles.count();
    expect(
      bubbleCount,
      `Expected exactly 1 bubble (the WELCOME) in a fresh tenant, saw ${bubbleCount}`,
    ).toBe(1);
    const firstBubbleText = (await messageBubbles.first().innerText()).trim();
    expect(firstBubbleText).toMatch(/^Ciao!/);

    // ── Step 7: localStorage now scoped to apex-toy only; no demo-commesse
    // bleed, no legacy globals re-introduced.
    const afterApexOpen = await readChatStorageKeys(page);
    const apexChatKey = 'daino:apex-toy:replan_chat_messages';
    // The apex-toy chat key may exist (WELCOME-only payload) — verify
    // it does NOT contain the demo-commesse message in any case.
    if (afterApexOpen.keys.includes(apexChatKey)) {
      expect(afterApexOpen.map[apexChatKey] ?? '').not.toContain(demoMessage);
    }
    // demo-commesse keys remain cleared.
    expect(afterApexOpen.keys).not.toContain(demoChatKey);
    // No legacy global keys re-appeared.
    for (const legacy of LEGACY_KEYS) {
      expect(afterApexOpen.keys).not.toContain(legacy);
    }
  });

  test('Legacy global keys are removed on first home-page load (migration)', async ({ page }) => {
    test.skip(!(await backendHealthy()), 'backend not reachable on :8001');

    // Wave 1.1 also wires migrateLegacyKeys() into routes/index.tsx as a
    // top-level useEffect(_, []) so the cleanup runs on app boot, not just
    // when ReplanModal mounts (addressing the devils-advocate MED-6.1
    // hygiene concern). This test seeds the three legacy global keys
    // on the same origin, reloads, and verifies they are gone within a
    // few seconds — without ever opening ReplanModal.

    // First navigate so the storage origin (localhost:8080) is in scope.
    await page.goto('/');
    await expect(page.getByText(/Backend connesso/i)).toBeVisible({ timeout: 10_000 });

    // Now seed the legacy keys directly on the same origin.
    await page.evaluate(() => {
      try {
        localStorage.setItem(
          'replan_chat_messages',
          JSON.stringify([
            { id: 'legacy-1', role: 'user', content: 'legacy chat content', timestamp: 1 },
          ]),
        );
        localStorage.setItem('daino_last_session_id', 'legacy-session-id-xyz');
        localStorage.setItem('daino_last_run_id', '999');
      } catch {
        // ignore
      }
    });

    // Sanity: the keys are present right after seeding (migrateLegacyKeys
    // has the module-level `legacyMigrated = true` flag set from the
    // initial mount, so seeding AFTER mount does NOT re-trigger removal).
    const seeded = await readChatStorageKeys(page);
    for (const legacy of LEGACY_KEYS) {
      expect(
        seeded.keys,
        `Pre-seeded legacy key "${legacy}" should be visible after setItem`,
      ).toContain(legacy);
    }

    // Reload so the app re-mounts and migrateLegacyKeys() (top-level
    // useEffect in routes/index.tsx) actually runs against our seeded keys.
    await page.reload();
    await expect(page.getByText(/Backend connesso/i)).toBeVisible({ timeout: 10_000 });

    // Allow React useEffects to tick.
    await page.waitForTimeout(600);

    const afterMigration = await readChatStorageKeys(page);
    for (const legacy of LEGACY_KEYS) {
      expect(
        afterMigration.keys,
        `Legacy key "${legacy}" should be removed after first home-page load. Remaining keys: ${afterMigration.keys.join(', ')}`,
      ).not.toContain(legacy);
    }
  });

  /**
   * Cross-tenant token-bleed regression test — Wave 2 prereq #6.
   *
   * Background (HIGH-1.1, docs/wave1.1-adversary-report.md):
   *   Before the fix, `uploadData(file, slug)` gated `autoLogin(slug)` on
   *   `if (!_token)`. So after a user authenticated on tenant A, switching
   *   to tenant B and uploading would skip the re-login and send tenant A's
   *   JWT in the Authorization header. The backend derives `tenant_id` from
   *   the JWT (NOT from the request body), so the upload would silently
   *   land in tenant A's optimization_runs row — cross-tenant data write.
   *
   *   The fix (api.ts:277-298) made `autoLogin(slug)` unconditional. This
   *   test locks that in: it intercepts both /api/auth/login and
   *   /api/upload-data, decodes the JWT payload (tenant_id) on each side,
   *   and asserts that the Authorization header on the upload matches the
   *   tenant_id of the most recent login for the currently-active slug —
   *   not a stale demo-commesse one.
   *
   *   If this test ever fails, HIGH-1.1 has regressed. Do NOT relax it.
   */
  test('Upload on tenant B does not send tenant A\'s JWT (HIGH-1.1 regression)', async ({ page }) => {
    test.skip(!(await backendHealthy()), 'backend not reachable on :8001');
    // Two sequential solves (~18s each) + two uploads + a reset + an
    // autocomplete-driven tenant switch. The default 60s test timeout is
    // too tight; bump to 180s. The internal action timeouts in the config
    // (15s) are unchanged.
    test.setTimeout(180_000);

    // Live observation of every login + upload. Each login captures the
    // requested tenant_slug → access_token mapping; the upload records
    // its Authorization header at request time.
    const loginsByTenant: Record<string, { token: string; tenantId: number | undefined }[]> = {};
    let uploadAuthHeader: string | null = null;

    page.on('request', req => {
      const url = req.url();
      if (url.includes('/api/upload-data') && req.method() === 'POST') {
        // Snapshot the Authorization header AT REQUEST TIME — this is
        // the exact bearer that the browser is sending to the backend.
        const headers = req.headers();
        uploadAuthHeader = headers['authorization'] ?? headers['Authorization'] ?? null;
      }
    });

    page.on('response', async resp => {
      const url = resp.url();
      if (url.endsWith('/api/auth/login') && resp.request().method() === 'POST') {
        try {
          const reqBodyRaw = resp.request().postData();
          if (!reqBodyRaw) return;
          const reqBody = JSON.parse(reqBodyRaw) as { tenant_slug?: string };
          const slug = reqBody.tenant_slug;
          if (!slug) return;
          const body = await resp.json().catch(() => null);
          const token = (body as { access_token?: string } | null)?.access_token;
          if (!token) return;
          const decoded = decodeJwtPayload(token);
          if (!loginsByTenant[slug]) loginsByTenant[slug] = [];
          loginsByTenant[slug].push({ token, tenantId: decoded.tenant_id });
        } catch {
          // Don't break the test on a single parse error; final assertions
          // will still catch the real problem.
        }
      }
    });

    // ── Step 1: solve on demo-commesse via the Carica Demo button.
    await page.goto('/');
    await expect(page.getByText(/Backend connesso/i)).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: /Carica Demo Commesse dal backend/i }).click();
    await expect(page.getByText(/Azienda trovata nel sistema/i)).toBeVisible({ timeout: 8_000 });
    await solveDeterministic(page);

    // ── Step 2: force a demo-commesse JWT to be persisted in api.ts's
    // module-level `_token` by performing a real upload on demo-commesse.
    // This is the EXACT pre-condition the HIGH-1.1 bug needed (a stale
    // tenant-A token sitting in memory) before the tenant switch.
    await page.getByRole('button', { name: /Inserisci Dati/i }).click();
    await expect(page.getByRole('heading', { name: /Inserimento Dati/i })).toBeVisible();
    const demoFileInputs = page.locator('input[type="file"]');
    await expect(demoFileInputs).toHaveCount(1);

    const FAKE_CSV_DEMO =
      'id,product,quantity,priority,deadline\n' +
      'COM-DEMO-1,Pezzo-A,5,bassa,2026-08-01\n';

    await demoFileInputs.first().setInputFiles({
      name: 'demo-commesse-orders.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(FAKE_CSV_DEMO),
    });
    // Wait for the demo-commesse upload to fully round-trip so the
    // demo-commesse login response has been observed by our spy.
    await page.waitForResponse(
      resp => resp.url().includes('/api/upload-data') && resp.request().method() === 'POST',
      { timeout: 30_000 },
    );

    expect(
      loginsByTenant['demo-commesse']?.length ?? 0,
      `Should have seen at least one login on demo-commesse. Saw: ${Object.keys(loginsByTenant).join(', ')}`,
    ).toBeGreaterThanOrEqual(1);
    const demoLogin = loginsByTenant['demo-commesse'].at(-1)!;
    expect(demoLogin.tenantId, 'demo-commesse JWT must carry a tenant_id').toBeDefined();

    // Reset the upload header capture before the apex-toy switch so we
    // ONLY observe the second upload's header.
    uploadAuthHeader = null;

    // ── Step 3: close DataInputModal, reset, switch to apex-toy, solve.
    // The DataInputModal close button is the X at top-right inside the
    // modal's own bordered panel. Click it explicitly — the overlay
    // backdrop hack from T9 is for ReplanModal whose overlay is sibling;
    // DataInputModal's overlay sits behind and may or may not be clickable.
    const dataInputDialog = page.getByRole('heading', { name: /Inserimento Dati/i });
    if (await dataInputDialog.isVisible().catch(() => false)) {
      // Click the close (X) button — it has no aria-name but is positioned
      // in the modal header next to the title. Find it by SVG class.
      await page.evaluate(() => {
        const dialogs = document.querySelectorAll('[role="dialog"], .fixed.z-50');
        for (const d of dialogs) {
          const xBtn = d.querySelector('button:has(svg.lucide-x)') as HTMLButtonElement | null;
          if (xBtn) { xBtn.click(); return; }
        }
        // Fallback: click any backdrop overlay.
        const overlays = document.querySelectorAll('.fixed.inset-0.bg-background\\/80, .fixed.inset-0.z-50.bg-background\\/80');
        overlays.forEach(o => (o as HTMLElement).click());
      });
      await expect(dataInputDialog).toBeHidden({ timeout: 5_000 });
    }

    await page.getByRole('button', { name: /Nuova Ottimizzazione/i }).click();
    await expect(page.getByPlaceholder(/Demo Commesse|Apex Toy/i)).toBeVisible({ timeout: 10_000 });
    // Wait for setup state to settle (companies list is still cached from
    // the initial mount; nothing to fetch). 500ms is enough for React.
    await page.waitForTimeout(500);
    await selectCompanyByName(page, 'Apex Toy');
    // Sanity: verify the apex-toy detail actually loaded before "Scegli Metodo".
    await expect(page.getByText(/Azienda trovata nel sistema/i)).toBeVisible({ timeout: 8_000 });
    await expect(page.getByText(/Consultation presente/i)).toBeVisible({ timeout: 8_000 });
    await solveDeterministic(page);

    // ── Step 4: upload a CSV via DataInputModal on apex-toy.
    await page.getByRole('button', { name: /Inserisci Dati/i }).click();
    await expect(page.getByRole('heading', { name: /Inserimento Dati/i })).toBeVisible();

    const fileInputs = page.locator('input[type="file"]');
    await expect(fileInputs).toHaveCount(1);

    const FAKE_CSV =
      'id,product,quantity,priority,deadline\n' +
      'COM-9001,Flangia-T,12,alta,2026-09-01\n' +
      'COM-9002,Bullone-Z,40,media,2026-09-02\n';

    await fileInputs.first().setInputFiles({
      name: 'apex-toy-orders.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(FAKE_CSV),
    });

    await page.waitForResponse(
      resp => resp.url().includes('/api/upload-data') && resp.request().method() === 'POST',
      { timeout: 30_000 },
    );

    // ── Step 5: assertions.
    // 5a) we saw an apex-toy login AFTER the demo-commesse one.
    expect(
      loginsByTenant['apex-toy']?.length ?? 0,
      'uploadData(file, "apex-toy") must trigger a /api/auth/login for apex-toy. Login map: '
        + JSON.stringify(Object.keys(loginsByTenant)),
    ).toBeGreaterThanOrEqual(1);
    const apexLogin = loginsByTenant['apex-toy'].at(-1)!;
    expect(apexLogin.tenantId, 'apex-toy JWT must carry a tenant_id').toBeDefined();

    // 5b) sanity: the two tenant_ids differ, otherwise the test is a no-op.
    expect(
      apexLogin.tenantId,
      'demo-commesse and apex-toy must resolve to different tenant_ids on this backend',
    ).not.toBe(demoLogin.tenantId);

    // 5c) the upload's Authorization header is THE apex-toy token, not demo.
    expect(uploadAuthHeader, 'upload Authorization header must have been captured').not.toBeNull();
    expect(uploadAuthHeader).toBe(`Bearer ${apexLogin.token}`);
    expect(uploadAuthHeader).not.toBe(`Bearer ${demoLogin.token}`);

    // 5d) decode the bearer sent on the upload — its tenant_id is apex-toy's.
    const sentToken = (uploadAuthHeader ?? '').replace(/^Bearer\s+/, '');
    const sentPayload = decodeJwtPayload(sentToken);
    expect(
      sentPayload.tenant_id,
      `Upload JWT tenant_id=${sentPayload.tenant_id} must equal apex-toy tenant_id=${apexLogin.tenantId} (NOT demo-commesse's ${demoLogin.tenantId})`,
    ).toBe(apexLogin.tenantId);
    expect(sentPayload.tenant_id).not.toBe(demoLogin.tenantId);
  });
});
