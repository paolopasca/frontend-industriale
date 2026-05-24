# Wave 1 — Adversarial Review

**Reviewer**: `devils-advocate@wave1-link`
**Branch**: `feat/wave1-backend-definitivo-link`
**Backend**: `daino-backend-definitivo` v0.4.0 on :8001 (read-only)
**Files reviewed**: `src/lib/api.ts`, `src/components/onboarding/{SetupPage,OptimizationLoader}.tsx`, `src/components/dashboard/{DashboardHeader,ReplanModal,DataInputModal,MachineGantt,OperatorGantt,OperationalPlan,KPISummary}.tsx`, `src/data/{resultAdapter,DashboardContext,mockData}.ts`, `src/routes/index.tsx`, `src/styles.css`.

Findings ranked by severity. HIGH triggered a DM to the responsible teammate (cap: 5 DMs total).

---

## High severity findings (DM sent, RESOLVED)

### [HIGH-1] `buttons-fixer` / `src/components/dashboard/DataInputModal.tsx` — Task #2 only half done: 3 of 4 buttons still unwired — **RESOLVED**
- **Initial state (at moment of DM)**: diff stat showed ~36 lines added in DataInputModal — only imports (`useRef`, `Loader2`, `toast`, `pipelineStart`) and the inline `uploadDataFile()` helper. The JSX buttons in the pre-modification file (line refs 165/375/394 were the OLD-file positions cited in the team plan) still had no `onClick`. Component signature was still `{ open, onClose }` without `companySlug`.
- **DM sent 2026-05-21**: asked buttons-fixer to finish wiring + propagate `companySlug`, add `submitting` flag.
- **Resolution (verified in current file)**: buttons-fixer wired all 3 handlers in the same review cycle:
  - "Importa CSV" tab Ordini → DataInputModal.tsx:262-269 via `handleCsvButtonClick`/`handleCsvFileChange`/`handleUpload`.
  - Drag-drop "Upload File Dati" tab Vincoli → DataInputModal.tsx:483-508 via `handleDropZoneClick`/`handleDrop`/`handleDropFileChange`.
  - Footer "Ottimizza con AI" → DataInputModal.tsx:523-531 via `handleOptimize` (DataInputModal.tsx:137-179), which builds a description from form state and calls `pipelineStart(slug, desc, 'compose')`.
- `companySlug` is propagated through `routes/index.tsx:141-146`. Flags `uploading`/`submitting`/`dragOver` are in place (DataInputModal.tsx:93-95) with proper `disabled` bindings on the buttons (anti double-submit).
- Verified by buttons-fixer empirically: `npx tsc --noEmit` clean, `npx eslint` clean, `/api/auth/login` + `/api/analysis/start` exchange tested live.
- **Verdict**: well defended. The DM-era diff was genuinely incomplete; the DM accelerated completion. The line numbers I cited in the initial finding referenced the OLD file's button positions (still the right anchors when reading the team plan), but the FINAL line numbers are the ones above.

### [HIGH-2] `compat-fixer` / `src/lib/api.ts:116` — `solveLLMOnly` hard-codes `problem_type='fjsp'` regardless of company type — **RESOLVED**
- **Initial state**: `solveLLMOnly(slug)` always calls `solveTemplate(slug, 'fjsp', {})`. The wave0 map lists `jssp | fjsp | flow_shop | staff_rostering | workforce`; non-FJSP tenants would silently get an empty solution.
- **DM sent 2026-05-21**: proposed reading `problem_type` from the company's consultation_md.
- **Resolution**: compat-fixer added `detectProblemType(slug)` (api.ts:121) that parses `^##\s*Tipo problema:\s*([a-z_]+)` from `consultation_md` (field verified to exist on the live `/api/public/company/{slug}` response; demo-commesse returns `## Tipo problema: fjsp`). Falls back to `'fjsp'` if no match. Whitelist limited to the 5 supported types.
- **Verdict**: well defended. Minor cost: 1 extra `GET /api/public/company/{slug}` per llm-only solve. Worth it.

