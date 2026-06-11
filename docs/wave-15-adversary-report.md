# Wave 15 — Adversary Report (Frontend branches)

> Reviewed by devil-advocate agent on 2026-05-26.
> Default stance: every fix is wrong until proven otherwise.
> Scope: branches `fix/wave-15-ux-polish` (4714a2e), `fix/wave-15-dev-cleanup` (31caf28 + 5b52ac6), `fix/wave-15-pdf-print-route` (0f5e1a4).

## Round 2 — re-review 2026-05-26

**Re-review SHA**: `61c6141` ("fix(frontend): Wave 15.1 — 3 HIGH adversary findings resolved").
**Verification**: full vitest suite executed locally → **90 tests passed, 0 failed**.
**`npm audit`**: all 11 moderate vulnerabilities are in PRE-EXISTING deps (postcss, ws, wrangler, @cloudflare/vite-plugin, @tanstack/*, brace-expansion). **Zero new vulns introduced by the new packages** (@testing-library/react, @testing-library/jest-dom, @testing-library/dom, happy-dom, aria-query, css.escape, dom-accessibility-api, @adobe/css-tools, lz-string, @types/aria-query — all clean).

### Status table

| Finding | Status | Notes / commit |
|---|---|---|
| **HIGH-1** (BFF label mislabels backend cost) | **RESOLVED** in `61c6141` | `solverLog`+`bffCostLog` collapsed to `backendLog`. Block header renamed `BFF · Costi LLM` → `Costo backend`. `'kind: bff'` argument removed from `addLog`. `grep -E 'BFF\|Costi LLM\|kind:'` on OptimizationLoader.tsx returns empty (production source clean). |
| **HIGH-2** (localStorage snapshot leak + cross-company) | **RESOLVED** in `61c6141` | `removeSlugScoped(PRINT_SNAPSHOT_KEY, slug)` added at `src/routes/print/$slug.tsx:58` (after `readSnapshot` success). Same call at `src/components/dashboard/DashboardHeader.tsx:72` on popup-block path. "Stampa di nuovo" button uses in-memory `sched` (line 63 useMemo), so re-print works after localStorage is cleared. ✅ |
| **HIGH-3** (source-text grep tests) | **RESOLVED** in `61c6141` | @testing-library/react 16.3.2 + jest-dom 6.9.1 + happy-dom 20.9.0 installed cleanly. `vitest.config.ts` + `src/test-setup.ts` added. New tests use `render()` + `screen.queryByText` / `container.textContent` — actual DOM behaviour, not regex on source. The hypothetical regression from round-1 ("invert the conditional, leave a comment with original string") now fails the test because the assertion looks at DOM, not file content. |
| **MEDIUM-1** (Cmd+P prints whole viewport) | STILL-OPEN | No change in commit. Out of scope of the 3 HIGH bundle. Worth follow-up. |
| **MEDIUM-2** (compound intent cross-cutting) | tracked in BE round 2 | See wave-16 report. |
| **MEDIUM-3** (grep-fragile no-opus test) | **RESOLVED** in `61c6141` | `no-opus-47-copy.test.ts` rewritten as real DOM render of WhatIfAnalysis + SplitSuggestion. `container.textContent.not.toMatch(/Opus\s*4\.7/i)` is the correct shape for an absence-only assertion. |
| **MEDIUM-4** (`solveLLMOnly` misnomer) | STILL-OPEN | API function name unchanged. Not addressed in commit. |
| **MEDIUM-5** (NaN in print header on missing KPI) | STILL-OPEN | `buildPrintSchedule` unchanged. |
| **MEDIUM-6** (12 duplicate files claim) | N/A | Was a doc-drift finding; not blocking. |
| **LOW-1** (dotenv silently no-ops) | STILL-OPEN | Not in commit. |
| **LOW-2** (current slug overwrite) | STILL-OPEN | Not in commit. |
| **LOW-3** (popup-block leaves stale entry) | **RESOLVED** in `61c6141` | Bundled into HIGH-2 fix. `removeSlugScoped` called in popup-block path. |

### What's new and concerning

**NEW-FE-R2-1 · Test asserts absence of OLD label but not presence of NEW label (LOW)**
*File*: `src/components/__tests__/OptimizationLoader.test.tsx:78,103-104`
*Why this matters*: The test name says `it('shows "Costo backend" label in the log block (not "BFF · Costi LLM")')`, but the body only asserts `screen.queryByText(/BFF\s*·\s*Costi\s*LLM/i)).not.toBeInTheDocument()`. There is no positive assertion that the literal "Costo backend" actually renders. A future regression that DELETES the new label entirely (instead of renaming) would pass this test. Recommend adding `expect(screen.getByText('Costo backend')).toBeInTheDocument()` to lock the rename in both directions.
*Severity*: LOW. The diff visibly shows the literal `Costo backend` in JSX; this is a test-quality residue from round-1 HIGH-3, not a current production bug.

**NEW-FE-R2-2 · `npm run test` does not exist (LOW)**
*File*: `package.json` scripts
*Why this matters*: New vitest tests at `src/components/__tests__/*.test.tsx` are runnable via `npx vitest run`, but there is no `"test": "vitest run"` (or similar) script in `package.json`. Only `"test:e2e": "playwright test"` and wave-specific scripts exist. **CI configuration (if there is one) that calls `npm test` would NOT execute the new tests.** The fixer's commit message claims "All 90 tests pass" — true locally, but not enforced in CI by default. Recommend adding `"test": "vitest run"` to scripts so CI picks them up.
*Severity*: LOW promoted to MEDIUM if CI does not currently run vitest. Worth confirming with the build pipeline owner.

**NEW-FE-R2-3 · `test-setup.ts` is one bare import line — vulnerable to silent removal (LOW)**
*File*: `src/test-setup.ts`
*Why this matters*: The file is literally one line: `import '@testing-library/jest-dom';`. The custom matchers (`.toBeInTheDocument()`, `.not.toBeInTheDocument()`) come from that side-effect import. If someone runs an organize-imports tool or removes the file "because it's empty-looking", all the new DOM assertions silently turn into no-ops (jest-dom matchers fall back to vitest defaults that match anything truthy/falsy). Recommend adding a one-line `// must be imported before any test — installs jest-dom custom matchers` comment to discourage removal.
*Severity*: LOW. Minor robustness improvement, not a regression.

**No regressions detected** in unrelated code paths. The 6 unchanged modified files (DashboardContext, lib/api, lib/storage, lib/printSchedule, etc.) were not touched by this commit — only `package.json`, `package-lock.json`, `OptimizationLoader.tsx`, `OptimizationLoader.test.tsx`, `no-opus-47-copy.test.ts`, `DashboardHeader.tsx`, `$slug.tsx`, `test-setup.ts`, `vitest.config.ts`.

### Updated recommendation

**MERGE-WITH-FOLLOWUPS**.

All 3 HIGH findings are RESOLVED. The 3 NEW findings are LOW severity — none block merge. Recommend a follow-up commit (not blocking) for:
1. `NEW-FE-R2-1`: add positive `getByText('Costo backend')` assertion.
2. `NEW-FE-R2-2`: add `"test": "vitest run"` script in package.json.
3. Pre-existing MEDIUM/LOW findings (MEDIUM-1 Cmd+P, MEDIUM-4 solveLLMOnly misnomer, MEDIUM-5 NaN guard, LOW-1 dotenv, LOW-2 current-slug overwrite) are not addressed and remain open as tracked follow-ups.

---

## Summary

- **0 CRITICAL**, **3 HIGH**, **6 MEDIUM**, **4 LOW** findings.
- Recommendation: **FIX-BEFORE-MERGE**. The "BFF · Costi LLM" label mislabels a backend cost as a BFF cost in all three solver paths (HIGH-1). The PDF route persists schedule snapshots in `localStorage` indefinitely without cleanup, with cross-tab persistence across companies (HIGH-2). The OptimizationLoader static-content tests do not validate runtime behaviour — they would pass even if the conditional logic were inverted, provided the right string appears in the source (HIGH-3). All three are fixable in <1h; once addressed, the bundle is mergeable.

---

## Findings

### HIGH-1 · "BFF · Costi LLM" block mislabels backend solver cost

**Branch**: `fix/wave-15-ux-polish` (4714a2e)
**File**: `src/components/onboarding/OptimizationLoader.tsx:193`, `:251`, `:277`

**Why this is broken**:
The new `bffCostLog` block is rendered under the header **"BFF · Costi LLM"**, but the cost lines pushed into it come from the **backend solver**, not the BFF:
- Line 193 (`llm-only` path): pushes `result.cost_usd` from `solveLLMOnly(slug)` — which internally calls `solveTemplate(slug, problemType, {})` against `/api/public/solve-template` on the backend. The cost is computed by the backend (always 0 in current implementation per `api.ts:175`).
- Line 251 (`codegen-pipeline` path): pushes `results.cost_usd` from `pipelineResults(session_id)` against `/api/analysis/{sid}/results`. This cost is the **backend Python pipeline's Anthropic cost** (understand + codegen + narrative), NOT a BFF cost.
- Line 277 (`deterministic-json` path): pushes `result.cost_usd` from `solveTemplate(slug)`. Always 0 (no LLM in deterministic mode).

In all three solver paths, the cost line is the backend's cost, never a BFF cost. The plan's claim "Costo: BFF (explainer+advisor auto-fire post-solve)" describes a cost source that the OptimizationLoader does NOT have access to — the loader unmounts on `setDone(true) → setTimeout(onComplete, 1500)` BEFORE the explainer/advisor auto-fire on the Dashboard. So the "BFF · Costi LLM" header is a misnomer in every code path.

**Repro**:
1. Start the app with a real backend.
2. Click "Esegui ottimizzazione" with `codegen-pipeline`.
3. Observe the loader near the end: "BFF · Costi LLM: Costo: $0.014" — but `$0.014` is the backend pipeline LLM cost, not a BFF cost. No BFF call has happened yet by the time this line renders.

**Fix**:
- Either: rename the block header to **"Costo LLM"** or **"Costo backend"** (drop the BFF claim).
- Or: actually wire the BFF cost (explainer + advisor cumulative) into a separate state that lives on the Dashboard and surface it AFTER the loader unmounts.
- Drop the `kind: 'bff'` tag from the addLog calls for `solveLLMOnly` / `solveTemplate` / `pipelineResults` cost lines (they're backend costs) and rename the second block:
  ```tsx
  // before
  addLog(`Costo: $${result.cost_usd?.toFixed(3) ?? '?'}`, 'bff');
  // after
  addLog(`Costo backend: $${result.cost_usd?.toFixed(3) ?? '?'}`);
  ```
- Tests in `src/components/__tests__/OptimizationLoader.test.tsx` would need to assert the renamed block.

---

### HIGH-2 · `localStorage` snapshot leaks across companies and never expires

**Branch**: `fix/wave-15-pdf-print-route` (0f5e1a4)
**File**: `src/components/dashboard/DashboardHeader.tsx:67-72`, `src/routes/print/$slug.tsx`, `src/lib/printSchedule.ts:195`

**Why this is broken**:
`handleExportPdf` writes the full `DashboardData` snapshot to `localStorage` via `setSlugScoped(PRINT_SNAPSHOT_KEY, slug, snapshot)`. The new print route reads it and never deletes it. Each export adds a new persistent entry. Failure modes:

1. **No cleanup**: 50 exports = 50 stale snapshots in `localStorage`. With ~20-50 KB per `DashboardData` snapshot, an active user hits the ~5-10 MB quota in weeks and `setItem` throws (caught by the `try {...} catch` at `DashboardHeader.tsx:71`, which just toasts "Impossibile preparare il piano per la stampa." — silent failure, no diagnostic).
2. **Cross-company leak**: snapshots are slug-scoped (good), but they all live in the same `localStorage`. If two managers share a browser profile (multi-tenant scenario) or a single manager handles two companies, both companies' production schedules sit in `localStorage` indefinitely. Any XSS bug in any part of the app reads ALL of them.
3. **Stale data in new tab**: if the user changes the dashboard plan and clicks "Esporta PDF" again, but the new tab from the PREVIOUS export is still open (and refresh-triggered), it reads the NEW snapshot — surprising mismatch between "the tab I opened 5 min ago" and "the schedule it now shows".

**Repro**:
1. Open dashboard for company A, click Esporta PDF, close PDF tab.
2. Switch to company B, run optimization.
3. Open browser devtools → Application → localStorage → search for `print_snapshot:` — both A's and B's schedules are present.

**Fix**:
After `readSnapshot(slug)` succeeds in `src/routes/print/$slug.tsx`, immediately delete the entry:
```tsx
useEffect(() => {
  const s = readSnapshot(slug);
  setSnapshot(s);
  if (s) {
    removeSlugScoped(PRINT_SNAPSHOT_KEY, slug);  // import from '@/lib/storage'
  }
  setLoaded(true);
}, [slug]);
```
Alternative: switch to `sessionStorage` to scope to a single tab and avoid persistence across tabs — but note `window.open(url, '_blank')` does NOT share sessionStorage between tabs, so the read would fail. The "delete after read" pattern above is the correct fix.

---

### HIGH-3 · OptimizationLoader tests are source-text grep, not behaviour

**Branch**: `fix/wave-15-ux-polish` (4714a2e)
**File**: `src/components/__tests__/OptimizationLoader.test.tsx:42-46`, `:55`, `:64`

**Why this is broken**:
All test assertions in `OptimizationLoader.test.tsx` are `readFileSync` + regex match against the source file content. Examples:
- Line 42-46: asserts `/(i\s*<\s*currentPhase\s*\|\|\s*done)|(...)|(...)/ ` matches the source — but this regex would also match the string inside a JSX comment, a TypeScript template literal, or a code path inside an `if (false) { ... }` dead branch.
- Line 55: asserts an opacity regex that accepts `i <= currentPhase || done` OR `i < currentPhase || done`. The latter would HIDE the currently-running phase (wrong behavior), but the test would PASS.
- Line 64: asserts `(... )? 'text-foreground'` matches — again, can be inside a comment.

This is "tests pass the spec but miss the bug" — a future maintainer can break the behaviour (invert a conditional, move into a non-rendered branch) and the test continues to pass as long as the right string appears somewhere in the file. The teammate's commit message acknowledges this: "static analysis on the source file" — but doesn't flag that this means a typo/inverted-conditional could slip through.

**Repro**:
Apply this hypothetical regression to `OptimizationLoader.tsx:401`:
```tsx
// before (correct)
<span className={(i <= currentPhase || done) ? 'text-foreground' : 'text-muted-foreground'}>
// after (regression — inverted)
<span className={(i > currentPhase && !done) ? 'text-foreground' : 'text-muted-foreground'}>
// also add a comment somewhere with the original string
// "i <= currentPhase || done"
```
The test on line 64 still passes because the regex finds the substring in the comment.

**Fix**:
- Install `@testing-library/react` + `jsdom` (or `happy-dom`) and write actual render tests. The plan claims "the project does not ship @testing-library/react" — that is a fixable gap, not a permanent constraint.
- Or: use vitest's coverage feature with strict branch coverage on this file (>=90%) to at least force the conditionals to be exercised.
- Short-term: add a behaviour-shaped contract test in `playwright` that drives the loader from `phase: optimizing` → `phase: dashboard` and asserts the green-tick on all 4 steps after the backend returns.

---

### MEDIUM-1 · Cmd+P on dashboard still prints whole viewport

**Branch**: `fix/wave-15-pdf-print-route` (0f5e1a4)
**File**: `src/styles.css:193-235`

**Why this is broken**:
The fix only routes the "Esporta PDF" BUTTON to `/print/$slug`. If the user uses the OS native print shortcut (Cmd+P on Mac, Ctrl+P on Windows) on the dashboard tab — habitual for power users — the OLD print path still fires: `@media print` rules in `styles.css` hide `.no-print` elements but keep the entire dashboard (KPI cards + Gantt + AI panels + What-If + Ordini) on the page, producing the 5+ page PDF the plan explicitly aimed to eliminate.

**Repro**:
1. Open dashboard with active plan.
2. Hit Cmd+P (NOT the Esporta PDF button).
3. Observe: full dashboard prints, exactly the bug the plan claimed to fix.

**Fix**:
- Option A: in `styles.css @media print`, hide everything except `.print-only-marker` content. Then add a `.print-only-marker` somewhere that says "Use the Esporta PDF button to print the production plan." — gentle blocker.
- Option B: leave it as-is and accept the partial fix; document the limitation in the wave-15 report so users understand they MUST click the button.
- Option C (preferred): listen for `beforeprint` event on the dashboard and either trigger `handleExportPdf` automatically OR cancel the native print. This is the cleanest UX.

---

### MEDIUM-2 · Compound intent not handled in extractor (cross-cutting, but surfaced here)

**Branch**: N/A — this is a cross-cutting note that becomes visible when the BFF wires up the extractor in W16.2. Listed here only because the UX flows depend on it; full detail is in the backend report.
**File**: `daino/arm_c/constraint_extractor.py:911-925` (backend repo)

**Why this matters for frontend**:
When the BFF integration lands, instructions like "Ferma M01 dalle 14 alle 18 e alza priorità COM-001" return ONLY the first intent. The user has no UI feedback that the second intent was dropped. See backend adversary report for fix details.

---

### MEDIUM-3 · Static-content test for "no Opus 4.7 copy" is grep-fragile

**Branch**: `fix/wave-15-ux-polish` (4714a2e)
**File**: `src/components/__tests__/no-opus-47-copy.test.ts:33-46`

**Why this is broken**:
The test reads the file source and asserts `not.toMatch(/Opus\s*4\.7/i)`. If a future PR adds the string in a JSDoc, a code comment, or even in a string literal NOT shown to the user (e.g., a logging tag), the test fails — false positive. Conversely, if the string is moved to a constant in a different file (e.g., `src/i18n/it.ts`), the test on the original file still passes — false negative. Same gaming risk as HIGH-3 above.

**Fix**:
Either delete the test (the regression would be obvious in dev), OR move to a proper DOM-render test that asserts the rendered text.

---

### MEDIUM-4 · `solveLLMOnly` is a misnomer in api.ts

**Branch**: `fix/wave-15-ux-polish` (4714a2e) — adjacent
**File**: `src/lib/api.ts:136-177`

**Why this is broken**:
`solveLLMOnly(slug)` does NOT call an LLM. It wraps `solveTemplate(slug, problemType, {})` and reshapes the output. The function name is a Wave 4.1 leftover. The OptimizationLoader's `method === 'llm-only'` branch picks this function and shows "Chiamata Solo LLM..." in the solver log — but actually no LLM is called. **The user is told they're using LLM when they're not.** Not a regression caused by Wave 15, but Wave 15 should fix it given it's touching this exact component for label cleanup.

**Fix**:
Rename `solveLLMOnly` → `solveTemplateForLLMOnlyPath` and update the loader log message to "Solo template — fallback determinista" or remove the "Chiamata Solo LLM..." line entirely. Out of strict scope but trivially adjacent.

---

### MEDIUM-5 · NaN displayed in print header on missing KPI

**Branch**: `fix/wave-15-pdf-print-route` (0f5e1a4)
**File**: `src/lib/printSchedule.ts:171, 181`

**Why this is broken**:
`makespanHours: Math.round(data.kpis.makespan * 10) / 10` — if `data.kpis.makespan` is `undefined` (legitimate path: `adaptPipeline` returns `raw.kpis ?? {}`, so missing kpi → NaN), the print header displays `Makespan totale: NaN h`. The route does not validate that essential KPIs are present before rendering.

**Repro**:
Mock a `DashboardData` with `kpis: {}` and call `buildPrintSchedule(data, ...)`. Header.makespanHours = NaN. Then render — user sees "NaN h" on the printed sheet.

**Fix**:
Defensive guards in `buildPrintSchedule`:
```ts
makespanHours: Number.isFinite(data.kpis?.makespan) ? Math.round(data.kpis.makespan * 10) / 10 : 0,
```
Or earlier: in `readSnapshot`, reject if `parsed.data.kpis?.makespan` is not finite. Better: throw a structured error so the print route shows "Snapshot incompleto, riapri dalla dashboard" instead of NaN.

---

### MEDIUM-6 · Plan claim "12 duplicate `2.*` files deleted" not in commit

**Branch**: `fix/wave-15-dev-cleanup` (31caf28 + 5b52ac6)
**File**: meta — `git diff origin/main..origin/fix/wave-15-dev-cleanup --stat`

**Why this matters**:
The prompt and the inline task description claim "12 duplicate ` 2.*` files deleted." The actual commit only renames 6 test files and adds dotenv-cli. The `src/routes/api/__tests__ 2/` directory (Finder copy artifact) is still present on the local FS (untracked) and the 12 duplicate ` 2.*` files were never tracked by git — so they were never "deleted" by the commit. The commit message in `5b52ac6` only mentions moving the tests, not deleting Finder duplicates. This is a documentation drift; the cleanup is incomplete.

**Fix**:
- Add `*\ 2.*` and `__tests__ 2/` to `.gitignore` (or rm the local files outside git).
- Update the wave-15 report to drop the "12 duplicate files" claim, OR rm the Finder-copy files in a follow-up commit on `fix/wave-15-dev-cleanup`.

---

### LOW-1 · `dotenv-cli` silently no-ops if `.env.local` missing

**Branch**: `fix/wave-15-dev-cleanup` (31caf28)
**File**: `package.json:7`

**Why this is broken**:
`dotenv -e .env.local -- vite dev` — if `.env.local` is absent (fresh clone before someone copies `.env.example`), `dotenv.config({ path: ... })` returns `{ error: ENOENT }` without throwing or warning. `vite dev` boots normally, but AI calls fail later with the original `ANTHROPIC_API_KEY not set` error — exactly the symptom W15-02 promised to eliminate. Fresh devs will be confused.

**Fix**:
Add a small `prep-dev` script that checks `.env.local` exists and prints a friendly message:
```json
"predev": "node -e \"require('fs').existsSync('.env.local') || (console.error('.env.local missing — copy from .env.example'), process.exit(1))\""
```
Or use `--quiet=false` on dotenv-cli so the ENOENT shows up in dev output.

---

### LOW-2 · Print snapshot fallback to slug 'current' silently overwrites previous

**Branch**: `fix/wave-15-pdf-print-route` (0f5e1a4)
**File**: `src/components/dashboard/DashboardHeader.tsx:55`

**Why this is broken**:
```ts
const slug = (companySlug && companySlug.trim().length > 0) ? companySlug : 'current';
```
The fallback to `'current'` (legacy DataInputModal path) is shared across all "no slug" cases. If two separate "no slug" companies use Esporta PDF in sequence, the second overwrites the first under the same key. Edge case; user only sees the second one. Note that the print route correctly reads what's there, so no error — just silent overwrite.

**Fix**:
Use a salted key like `current_${Date.now()}` and pass it in the URL — at the cost of localStorage growth (HIGH-2 above kicks in faster).

---

### LOW-3 · Snapshot popup-blocked path leaves stale localStorage entry

**Branch**: `fix/wave-15-pdf-print-route` (0f5e1a4)
**File**: `src/components/dashboard/DashboardHeader.tsx:75-78`

**Why this is broken**:
```ts
const win = window.open(url, '_blank', 'noopener,noreferrer');
if (!win) {
  toast.error('Il browser ha bloccato la nuova finestra. Consenti i popup per esportare il PDF.');
}
```
When popup is blocked, the toast fires — but `setSlugScoped` already wrote the snapshot. That entry now sits in localStorage indefinitely (HIGH-2 again). Combined with HIGH-2, this is a small amplifier.

**Fix**:
After the popup-block toast, also clear the snapshot:
```ts
if (!win) {
  toast.error(...);
  removeSlugScoped(PRINT_SNAPSHOT_KEY, slug);
  return;
}
```

---

### LOW-4 · `deadline_change_v2` test is sign-agnostic (mirrored in extractor cross-cut)

**Branch**: cross-cutting note — surfaced when wiring BFF. See backend adversary report.

---

## What I tried to break but couldn't

- **PDF route XSS via `companyName`**: I tried injecting `<script>` via a crafted `companyName`. React's default JSX text rendering escapes the value — no XSS. Safe.
- **PDF route DST handling**: the date formatter uses ISO regex extraction for backend strings (`YYYY-MM-DD HH:MM` → `dd/MM HH:mm`) — pure string manipulation, no `Date` involvement, so DST is irrelevant. The fallback path uses `new Date(y, mo-1, d).setDate(+dayIdx)` which IS DST-aware via JS engine date arithmetic. Robust.
- **Print route routing collision**: I checked `routeTree.gen.ts` for collisions with existing routes (`/api/*`). The `/print/$slug` route is registered independently with no overlap. Clean.
- **Multiple rapid clicks on Esporta PDF**: opening 5 tabs in 5 seconds works — each tab is independent and reads from the same localStorage key (slug-scoped). No race. The only risk is localStorage bloat (HIGH-2).
- **dotenv-cli overriding shell env**: by default, `dotenv-cli` is additive (`override=false` per `cli.js:33`), so a developer who exports `ANTHROPIC_API_KEY=prod-key` in their shell keeps that key. NOT a security issue.
- **CheckCircle2 condition on baseline (235913b)**: the icon condition `i < currentPhase || done` was ALREADY correct on the baseline. The visible regression was purely on opacity (parent `motion.div` dimming everything including the green tick). The fix is correctly scoped to opacity + label color.
- **Print route's empty `data.kpis`**: while NaN can sneak in (MEDIUM-5), the route does not CRASH — it renders "NaN h" gracefully.

---

## What I didn't test

- **Real browser print output**: I cannot launch a headless browser from this review session. The actual `@page` rules + `page-break-inside: avoid` behaviour on a real WebKit / Blink print engine is untested. Worth a manual smoke before merging.
- **`__tests__ 2/` Finder-copy directories on every contributor's machine**: I only verified the dev-cleanup branch's tracked files. Other contributors may have additional untracked copies.
- **Vite dev boot time impact from `dotenv-cli`**: minor, but adds ~50ms cold-start. Untested.
- **Cross-tab `BroadcastChannel` or `storage` event listeners**: I did not search for code that LISTENS to localStorage changes and might fire on the new `print_snapshot:*` key. If such a listener exists, opening Esporta PDF could trigger unrelated side effects.
- **A11y on the print route**: tabindex, focus management, screen reader support on the "Stampa di nuovo" button — untested.
- **Real Anthropic API behavior with `dotenv-cli`-loaded key on first call**: the workaround works (per the commit verification), but I did not run it myself.
