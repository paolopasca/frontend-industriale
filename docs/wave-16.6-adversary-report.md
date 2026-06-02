# Wave 16.6 — Devil-Advocate Adversarial Review (FINAL)

**Reviewer:** devil-advocate (Opus, READ-ONLY)
**Branch:** FE `feat/wave-16.6` (from `main` @ 50c99d0) · HEAD `5ad7414` · BE untouched (still at the Wave 16.5 merge)
**Status:** FINAL — review complete; closeout commit `5ad7414` scrutinised; green claim independently verified.
**Last updated:** 2026-05-30

---

## VERDICT: **MERGE-CLEAN**

The interpreter wiring landed (option **B** of the old C-WATCH escalation), the test
migration is faithful (no count reduction, no skips), the M-4 re-gate fail-closes,
OBS-1 is symmetric + fail-closed, and the green claim verifies exactly. Every prior
IN-PROGRESS finding (C-WATCH, M-1, M-2, M-3, M-4, H-1, H-2, OBS-1) is now **closed**.
No CRITICAL, HIGH, or MEDIUM defect remains. The two LOW items below are observations,
not blockers.

### Severity counts
| Band | Count | Items |
|------|-------|-------|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 0 | — |
| LOW | 2 | L-1 (dormant UI banner), L-2 (legacy strategy-router fail-open, off-wire) |

### Verified test / build state (run by reviewer, 2026-05-30, on HEAD 5ad7414)
- `npx vitest run --config vitest.server.config.ts` → **25 files / 268 passed · 0 failed · 7 skipped** (matches claim).
- `npx vitest run --config vitest.config.ts` → **20 files / 231 passed · 0 failed** (matches claim; H-1 client suite now GREEN).
- `npx tsc --noEmit` → **clean (exit 0)** (matches claim).

---

## Central lens — ANTI-HALLUCINATION (~100% required): SATISFIED END-TO-END

The three structural guarantees are now all ON THE WIRE (committed `85db2b5` + `5ad7414`):

1. **Closed-set tool-use ENUM** — `instruction-interpreter.ts:137 buildEmitTool` types
   `machine_id`/`order_ids`/`order_id`/`shift_id` as JSON-schema `enum` of the live plan
   ids, `tool_choice` forced. Haiku literally cannot place "M99" in an enum field; off-set
   refs funnel to `unresolved_target`.
2. **Deterministic re-validation gate** — `instruction-interpreter.ts:395 applyDeterministicGate`
   re-resolves EVERY id via `resolveMachineAlias/Order/Shift` (return null on off-set OR
   ambiguous OR empty set — never fabricate), then bounds + `validateEntities`. Runs BEFORE
   any solve. The old strategy-router fail-open is unreachable here because the resolver
   fails CLOSED on empty set (`entityResolver.ts:44`, `idCanon.ts:19`).
3. **Show-and-confirm** — gray → `requires_confirmation` (no solve); the confirm re-entry is
   itself re-gated (M-4, below).

The wired managerText path (`apply-whatif.ts:735`) is confirmed: `hit`→strategy B + solve,
`gray`→`requires_confirmation` + return, `reject`→`aborted_unsupported` + return with **NO
Opus cascade** (`:767-792` returns directly; `translating`/`translated` never emitted). The
anti-hallucination CLAIM now matches what is on the wire.

---

## Prior findings — final disposition

### C-WATCH (was the verdict-blocker) — **CLOSED**
The interpreter is now WIRED + COMMITTED (`85db2b5`, `5ad7414` — option B). The ~50 legacy
tests pinned to the old parseIntent Strategy-A/B/C model were migrated to the interpreter
`tool_use(emit_constraint)` shape, NOT deleted (option C was not taken). The wave's
anti-hallucination claim is therefore honest: the enum + gate run on the live solve path.