### [HIGH-3] `compat-fixer` / `src/lib/api.ts:286` — `chatReschedule` parses `runId` from localStorage with `Number()` which makes `runId=0` and `runId=NaN` indistinguishable from `runId>0` for the `!= null` guard — **RESOLVED**
- `Number(runIdRaw)` for `runIdRaw === ''` produces `0`, and `Number.isFinite(0)` is `true`, so `runId=0` would get sent to the backend as `body.run_id = 0` — which then 404s ("Run not found"). Edge case but user-visible.
- **DM sent 2026-05-21** as part of the HIGH-2 message.
- **Resolution**: compat-fixer replaced the guard with `Number.isFinite(runId) && runId > 0`. Non-numeric or `"0"` localStorage values now short-circuit to the existing UX "Reschedule non disponibile: nessuna sessione/run attiva" message — no backend call with `run_id: 0`.
- **Empirical refinement**: compat-fixer also verified live that the backend returns a clean HTTP 400 (`"No data files found or normalization failed"`) when a mismatched `problem_type` is passed — not silent garbage. So even pre-fix, HIGH-2 was actually MED-class (noisy but error-handled). The post-fix is still the right move; the original severity assessment was over-cautious. Acknowledged.

---

## Medium severity findings (annotated)

### [MED-1] `SetupPage.tsx:11` / `DataInputModal.tsx:11` — `uploadDataFile()` does a fresh `demo/demo` login per request
- Hard-coded `tenant_slug: companySlug, username: 'demo', password: 'demo'` flows into the production bundle. Two problems:
  1. **Security/scaling**: it presumes every tenant has a `demo/demo` user. The real production tenants (the first B2B customers) will NOT. The button will throw "Login fallito" at exactly the moment the user proves the product to a buyer.
  2. **Cost**: a `bcrypt` verify on every upload click is wasteful and adds ~50-200ms latency.
- The token is also **not stored in `_token`** inside `api.ts` (the inline helper uses a local var). So subsequent calls to `pipelineStart`, `pipelineAdvance`, etc., won't see the same auth state.
- **Suggested fix**: reuse the `autoLogin(companySlug)` helper from `api.ts`, then call upload with `authHeaders()`. Or expose a new `uploadData(file)` in `api.ts` that closes over `_token`. The `_token` module-state is already there for exactly this reason.
- **Why MED not HIGH**: in dev with demo slugs it works; the breakage manifests later (Wave 6+).

