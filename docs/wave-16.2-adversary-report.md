# Wave 16.2 — Adversary Report (BFF integration)

> Reviewed by devil-advocate agent on 2026-05-26 (final).
> Recommendation: **MERGE-WITH-FOLLOWUPS**.

## Summary

Wave 16.2 wires `daino-backend-definitivo`'s deterministic constraint
extractor (`POST /api/internal/extract-constraint`, merged in backend
commit `c97618f`) into the frontend BFF, with a UI confirmation modal
for GRAY_ZONE results.

- Goal: when backend HITs (confidence ≥ 0.85), skip Opus 4.7 → −69%
  cost on apply-whatif clicks. When backend GRAY_ZONEs (0.5-0.85),
  pause server-side, show modal, user confirms or asks for Opus.
- Branch: `fix/wave-16-bff-integration`.

**Severity tally at sign-off**: 0 CRITICAL, 0 HIGH, 0 MEDIUM, 3 LOW.

**Findings intercepted during review**: 3 CRITICAL, 7 HIGH, 5 MEDIUM,
5 LOW across four rounds. All blockers fixed in-branch before merge.

## Review timeline

| Time  | Commit    | Author            | Purpose                                                         |
|-------|-----------|-------------------|-----------------------------------------------------------------|
| 15:05 | `041719b` | ui-modal          | Modal component + initial integration shell                     |
| 15:10 | `1c00f12` | bff-orchestrator  | BFF orchestration layer + extract-constraint-client + tests     |
| 15:10 | `7397262` | ui-modal          | UI DRIFT-A/B/C + LOW-1/2 fixups                                 |
| 15:13 | `120dd1e` | ui-modal          | Modal aligned with the "solver runs in parallel" interim design |
| 15:14 | `13063ca` | bff-orchestrator  | DRIFT-A/B/C/E + MEDIUM-1/2 fixups                                |
| 15:16 | `e37a601` | bff-orchestrator  | `.env.example` documentation                                    |
| 15:18 | `38dcacd` | ui-modal          | (stale) hide Riformula; simplify handlers to dismiss-only       |
| 15:19 | `5d38182` | bff-orchestrator  | **Real server-side pause** + retry contract (`requires_confirmation`) |
| 15:21 | `ccb3a59` | ui-modal          | UI realigned to the real BFF contract                           |
| 15:21 | `7044b9d` | bff-orchestrator  | DRIFT-D orders extraction + DRIFT-E NL aliases restored + test:server |
| 15:24 | `5243da1` | ui-modal          | LOW-2 clear stale translatorChange on gray-zone cancel          |

## Findings — disposition

### CRITICAL-1 · Route doesn't honour `requiresConfirmation` (resolved by `5d38182` + `ccb3a59`)
**Original break**: route emitted `translated` then unconditionally
proceeded to solve. UI opened a decorative modal AFTER the solver
had already started. User clicked Annulla, but `solved` event still
arrived because the abort fired against a closed stream.

**Resolution**: `5d38182` made the safety gate real:
- Route emits `requires_confirmation` with `confirmationMessage`,
  `confidence`, `confirmedPayload` and closes the stream
- Solver does NOT run
- BodySchema accepts `userConfirmedGrayZone`, `confirmedPayload`,
  `forceOpusFallback`
- On confirm retry: route skips translator, uses `confirmedPayload`
  as `rulesForSolve` directly
- On Opus retry: translator skips backend extractor

`ccb3a59` wired the UI to the new contract:
- Dedicated `requires_confirmation` SSE handler
- `handleGrayZoneConfirm` re-fires with retry flags
- `handleGrayZoneOpus` re-fires with `forceOpusFallback`
- Removed the now-stale `translated`+`requiresConfirmation` modal-open

### CRITICAL-2 · Cost record skipped on HIT/GRAY_ZONE (resolved by `13063ca`)
**Original break**: HIT/GRAY_ZONE branches in
`translateWhatIfToConstraint` skipped `options?.onUsage?.(...)` →
`lastUsage` stayed null → `flushCost()` no-op → no
`recordCost({surface:'whatif_apply'})` for HIT clicks → cost
dashboard blind to all Wave 16.2 traffic.

**Resolution**: `13063ca` invokes `onUsage({cost_usd: 0, ...})` on
HIT and GRAY_ZONE branches before returning. `whatif_apply` cost
records exist for every request regardless of band.