### M-4 — gray→confirm re-gate — **CLOSED (verified fail-closed)**
`apply-whatif.ts:35 regateConfirmedRules` re-resolves every entity id in the client-echoed
`confirmedPayload` against a freshly-rebuilt live closed set on the `userConfirmedGrayZone`
re-entry (`:881-904`). Verified probes:
- Off-set machine `{unavailable_machines:{M99:[…]}}` → `resolveMachineAlias` null → abort
  `aborted_unsupported(unresolved_entity_target)`, NO solve, `fetch` never called
  (`apply-whatif-m4-regate.test.ts:132`). ✓
- Off-set order `{priority_orders:['COM-999']}` → abort, NO solve (`:156`). ✓
- Valid `M02` → canonicalised + solves; alias `m02` → canonicalised to `M02`, the loose key
  dropped (`:172`, `:191`). ✓
- **Probe — can any path still reach the solver with an unresolved id?** No:
  - `extra_capacity.machine_id` IS re-gated (`:80-84`); off-set → abort.
  - The `"?"` sentinel is caught explicitly BEFORE the re-gate (`:858`) AND would fail the
    re-gate (`resolveMachineAlias("?")` → null).
  - The re-gate covers exactly the 5 slots `buildRulesPayload` can emit
    (`unavailable_machines`/`priority_orders`/`deadline_changes`/`extra_capacity`/`shift_changes`,
    `strategy-router.ts:348-381`). No entity-bearing slot is missed.
- **Probe — is `shift_changes` re-gated only when `ctx.shifts` non-empty a hole?** No. The
  interpreter's gray-emit gate (`resolveShiftAlias`, fail-closed on empty shifts,
  `entityResolver.ts:100`) means an off-set `shift_id` can never be in a `confirmedPayload`
  when `ctx.shifts` is empty in the first place — so the skip is belt-and-suspenders, not a
  leak. With a non-empty shift set the re-gate runs (`:90-98`). Sound.
- The Strategy-C (Opus translator) gray path also flows through the SAME re-gate (it sets
  `strategyKind='C'` and re-enters the confirmed-payload handler), so the legacy translator
  gray payload is re-gated too. ✓

### M-1 (ledger overlap-aware merge) — **CLOSED.** Disjoint same-machine windows accumulate,
overlapping replace, identical dedup; the silent disjoint-drop is gone
(`appliedRulesLedger.test.ts`). NEW-WINS fold order chronological. Re-confirmed unchanged.

### M-2 (ledger UI wiring + cross-plan leak guard) — **CLOSED.** `appendRule` on whatif+
reschedule accept, `clearLedger` on reset, slug-scoped — no cross-plan leak. Re-confirmed.