### [MED-2] `SetupPage.tsx:11` / `DataInputModal.tsx:11` — duplicated `uploadDataFile()` helper (DRY violation in flight)
- The same function body exists in two files. Bound to drift.
- buttons-fixer was told to avoid touching `api.ts` (compat-fixer's domain); the consequence is duplication. Should be consolidated in a follow-up commit after Wave 1 by moving the helper into `api.ts`.
- **Suggested fix**: post-Wave-1 cleanup ticket.

### [MED-3] `ReplanModal.tsx:115-127` — uses `localStorage` for `daino_last_session_id`/`daino_last_run_id` with no cross-tenant isolation
- The key is global. If a user runs an optimization on `apex-toy`, then switches to `demo-commesse` and opens the reschedule modal, the modal will fire a `POST /api/analysis/{old-sid}/reschedule` whose backend-side check `entry["tenant_id"] != user["tenant_id"]` returns 403. Confusing UX.
- Worse: `OptimizationLoader.tsx:152-159` only clears the keys when `method !== 'codegen-pipeline'`. So when switching FROM codegen TO codegen on a different tenant, the stale IDs survive.
- **Suggested fix**: key the localStorage entries by `companySlug` (e.g. `daino_last_session_id:${slug}`), or clear them on tenant change in `routes/index.tsx`.

### [MED-4] `ReplanModal.tsx:9-21` — `loadStored()` runs at module-evaluation time, sharing chat history across tenants
- Same root cause as MED-3: `STORAGE_KEY = 'replan_chat_messages'` is global. A manager who used the chat on tenant A will see the same conversation on tenant B.
- The chat history can also contain sensitive disruption text (operator names, machine codes). Cross-tenant leak in a B2B context is a compliance smell.
- **Suggested fix**: namespace the key by `companySlug`. Optionally cap message count at ~100 to avoid unbounded growth.

### [MED-5] `ReplanModal.tsx:113` — `useEffect(() => localStorage.setItem(...))` re-runs on every message tick
- Every keystroke triggers a re-render → `messages` reference may stay stable (state set only on send), but the effect dependency `[messages]` re-fires after each push. `JSON.stringify` of growing history on every send is fine for small N, but unbounded.
- **Suggested fix**: cap history; or debounce the storage write.

### [MED-6] `DashboardHeader.tsx:8` — `window.print()` after `setTimeout(250)` races with the toast
- The toast might still be in-flight when print opens; the toast is then captured in the print preview unless `[data-sonner-toaster]` is `display:none` in `@media print`. styles.css:198 covers `[data-sonner-toaster]`, OK — but the 250ms delay is brittle: on a slow machine the toast hasn't rendered yet; on a fast one it's still mid-fade. A user double-clicking the button in the gap will queue two prints.
- Bigger concern: **Canvas / SVG Gantt printing**. The Gantts use absolutely-positioned `<div>` elements (`MachineGantt.tsx:170-200`), which print engines handle inconsistently across browsers. Safari truncates overflow:auto containers; Chrome prints only the visible scroll area unless explicit print CSS overrides. Some users will get a blank page where the Gantt should be.
- **Suggested fix**: in `@media print`, force `overflow: visible !important` on the Gantt scroll containers; or warn the user to switch to landscape orientation.

### [MED-7] `SetupPage.tsx:99` — file input `accept=".csv,.xlsx,.xls,.json,.pdf"` is wider than the backend probably handles
- The Importa CSV button promises CSV-only by label but accepts PDF/JSON. If the user picks a PDF, the backend `/api/upload-data` will likely reject with a 400, which surfaces as a `toast.error`. But the *button label* implies the file will be ingested. UX confusion.
- **Suggested fix**: either drop `.pdf` from `accept`, or change the label/copy.

### [MED-8] `OptimizationLoader.tsx:225-238` — `localStorage.setItem('daino_last_run_id', String(results.run_id))` writes `'undefined'` if backend omits run_id
- `String(undefined) === 'undefined'`. Later, `chatReschedule` does `Number('undefined') === NaN`, then `Number.isFinite(NaN) === false` so `runId` becomes `null`. So far so good — but only if you trust that path. If the `run_id` ever shows as `0` from backend (unlikely, but unconstrained), the storage saves `"0"`, the reader produces `0`, and the `runId != null` check passes, sending `run_id=0` to the server.
- **Suggested fix**: guard the write: `if (results.run_id && results.run_id > 0) localStorage.setItem(...)`.

### [MED-9] `api.ts:265` — `chatReschedule` returns a synthesized error response (action='error') instead of throwing
- Hidden API contract change: callers using `try/catch` around `chatReschedule(...)` will no longer see exceptions for the 501 / no-session paths. They'll silently get a "success" object with `action: 'error'`.
- `ReplanModal` handles this by inspecting `res.action`, which is fine. But if any other future caller assumes "no throw == success", they get burned.
- **Suggested fix**: document the contract on the exported interface and/or make the field non-optional so TS forces callers to handle it.

### [MED-10] `routes/index.tsx:132` — `ReplanModal onResult={(result) => setBackendResult(result)}` accepts `unknown`
- `result` is typed as `unknown` in the prop signature; the parent dumps it into `setBackendResult` without validation. If the modal's optimistic shape diverges from what `adaptResult` expects, dashboard breaks silently.
- **Suggested fix**: type the result properly (mirror `solveTemplate`'s return shape), or run it through a Zod-style guard.

### [MED-11] `DashboardHeader.tsx:18` — `onReset` clears `backendResult` but not `localStorage` session IDs
- "Nuova Ottimizzazione" jumps back to `phase='setup'` but does NOT clear `daino_last_session_id`/`daino_last_run_id`. So if the user starts a new solve with `llm-only` (the OptimizationLoader does clear them in that case) — fine. But if they re-pick `codegen-pipeline`, the old IDs survive the reset and the next ReplanModal use will try the old session/run_id.
- **Suggested fix**: include the localStorage cleanup in the reset path, or scope IDs by session-of-current-flow.

---

## Low severity / style

### [LOW-1] `SetupPage.tsx:99` — `accept=".csv,.xlsx,.xls,.json,.pdf"`
- Inconsistent with `DataInputModal.tsx` which accepts `accept=".csv,.xlsx"`. Pick one.

### [LOW-2] `ReplanModal.tsx:30-32` — `WELCOME.timestamp = Date.now()` evaluated at module load
- Means the timestamp is the bundle-load time, not the first-open time. Cosmetic; if a relative-time UI ("3 minutes ago") is added later, this lies.

### [LOW-3] `resultAdapter.ts:73-89` — duplicated `WEEKDAY_IT = ['Lun', 'Mar', ...]`
- Two literals declared at module scope. Probably copy-paste; one of the two is unused. Worth removing.

### [LOW-4] `MachineGantt.tsx:18-37` — `TimeAxis` recomputes ticks on every render with no memoization
- 100+ ticks for a 5-day schedule is fine. For 30+ day horizons in Wave 4 what-if, will reach 720 ticks. Memoize on `[totalMinutes, timeConfig?.day_length_min, timeConfig?.company_start_hour]`.

### [LOW-5] `ReplanModal.tsx:177` — `<motion.div ... className="... h-[560px]">` hard-codes height
- Doesn't adapt to small viewports (laptops with low DPI, mobile). Use `max-h-[80vh]` with `min-h-[400px]`.

### [LOW-6] `OptimizationLoader.tsx:159-162` — `try/catch` swallow with `// ignore`
- Two places. localStorage failures will be silent. Mostly OK, but in B2B clients with strict storage policies, a toast.info "Reschedule disabled (storage unavailable)" would be more honest.

### [LOW-7] `styles.css:222-229` — print CSS uses `bg-accent\/10` selectors
- The escaped slash works in modern browsers, but the same Tailwind class might emit a different selector in a future Tailwind upgrade. Consider a dedicated `.print-card` class to decouple.

### [LOW-8] `DataInputModal.tsx:11-37` — `uploadDataFile` shadows the SetupPage version verbatim
- Same as MED-2. Reaffirming.

### [LOW-9] `resultAdapter.ts:204` — `costoTotale = (costoOperatori ?? 0) + (costoSetup ?? 0)`
- Both come from already-nullish-coalesced reads; the `??` here is redundant. Minor.

### [LOW-10] `ReplanModal.tsx:108-121` — `handleSend` uses `Number(localStorage.getItem(...))` without an explicit empty-string guard
- `Number('') === 0`, then `Number.isFinite(0) === true`, so `runId === 0`. Same root issue as MED-8.

---

## Decisions challenged and defended well

- **buttons-fixer**: my HIGH-1 DM said "you imported the helpers but never wired the JSX". Within minutes the three handlers were wired (`handleCsvButtonClick`, `handleDropZoneClick`+`handleDrop`, `handleOptimize`), `companySlug` was propagated through `routes/index.tsx:147`, and `submitting`/`uploading`/`dragOver` flags were added to block double-submits. Excellent response.
- **buttons-fixer**: chose `'compose'` as the `solver_method` for the modal's "Ottimizza con AI" (DataInputModal.tsx:165). Initially I would have asked "why not `codegen-pipeline`?" — but `codegen-pipeline` was retired in W1+C6 (per the inline comment), so `'compose'` is the correct supported value. Decision justified by a comment in the code.
- **compat-fixer**: my HIGH-2 DM proposed three options for the `problem_type` issue. They picked option 1 (the strongest) — parse `consultation_md` for the explicit `## Tipo problema:` directive and whitelist the 5 supported values. Better than my fallback options. **Follow-up**: compat-fixer verified empirically that mismatched `problem_type` returns HTTP 400 `{"detail":"No data files found or normalization failed"}` from the backend — not silent garbage. So the original HIGH-2 should have been MED (noisy but error-handled). The fix is still correct and tested live on two slugs of different shapes. Known limitation documented: `llm-only` on `staff_rostering` returns an empty dashboard (correct at solver level, gracefully empty at UI level since the dashboard is manufacturing-shaped).
- **compat-fixer**: HIGH-3 (`runId === 0`) was also addressed in the same follow-up — guard is now `Number.isFinite(runId) && runId > 0`. Defended with an empirical demonstration and a clean test case.
- **compat-fixer**: the synthesized `action: 'error'` instead of throwing (MED-9 below) is defensible — the consumer (`ReplanModal`) already inspects `res.action`, and the alternative (throwing) would require a try/catch wrapper in every caller. Keeping as MED-class advisory but acknowledging the design is intentional.
- **compat-fixer**: chose to send the disruption with an empty `disruption: {}` and a verbal `event_description` (api.ts:341). The backend's `chat_reschedule.parse_time_from_text` parses the description LLM-side, so this is the correct minimal payload. Validated against `routes_optimize.py:1703-1709`.

---

## Conclusione

**HIGH**: 3, all RESOLVED after fixer responses (HIGH-2's original severity was MED upon empirical retest — noisy 400 not silent garbage; fix shipped anyway).
**MEDIUM**: 11.
**LOW**: 10.
**DMs sent**: 2 of 5 cap.

**Wave 1 launch-readiness (final snapshot)**: **GO with caveats**. Both fixers responded to the adversarial DMs within minutes:
- `compat-fixer` (task #1 completed): added `detectProblemType()` for non-FJSP tenants + `runId > 0` guard for the localStorage edge case.
- `buttons-fixer` (task #2 completed): wired all 3 DataInputModal handlers + `submitting` guard.
- `npx tsc --noEmit` passes clean on the branch.

The remaining MEDIUM items are real but **not blocking** for the e2e tester (task #3) to start. They fall into three buckets:

**Wave-1.1 cleanup (can ship in a follow-up PR before any external demo):**
- MED-1: replace `uploadDataFile()`'s hard-coded `demo/demo` with `autoLogin(companySlug)` reuse — the demo password is bundled into the client JS and will break the first real B2B tenant.
- MED-2/LOW-8: deduplicate the helper into `api.ts`.
- MED-3/MED-4/MED-11: namespace `localStorage` keys by `companySlug` to prevent cross-tenant data bleed (`replan_chat_messages`, `daino_last_session_id`, `daino_last_run_id`).

**Wave-2/3 prerequisites (must land before Wave 3 chat manager):**
- MED-3/MED-4: localStorage namespacing is structural. Wave 3 will add a second chat panel that reads the same keys — if the bug isn't fixed first, cross-tenant chat leakage will be cemented in three places, not one.

**Stress-test risks (worth a slow-lane scenario in task #3):**
- MED-6: `window.print()` on the absolutely-positioned Gantt grid is browser-dependent. Add a slow-lane scenario that prints a 100+ operation Gantt and verifies the export.
- MED-7: file inputs accept `.pdf` despite the "CSV" label. Pick one truth.
- MED-8: `localStorage.setItem('daino_last_run_id', String(undefined))` cannot trigger from `pipelineResults` today, but is a hygiene fix worth one line.

**Security/compliance smells worth tracking in the registry (`docs/to_do/` per project conventions):**
- Hard-coded `demo/demo` credentials in client bundle.
- Cross-tenant `localStorage` leak.
- File-upload `accept` whitelist is permissive (.pdf/.json on a CSV-label button).
- `/api/upload-data` calls happen without explicit MIME type validation client-side (server side does validate, so this is defense-in-depth not a critical gap).

**Bottom line**: Wave 1 is safe to gate-pass to task #3 (e2e tests). The 11 MED items should be triaged into Wave-1.1 and Wave-3 prerequisite buckets, with the localStorage namespacing fix prioritized so Wave 3 does not inherit the bug.