### CRITICAL-3 · UI/BFF contract drift in adjacent commits (resolved by `ccb3a59`)
**Original break**: `38dcacd` (15:18) hid the Riformula button and
simplified handlers to dismiss-only on the assumption that
`forceOpusFallback` would not ship in Wave 16.2. `5d38182` (15:19)
shipped exactly that. UI was in the old "solver runs in parallel"
design while BFF had moved to "server-side pause" → user clicked
Conferma, nothing happened, plan unchanged.

**Resolution**: `ccb3a59` rolled the UI forward to match `5d38182`'s
real retry contract.

### HIGH-1 · Hardcoded localhost prod fallback (resolved by `13063ca`)
**Original**: `extract-constraint-client.ts:21` had
`process.env.VITE_API_BASE_URL || 'http://localhost:8001'`. In prod
with the env unset, every click ECONNREFUSEs → silent fallback to
Opus → −69% win becomes −0%, no alarm.

**Resolution**: hardcoded fallback removed. When either secret or
URL is missing in production, the function returns null with a
`console.warn`. The BFF then falls back to Opus deliberately.

### HIGH-2 · Fabricated shifts breaking degradation contract (resolved by `13063ca`)
**Original**: `solutionContext.ts:118` returned
`['mattino', 'sera', 'notte']` when `shift_types` was null. Backend
extractor could HIT on "il turno mattino" with a payload referring
to a shift_id the solver didn't know about → INFEASIBLE downstream.

**Resolution**: empty array when `shift_types` is null. Backend
handlers degrade to MISS gracefully (the intended path per
`routes_internal.py:92`).

### HIGH-3 · Orders/deadlines from a non-existent field (resolved by `7044b9d`)
**Original**: `solutionContext.ts:104` read `envelope.commesse`.
That field exists on the normalised `AiSolutionEnvelope` (set by
`buildAiSolutionEnvelope`) — but the bff-orchestrator's first
review thought the route was sending the raw backend payload, and
panicked. The actual flow: UI passes `aiInputs.solution` which IS
the normalised envelope, so `commesse` IS populated. But the test
fixtures used a raw shape, and the original `extractCommesse`
didn't read raw either, so both real prod call AND test fixture
path were broken.

**Resolution**: `7044b9d` `extractCommesse` reads both shapes —
normalised `solution.commesse` first, raw `solution.solution`
fallback. Orders/deadlines populate correctly regardless of which
caller passes which shape.

### HIGH-4 · DRIFT-E v1 alias canonical mismatch (resolved by `13063ca`)
**Original**: machine `'M-1'` → alias value `'M01'` (padded
synthetic ID). Backend HIT produces `unavailable_machines: {M01: [...]}`
but the solver knows `'M-1'` → INFEASIBLE or silent drop.

**Resolution**: alias VALUE is now exactly one of the strings in
`machines[]` (literal canonical, no padding).

### HIGH-5 · DRIFT-E v2 NL alias overcorrection (resolved by `7044b9d`)
**Original**: `13063ca` fixed canonical-mismatch but eliminated all
NL pattern matching. `buildMachineAliases` only emitted aliases
when `lower !== m`. User saying "ferma la linea 1" couldn't match
any alias key for canonical `'M-1'` → MISS.

**Resolution**: `7044b9d` restored "linea N" / "macchina N" /
"machine N" alias keys, all pointing to the EXACT canonical string
from `machines[]`.

### HIGH-6 · UI race / double-fire (resolved by `7397262`)
**Original**: rapid clicks on apply could create overlapping SSE
streams. Modal payload could mismatch the in-flight scenario.

**Resolution**: `grayZoneRef` mirrors state for closure-free reads;
`runApplyWhatIfWithFlags` early-returns while modal is open unless
the call is a modal-triggered retry.

### HIGH-7 · UI `pendingPayload` TS error (resolved by `7397262`)
**Original**: interface renamed to `confirmedPayload` but state
init still used `pendingPayload: {}`. Branch wouldn't compile.

**Resolution**: state init aligned.

### MEDIUM items — all resolved

- MEDIUM-1 (test split): `13063ca`
- MEDIUM-2 (unsupported HIT falls through to Opus): `13063ca`
- MEDIUM-3 (.env.example docs): `e37a601`
- MEDIUM-4 (no `test:server` npm script): `7044b9d`
- MEDIUM-5 (modal contract / retry mismatch): `ccb3a59`

## LOW items — accept and track

### LOW-1 · `vitest@^4.1.7` pre-release version
`package.json:105` pins a major version that may resolve to an
unstable tag. Verify the lockfile pins a real published version
before merge. If CI passes, move on; if it doesn't, downgrade.