### M-3 (`canonicaliseId` collision-aware) — **CLOSED.** `idCanon.ts:79-85` collects ALL
distinct TIER-2 derived matches and returns null on >1 (ambiguous → refuse). Re-probed
`known={M1,M-001,M02}`: `m001`→M-001, `linea 1`→null, `m1`→M1, `M99`→null. The `m-1`→M1
residual is pinned as an intentional tested choice (`ff46f80`); principled ("exact literal
wins, else unique derive, else null"). ✓

### H-1 (PDF synchronous open + stale test) — **CLOSED.** Source committed `b9fc72a`; test
rewritten `5ad7414` (`DashboardHeader.export.test.tsx`). The new test asserts synchronous
open (`openMock).toHaveBeenCalledTimes(1)` with no fake-timer tick), setItem-before-open
ordering (`:74-76`), `win.opener=null` (`:79`), and ADDS the popup-blocked rollback path
(`:83-98`) — a STRONGER assertion than before, not weaker. Client suite GREEN.

### H-2 (§D empty-solution guard regression) / H-3 (slug flake) — **CLOSED.** Server suite
268/0 over the verification run; the H-3 shared-slug flake did not surface. §D guard is
status-gated (`apply-whatif.ts:1153 isSuccessStatus && solvedPhaseCount===0 &&
baselinePhaseCount>0`), placed after the solver call and before KPI emit. adaptResult
untouched.

### OBS-1 (order closed-set harvest) — **CLOSED + verified correct, fail-closed, no
mis-harvest.** `solutionContext.ts:125 extractOrders` now harvests orders from BOTH
`Object.keys(commesse)` AND flat `fasi[].commessa` (symmetric with `extractMachines`).
- **Fail-closed preserved:** a genuinely empty plan → empty `commesse` + empty `fasi` →
  `orders=[]` → `resolveOrderAlias` returns null on the empty set (`entityResolver.ts:89`→`:44`)
  → reject. Per `feedback_closed_set_fail_closed`. ✓
- **No mis-harvest of a non-order token:** `commessa` is read only from schedule phase
  records (`collectOrdersFromFasi:111`), and `extractCommesse:204-209` only treats a root key
  as a commessa if its value is an object carrying a `fasi` array — a stray
  `time_config`/`kpis` sibling is excluded. The guard test
  `solutionContext-aliases.test.ts:114` explicitly proves `time_config` is NOT treated as a
  commessa while `COM-001` IS harvested from `fasi[].commessa`. ✓

---

## Test-gaming audit (CRITICAL lens) — CLEAN

Read the rewritten obsolete-premise files whole. The migration is faithful:
- **No `.skip` / `.only` / `.todo` / `xit` / `xdescribe`** in any changed test file (grep clean;
  the single `skipped_rules_count` hit is a backend-rule assertion, not a test skip).
- **`it()` counts identical base→HEAD** on every migrated file: low-confidence 5/5, wave7 11/11,
  wave7-infeasible 13/13, wave8-not-implemented 3/3. Nothing deleted to dodge red.
- **Assertions test REAL replacement behavior, not weakened/vacuous:**
  - `apply-whatif-low-confidence.test.ts`: low/medium → GRAY `requires_confirmation`, asserts
    `not.toContain('solved')` + `fetch not called` + `anthropicCreate toHaveBeenCalledTimes(1)`
    + confidence echoed + alias `M2`→`M02` canonicalisation pinned (`Object.keys(unavail)==['M02']`).
    `unknown+low` → reject, NO Opus (`not.toContain('translating'/'translated')`, exactly 1 LLM call).
  - `apply-whatif-wave7-infeasible.test.ts` (B-W8-S-04 block): asserts EXACT event sequence
    `['parsing_intent','intent_parsed','routed','aborted_unsupported','done']`, no Opus, exactly
    1 LLM call; INFEASIBLE-recovery cases (frozen-phase retry, retry cap) untouched and still green.
  - `apply-whatif-wave7.test.ts` (Strategy-C / F-W7-08): unknown→aborted via interpreter no
    cascade; F-W7-08 asserts the REPLACEMENT audit channel `applied_rules.unavailable_machines.M02
    == [{2160,2520}]` (the dead `dataset_overrides_summary` Strategy-A channel correctly emptied).
- **Dead-code removal honest:** the `low_confidence_classification` push on the hit path was
  removed because a HIT is always high-confidence (low/medium routes to gray upstream) — it was
  genuinely unreachable. No source path emits the marker now (grep: only display-only references
  remain). No test lost a meaningful assertion as a result.

---

## Other lenses

- **Lens 5 (regression vs 16.5):** Ripianifica (`reschedule-fresh.ts:240`) uses the interpreter
  as an ADDITIVE fallback only on extractor MISS/GRAY; honors hit/gray/reject; the
  `needs_day_clarification` short-circuit is preserved UPSTREAM (`:209`). accept-candidate, the
  ledger NEW-WINS merge, §D guard, §E `time_window_start_unsupported` flag (`:691`) all intact.
  The interpreter swap broke nothing.
- **Lens 6 (temporal drift):** `CONVENZIONI_TEMPORALI` is a single exported const
  (`intent-parser.ts:45`) imported verbatim by the interpreter (`instruction-interpreter.ts:3`,
  used `:246`). No fork. ✓
- **Lens 7 (cost):** Interpreter is ONE Haiku call (`HAIKU_MODEL`, `:93`), system prompt cached
  (`cache_control: ephemeral`, `:552`). No Opus on hit/gray/reject (verified: reject returns
  before `translating`; gray returns at `requires_confirmation`). Reschedule path: no Opus.
  Chat alias path: pure `entityResolver`, no extra LLM call. ✓
- **Lens 8 (security):** Prompt-injection guard present (`<user_message>` isolation +
  "ignora istruzioni"→`unknown`, `:234-237`); user text XML-escaped (`:112`) and length-capped
  (`:95`). No `ANTHROPIC_API_KEY` in the client bundle (the only `src/lib`/`src/components`
  references SCRUB the key name from user-facing error strings — the opposite of a leak;
  interpreter lives in `src/server/llm/`). Chat tools sanitize id BEFORE resolving
  (`manager-chat-tools.ts:82 resolveId`→`sanitizeId` then resolver) and dispatch NO solve / NO
  network / NO mutation (`:13`) — the chat surface stays read-only. `idCanon`/`entityResolver`
  regexes are anchored/linear — no ReDoS. ✓

---

## LOW / OBSERVATIONS (non-blocking)

**L-1 — dormant low-confidence UI banner.** `SolutionDiff.tsx:285 LOW_CONFIDENCE_WARNING` +
the dedicated banner (`:325`) and `unsupported-reason-labels.ts:78` remain, but no source path
emits `low_confidence_classification` anymore (the gate routes low/medium to gray). The banner
is now unreachable display code — harmless (renders nothing if the marker never arrives), but a
cheap future cleanup. Not a defect.

**L-2 — legacy strategy-router fail-open is now fully off the wire.**
`strategy-router.ts must_exist_in_solution_machines` passes any id when `ids.machines.size===0`
(fail-open). With the interpreter wired (option B), the managerText solve path no longer calls
`parseIntent`→`routeIntent`, so this branch is dead on the what-if surface. `validateEntities`
is still invoked by the interpreter's gate, but only AFTER `resolveMachineAlias` has already
fail-CLOSED on the empty set, so the fail-open is unreachable. Tracking as a someday
belt-and-suspenders tidy (make the router guard fail-closed too), not a 16.6 issue.

---

## Lens tracker (final)

| # | Lens | Status |
|---|------|--------|
| 1 | Anti-hallucination (enum + gate + confirm) | ✓ WIRED + on-the-wire; reject/gray/hit honored, NO Opus cascade; M-3 + M-4 closed |
| 2 | Ledger merge (NEW-WINS) + cross-plan leak (clearLedger) + cumulative | ✓ M-1 + M-2 closed |
| 3 | Gantt empty-solution guard; adaptResult untouched | ✓ status-gated, +/- tests, adaptResult untouched |
| 4 | Time-anchor amber flag honest | ✓ |
| 5 | Regression vs Wave 16.5 (Ripianifica, PDF, accept-candidate) | ✓ H-1 closed; reschedule additive-fallback intact |
| 6 | Temporal-convention drift | ✓ single exported const, no fork |
| 7 | Cost (~$0.0014/msg, no Opus on reschedule/managerText path) | ✓ |
| 8 | ReDoS / security on new regex + injection + key leak | ✓ |

---

## Final sign-off

All re-verify checklist items for **option B** are satisfied:
- (a) full server suite GREEN ×1 verified (268/0/7-skip) after the test migration; client GREEN (231/0); tsc clean.
- (b) M-4 fixed — tampered off-set `confirmedPayload` (M99 / COM-999) rejects, does not solve (tested + reasoned).
- (c) interpreter caller honors reject/gray/hit on COMMITTED code (verified by reading the wired path).
- (d) test migration faithful (counts preserved, no skips, real assertions) — coverage NOT reduced.
- (e) H-1 GREEN.
- (f) M-1 / M-3 probes re-run clean.

**MERGE-CLEAN.** No code edits or commits were made by the reviewer (READ-ONLY).
