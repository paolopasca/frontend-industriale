# Wave 1.1 — Adversarial Review

**Reviewer**: `devils-advocate@wave1-1-cleanup`
**Branch**: `feat/wave1.1-med-cleanup` (base: `feat/wave1-backend-definitivo-link`)
**Backend**: `daino-backend-definitivo` v0.4.0 on :8001 (read-only)
**Scope**: backlog = MED findings from `docs/wave1-adversary-report.md`. The 2 fixers worked in the same working tree.

**Files reviewed**:
- `src/lib/api.ts` (api-cleaner, task #1)
- `src/lib/storage.ts` (storage-cleaner, NEW)
- `src/components/onboarding/SetupPage.tsx`, `DataInputModal.tsx` (api-cleaner)
- `src/components/dashboard/ReplanModal.tsx`, `DashboardHeader.tsx` (storage-cleaner)
- `src/components/onboarding/OptimizationLoader.tsx` (storage-cleaner)
- `src/routes/index.tsx` (cross-cutting)

Findings ranked by severity. HIGH/MED-with-bug triggered a DM (cap: 3 DMs total, used 2).

---

## High severity findings (DM sent, RESOLVED)

### [HIGH-1.1] `src/lib/api.ts:277-298` — `uploadData` token-tenant bleed: file routed to the wrong tenant's database — **RESOLVED**
- **Initial state**: `uploadData(file, slug)` gated `autoLogin` on `if (!_token)`. `_token` is a module-level singleton with **no tenant identity tracking**. Scenario:
  1. User uploads on tenant A → `autoLogin('A')` runs → `_token = tokenA`.
  2. User clicks "Nuova Ottimizzazione" → `handleReset` clears localStorage for slug A but NOT `_token`.
  3. User selects tenant B → uploads → `uploadData(file, 'B')`.
  4. `if (!_token)` is **false** (tokenA is still in memory) → autoLogin is skipped.
  5. `fetch('/api/upload-data', { headers: authHeaders() })` sends `Authorization: Bearer tokenA`.
  6. Backend (`daino-backend-definitivo/daino/api/routes_crud.py:864`) reads `tenant_id = user["tenant_id"]` from the JWT — that's tenant A. The file would be written into tenant A's `optimization_runs` table, even though the UI shows tenant B.
- **Impact (if shipped)**: cross-tenant data write. Exactly the failure mode MED-1 of the Wave 1 report was trying to prevent. The MED-1 fix had moved the credential bundling problem but introduced a worse one (silent cross-tenant misrouting instead of a noisy login error on B2B tenants).
- **Why HIGH, not MED**: silent data misrouting surfaces only when a customer notices their upload didn't appear in their dashboard. The error-handling path is "no error" → no telemetry. The Wave 1 MED-1 at least failed noisily (login error on first non-demo tenant).
- **Counter-evidence considered**: ReplanModal.tsx:129 calls `autoLogin(companySlug)` UNCONDITIONALLY before every chat reschedule (no gate) — so the chat path was already safe. The asymmetry between `uploadData` (gated) and `chatReschedule` callers (ungated) was itself the smell.
- **DM sent 2026-05-21** to api-cleaner with two fix options: (A) drop the `if (!_token)` gate (1-line fix, matches ReplanModal pattern); (B) track `_tokenTenant` alongside `_token` and re-login on mismatch. Recommended A.
- **Resolution (verified in current file)**: api-cleaner shipped option A. `api.ts:277-298` now does `const ok = await autoLogin(slug);` unconditionally, no gate, no module-state read in the body of `uploadData`. The doc comment at 272-276 explicitly documents WHY the token-tenant decoupling matters ("_token has no tenant identity… backend derives tenant_id from the JWT, not the body… would write the file into the wrong tenant's run history"). Verified with `grep "_token" api.ts` — 5 hits, all in unrelated plumbing (`let _token`, login set, `authHeaders` read) + the new comment; zero in `uploadData`'s body. `npx tsc --noEmit` exit 0.
- **Verdict**: well defended, response was fast and surgical. The recommendation to ALSO sweep the inline ReplanModal comment ("no-op if already logged in") was deferred to storage-cleaner's ownership — flagged here for visibility but not blocking. All three authenticated-call sites are now consistent: every authenticated request that needs a current-tenant JWT calls `autoLogin(slug)` first.

---

## Medium severity findings

### [MED-1.1] ~~`src/routes/index.tsx:102` — `DashboardHeader` `companySlug` prop NOT wired~~ — **FALSE POSITIVE, RETRACTED**
- **Initial claim**: I asserted that `routes/index.tsx:102` passed `<DashboardHeader>` without `companySlug`, so the runtime `if (companySlug)` guard in `handleReset` would short-circuit.
- **Reality**: storage-cleaner had already converted the call site to multi-line form to add the prop. Verified state (`routes/index.tsx:102-107`):
  ```tsx
  <DashboardHeader
    onReplan={() => setReplanOpen(true)}
    onAddData={() => setDataInputOpen(true)}
    onReset={() => { setPhase('setup'); setBackendResult(null); setSolverMethod(null); }}
    companySlug={setupData?.companySlug ?? null}
  />
  ```
- **Cause of false positive**: I read a stale snapshot of `routes/index.tsx` during review — at the time of my Read it was still single-line. The file was updated as part of storage-cleaner's task #2 work before they marked it `completed`, but after my initial Read. I never re-verified before sending the DM.
- **Storage-cleaner's pushback was correct**: `grep -n "companySlug" routes/index.tsx` shows 5 hits — SetupPage, OptimizationLoader, DashboardHeader, ReplanModal, DataInputModal — confirming the wiring is in place.
- **Lesson for future reviews**: when teammates are mid-flight (`in_progress`), the working tree changes under you. Always re-read after a teammate marks `completed` and before sending a DM about a specific code location.
- **Status**: RESOLVED (no fix needed — already correct in code). DM count: 2 sent, of which 1 was a false alarm. Effective DM count: 1 (HIGH-1.1).

### [MED-2.1] `SetupPage.tsx:395` and `DataInputModal.tsx:241,468` — `accept=".csv,.xlsx,.xls"` regression: backend still supports `.pdf`
- **What changed**: api-cleaner narrowed all three file `<input accept=...>` attributes to `.csv,.xlsx,.xls`. The Wave 1 MED-7/LOW-1 suggestion was "drop `.pdf` from accept OR rename the button" — but the backend at `daino-backend-definitivo/daino/api/upload_validation.py:32-37` explicitly whitelists `.pdf` as an allowed upload extension, and `routes_crud.py:856-860` says the route "uses LLM-assisted ingestion path" — i.e., PDF ingestion is a paid, supported feature.
- **What's wrong**: the frontend now blocks a paid backend feature. If/when DAINO sells PDF-ingestion as a differentiator (per ADR-006 — "hybrid data ingestion" — see `routes_crud.py:63`), the frontend won't accept the file. This is a product regression dressed up as a cleanup. The task plan in #1 said "Restringi accept: a `.csv,.xlsx,.xls`" — that was MY ask in Wave 1, and on review it's wrong.
- **Why MED not HIGH**: PDF ingestion is not currently exercised in the e2e (task #4) and the demo tenant doesn't have a PDF flow. So short-term no functional break. But it removes capability without a deprecation note.
- **Suggested fix**: re-add `.pdf` to `accept` and update the label/copy from "CSV/Excel" to "CSV, Excel, PDF". Drop `.json` (never supported by backend — verified in `ALLOWED_UPLOAD_EXTENSIONS`).
- **Status**: NOT BLOCKING but should be addressed before Wave 2 (sales demo path).

### [MED-3.1] `ReplanModal.tsx:78-85` — redundant initial load + write cycle on every companySlug change
- **What changed**: storage-cleaner replaced the global STORAGE_KEY load with a slug-scoped one, and added two effects: (i) on `[companySlug]` re-load, (ii) on `[messages, companySlug]` save.
- **What's wrong**: on first mount the `useState(() => loadStored(companySlug))` initializer runs, then effect (i) immediately fires and re-loads from storage (redundant), then effect (ii) fires and writes the just-loaded value back to storage. Three trips for what should be one. Pattern is correct, just inefficient.
- **Worse case**: if `companySlug` is `null` initially and becomes non-null later, `loadStored(null)` returns `[WELCOME]`. Effect (ii) does `if (!companySlug) return;` so it doesn't write yet — good. But when slug becomes non-null, effect (i) reloads from storage. Effect (ii) then writes back. Idempotent but loud.
- **Suggested fix**: drop the initial `useState(() => loadStored(companySlug))` and let effect (i) populate `messages` from `[WELCOME]` initial → `loadStored(slug)`. Then effect (ii) covers the save. Or memo the writer with a guard `if (messages === lastLoaded) return`.
- **Status**: NOT BLOCKING. Performance, not correctness.

### [MED-4.1] `ReplanModal.tsx:97-99` — `handleClear` does not delete the namespaced storage key
- **What changed**: storage-cleaner namespaced the chat history.
- **What's wrong**: `handleClear` does `setMessages([WELCOME])`, which triggers effect (ii) → `setSlugScoped(STORAGE_KEY_BASE, companySlug, JSON.stringify([WELCOME]))`. The key isn't deleted — it's overwritten with `[WELCOME]`. Functionally equivalent but counter-intuitive (DevTools won't show the key gone). Also, if WELCOME is ever made stateful (e.g., personalized greeting), the persisted [WELCOME] won't match.
- **Suggested fix** (low priority): export `removeSlugScoped` is already there; use it in `handleClear` for symmetry: `removeSlugScoped(STORAGE_KEY_BASE, companySlug); setMessages([WELCOME]);`.
- **Status**: NOT BLOCKING. Cosmetic.

### [MED-5.1] `api.ts:127` — inline comment in ReplanModal.tsx is wrong about `autoLogin` being a no-op
- **What changed**: storage-cleaner left the existing comment at ReplanModal.tsx:127 untouched: `// Re-auth as the demo tenant (no-op if already logged in)`.
- **What's wrong**: `autoLogin` (`api.ts:253-260`) does NOT no-op. It always calls `login()`, which always issues a fresh `POST /api/auth/login`. Comment is misleading — and reading this comment is what would make a future developer add the (broken) `if (!_token)` gate to `uploadData` thinking it's symmetric. The Wave 1.1 cleanup is the right moment to remove the wrong comment.
- **Suggested fix**: change to `// Re-auth as the demo tenant (always; autoLogin is not a no-op)` or just `// Refresh JWT for this tenant`.
- **Status**: NOT BLOCKING.

### [MED-6.1] Migration timing: `migrateLegacyKeys()` only fires when ReplanModal mounts, not at app boot
- **What changed**: storage-cleaner put `useEffect(() => migrateLegacyKeys(), [])` in ReplanModal.
- **What's wrong**: ReplanModal mounts only when the user clicks "Ripianifica". A user who never opens that modal will keep the legacy `replan_chat_messages` / `daino_last_session_id` / `daino_last_run_id` keys forever. The other components (OptimizationLoader, DashboardHeader) already use `setSlugScoped` exclusively, so they write to NEW keys — the legacy keys are read-only stale data — but they show up in DevTools confusingly.
- **Suggested fix**: move the call to `routes/index.tsx` top-level `useEffect`, so it runs once at app mount.
- **Status**: NOT BLOCKING. Hygiene.

### [MED-7.1] `OptimizationLoader.tsx:236-238` writes are correct, but the `removeSlugScoped` calls at line 161-162 are inside `if (method !== 'codegen-pipeline' && companySlug)` — what about when `companySlug` is null with method `codegen-pipeline`?
- **What changed**: storage-cleaner gated both the remove and the set on `companySlug` being non-null.
- **What's wrong**: when `companySlug` is null AND `method === 'codegen-pipeline'`, the loader takes the simulation path (line 188-195) and `onComplete` is called with no result. The session/run IDs are NEVER written (correct), but **stale legacy IDs from a pre-Wave-1.1 user MAY still be present** if `migrateLegacyKeys` hasn't run yet (see MED-6.1). So a user can: have a legacy `daino_last_session_id` cached → simulate codegen with no slug → open Ripianifica (which then mounts and migrates) → the migration deletes the key → handleSend reads `null` for sessionId → backend returns 501 → UX OK. **The chain works**, but only because migration eventually runs.
- **Status**: NOT BLOCKING. This is more of a defense-in-depth concern.

---

## Low severity / style

### [LOW-1.1] `DataInputModal.tsx:469` — copy says "Formati supportati: .csv, .xlsx, .xls" but the drop-zone hint says "Trascina file CSV/Excel". Two phrasings, one truth. Pick one.

### [LOW-2.1] `storage.ts:1-46` — try/catch around every localStorage operation is good defense (e.g., for private-browsing-mode quota errors), but **silently swallows** failures. In B2B with strict storage policies, the user clicks Ripianifica → gets a "no session" error from the backend → has no idea storage is disabled. Worth surfacing once via a toast on first failure.

### [LOW-3.1] `storage.ts:8-10` — `PREFIX = 'daino'` and `buildKey` uses `${PREFIX}:${slug}:${key}`. If a slug ever contains `:` (unlikely with valid slugs, but Wave-2 onboarding flow could allow URL-encoded names), the key becomes ambiguous. Suggested fix: `encodeURIComponent(slug)` in `buildKey`.

### [LOW-4.1] `api.ts:262-300` (uploadData) — the doc comment says "Reuses the module-level `_token`; if absent, performs a one-shot autoLogin" but does not document the token-tenant-bleed risk. After the HIGH-1.1 fix, update the comment to reflect the new behavior.

### [LOW-5.1] `OptimizationLoader.tsx:236-238` — writes session_id and run_id only on `state === 'done'` for codegen path. Good. But the keys are never re-deleted on a NEW codegen run for the same slug — they get overwritten each time. Fine semantically, just noting.

---

## Decisions challenged and defended well

- **api-cleaner / `uploadData` consolidation**: the move into `api.ts` was correct in scope (MED-2). The single source of truth is the right end state. The HIGH-1.1 bug above doesn't invalidate the consolidation — it's a sub-fix to the gating logic.
- **api-cleaner / `accept` narrowing**: incorrectly executed against MY OWN Wave 1 ask. On review I had two options ("drop pdf OR rename"), the fixer picked "drop pdf", but the backend evidence (`upload_validation.py:32-37`) says `.pdf` is a supported, paid, ADR-006 feature. The fixer followed the plan; the plan was wrong. See MED-2.1.
- **storage-cleaner / `clearSlugScoped` iteration order**: descend from `length-1` to 0. This is the CORRECT pattern because `localStorage.removeItem(key)` reindexes the remaining keys; iterating forward would skip items. Defended well.
- **storage-cleaner / `migrateLegacyKeys` module-level idempotency guard**: `let legacyMigrated = false` at module scope, set true after first call. Cheap and correct. Defended well.
- **storage-cleaner / `removeSlugScoped` API addition**: not in the task plan, but added because `clearSlugScoped` (clear-all-for-slug) is too coarse for the codegen-cleanup case in `OptimizationLoader.tsx:161-162`. Defensible.
- **storage-cleaner / `runId ?? 0 > 0` ternary**: `Number.isFinite(runId) && (runId ?? 0) > 0`. The `??` is redundant (short-circuit on `Number.isFinite(null) === false` already returns null), but the explicit `> 0` belt-and-suspenders. Verbose but correct.
- **api-cleaner / `UploadDataResult` interface**: introduced `status: string; source?: string; problem_type?: string; preview?: unknown; data?: unknown`. The optional fields match what `routes_crud.py:892-898` returns. Verified.

---

## Raccomandazioni per Wave 2 (prereq)

Before Wave 2 begins, these MUST be settled (in priority order):

1. ~~**Fix HIGH-1.1** (uploadData token-tenant bleed).~~ **RESOLVED 2026-05-21** — api-cleaner shipped option A within minutes of the DM. `uploadData` now always calls `autoLogin(slug)` unconditionally, matching the ReplanModal pattern. Recommendation #3 below (standardize the auth-refresh pattern) is the long-term version of this same fix.

2. ~~**Fix MED-1.1** (DashboardHeader prop wiring).~~ **NOT NEEDED — false positive, already wired** (`routes/index.tsx:106`). Originally listed here in error.

3. **Standardize the auth-refresh pattern** across api.ts callers. Currently:
   - `ReplanModal` → unconditional `autoLogin(slug)` before every reschedule.
   - `OptimizationLoader.tsx:199` → conditional `autoLogin(slug)` before codegen pipeline (only when slug exists).
   - `uploadData` → conditional `autoLogin(slug)` only when `_token` is null.
   Three different patterns for the same problem. Wave 2 should pick ONE: my recommendation is "every authenticated API call re-issues login (or no-ops if `_tokenTenant === slug && _tokenExpiry > now`)". The simpler `_tokenTenant` tracking is < 10 LOC.

4. **Re-enable `.pdf` in `accept`** (MED-2.1) before any sales demo that mentions ADR-006 hybrid ingestion. Or, if PDF is genuinely de-scoped from MVP, write an ADR explaining the regression so future fixers don't re-enable it without context.

5. **Move `migrateLegacyKeys()` to app-boot** in `routes/index.tsx` (MED-6.1). Otherwise the e2e tester (task #4) will see inconsistent localStorage states depending on which UI path the test traverses.

6. **Add a `e2e/cross-tenant-token-bleed.spec.ts`** (task #4 scope) that explicitly: login A → upload → reset → login B → upload → verify backend `optimization_runs` has the upload under tenant B's `tenant_id`, NOT under A's. This single test would have caught HIGH-1.1 before merge.

7. **Decouple the chat-history retention policy from the slug**: Wave 3 (chat manager) will add a SECOND chat panel. If both panels use the same `replan_chat_messages` base + slug, they'll share history. Either give each panel a different base or pass the panel ID as a sub-key. Heads-up only, not blocking.

---

## Conclusione

**HIGH**: 1 (uploadData token-tenant bleed). DM sent, fix shipped within the review cycle, **RESOLVED**.
**MEDIUM**: 7 listed (MED-1.1 RETRACTED as false positive; 6 real are smell/regression/perf, not blockers).
**LOW**: 5.
**DMs sent**: 2 of 3 cap (api-cleaner for HIGH-1.1 — real, fixed; storage-cleaner for MED-1.1 — false alarm, retracted). Effective signal: 1 of 2 DMs was load-bearing.

**Wave 1.1 launch-readiness**: **GO**. Both fixers shipped working code that compiles clean (`npx tsc --noEmit` passes). The 1 HIGH bug was resolved within the review cycle via the recommended 1-line fix. The remaining MED items are mostly hygiene; the one regression worth a product call is MED-2.1 (`.pdf` capability removed from `accept`). No outstanding blockers for task #4 starting.

**For task #4 (e2e tester)**:
- Add an explicit cross-tenant token-bleed scenario as a regression test (see Wave 2 prereq #6) — even though HIGH-1.1 is fixed, the test prevents it from coming back when someone re-introduces a clever cache.
- Verify `DashboardHeader` reset path clears `daino:<slug>:*` localStorage keys end-to-end (this confirms the wiring I incorrectly doubted in MED-1.1 actually works in production).
- Skip the PDF upload path until MED-2.1 is decided.