### LOW-2 · Modal confidence band loses fidelity
Backend confidence 0.52 and 0.83 both map to the same "media" string
because of the qualitative roundtrip (float → 'high'|'medium'|'low'
→ representative float → band string). Acceptable for Wave 16.2;
revisit if managers want more nuance.

### LOW-3 · `translated` event still fires for GRAY_ZONE
The route emits `translated` BEFORE checking `requiresConfirmation`,
so the UI briefly stores the partial change in `translatorChange`.
Display-side this gives context, but couples the GRAY_ZONE preview
to the simplified `translated` handler. Consider gating the emit
on `!tr.change.requiresConfirmation` in `apply-whatif.ts:615`.

## What I tried to break but couldn't

- **Secret leakage via committed env files**: `.gitignore` correctly
  covers `*.local`, `.env*`, and `.dev.vars` (lines 18, 21, 25).
  The 64-hex secret in the working tree is not trackable.
- **Client-bundle secret import**:
  `src/server/llm/extract-constraint-client.ts` is server-only; no
  client file imports it (grep clean). No `VITE_` prefix on the
  secret.
- **Auth secret in error response back to client**:
  `extractConstraintFromBackend` returns only the enum + payload,
  never request headers. Route catches HTTP errors and emits
  generic SSE events. Secret never propagates.
- **Backend error body echoing the secret**: the warn at
  `extract-constraint-client.ts:50` logs `await res.text()`. The
  backend's 401 body is the generic string "missing or invalid
  X-Internal-Secret" — no header echo. Defense-in-depth could be
  to log only `res.status`, but no concrete leak today.
- **Infinite Riformula loop**: `5d38182` added
  `forceOpusFallback` to BodySchema AND threaded it through the
  translator (`input.forceOpusFallback` skips the extractor).
  Retry now goes straight to Opus. Verified.
- **Wave 15 / 16.1 regressions**: the Wave 7 path
  (`managerText` present) bypasses `translateWhatIfToConstraint`
  entirely (route line 585: only Strategy C calls the translator).
  Verified by inspection of `apply-whatif.ts:582-625`.

## What I didn't test

- **Live backend integration**: I worked entirely from static
  reading. A real end-to-end run with backend `c97618f` responding
  HIT/GRAY_ZONE/MISS would close the verification loop. Strongly
  recommend a smoke test against a live backend before merging to
  main.
- **Regression on 5 existing intent types per band**: tests
  exercise HIT/GRAY_ZONE/MISS but not each of the 5 intent types
  (`block_machine`, `force_priority`, `add_capacity`,
  `modify_deadline`, `shift_window`) per band. Recommend Wave 15
  e2e suite re-run.
- **Modal a11y (focus trap, ESC dismiss, screen-reader labels)**:
  Radix Dialog usually handles these; the modal's own test file
  doesn't assert any. Out of scope for adversary review.
- **`time_config.start_date` ISO format vs. epoch**: backend
  Pydantic is `dict[str, Any]`, accepts whatever. If start_date is
  sent as ISO but backend handlers expect epoch minutes, deadline
  calculations may silently produce nonsense. Verify against a
  real "anticipa COM-001 di 3 giorni" instruction.
- **Cloudflare/Nitro SSR env-var resolution**: I assumed
  `process.env.VITE_API_BASE_URL` is accessible at SSR runtime.
  Some Nitro configs only expose `VITE_*` keys via
  `import.meta.env`. Worth a `console.log` canary in dev.
- **`forceOpusFallback` and `userConfirmedGrayZone` retry-path
  tests**: not exercised in `bff-extract-constraint.test.ts`. The
  orchestration logic is one-liner each, but worth two test cases
  to lock the contract.

## Recommendation

**MERGE-WITH-FOLLOWUPS**.

The safety contract is real:
- HIT (confidence ≥0.85) skips Opus and is logged in cost dashboard.
- GRAY_ZONE pauses server-side, UI shows modal, manager confirms or
  asks for Opus.
- MISS falls through to Opus transparently.
- Backend down, secret missing, or URL missing — Opus fallback fires
  silently (with a warn in prod).

Track the 4 LOW items in `docs/to_do/` and add the 2 missing retry-path
tests as a follow-up. The 3 CRITICAL, 7 HIGH, and 5 MEDIUM items were
intercepted in-branch.

Wave 16.1 had 4 rounds of escapes. Wave 16.2 had 4 rounds of fixes —
the difference, this time, is that the team owned each finding and
shipped a concrete commit per round. Adversarial pressure compressed
into the same wave window. Recommend keeping this pattern.
