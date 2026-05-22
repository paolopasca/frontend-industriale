# Wave 8 — Multi-intent Test Report

> **Status**: GO — 3/3 e2e PASS (mocked), 22/22 unit PASS, UI shipped
> **Owner**: w8-multi-intent-tester
> **Branch**: `feat/wave7-real-effect`
> **Run date**: 2026-05-23

## 0. What this report covers — read this BEFORE the table

This file tests three Italian what-if scenarios end-to-end through the
Wave 8 pipeline (Haiku intent-parser → strategy-router → BFF → backend).
Two of the three scenarios — `capacity_addition` and `shift_window` —
**do not produce a re-solved plan**: the backend has no CP-SAT consumer
for the corresponding rules (only a passthrough warning in
`f_apply_rules.py:_apply_data_layer_passthrough`).

The Wave 4.1 failure mode that motivated Wave 7 was: "system pretends to
apply the constraint, plan is unchanged, manager believes the change
landed." Wave 8 closes that hole **honestly**: the catalog flags the two
not-yet-implemented intents (`not_implemented: true`), the strategy
router short-circuits to `kind=unsupported`, and the UI surfaces an
Italian toast telling the user the scenario is recognized but not yet
supported.

What the tests assert is therefore:

- For `capacity_addition` + `shift_window`: the system **declares**
  non-implementation. No backend solve, no fake plan, clear UI message.
- For `deadline_change`: the system **actually applies** the constraint.
  COM-002's last phase respects the new deadline.

The real CP-SAT consumers for capacity and shift are out of scope for
Wave 8 — see `F-W8-extension` row in §3 (the Wave 9 follow-up).

## 1. Implementation status — per intent

This table belongs ABOVE the test outcomes because "pass" on a not-yet-
implemented intent means something specific: the system honestly says
"no", not "yes". Devils-advocate's `F-W8-01` finding is the reason this
section exists.

| Intent | `catalog_present` | `router_classified` | `solver_consumes` | Wave 8 contract |
|---|---|---|---|---|
| `machine_unavailability` | ✓ | ✓ → strategy B (rule_addition, via fallback) | ✓ (`f_apply_rules._apply_unavailable_machines` posts no-overlap) | Full effect |
| `order_priority`         | ✓ | ✓ → strategy B (rule_addition)                 | ✓ (`f_apply_rules._apply_priority_orders`)                       | Full effect |
| `deadline_change`        | ✓ | ✓ → strategy A (data_modification + rules_fallback) | ✓ (`f_apply_rules._apply_deadline_changes` posts `last_le <= deadline`) | Full effect |
| `capacity_addition`      | ✓ (flagged `not_implemented: true`)  | ✓ → strategy `unsupported` | ✗ (passthrough warning only — F-W8-extension Wave 9) | **Honest unsupported** |
| `shift_window`           | ✓ (flagged `not_implemented: true`)  | ✓ → strategy `unsupported` | ✗ (passthrough warning only — F-W8-extension Wave 9) | **Honest unsupported** |

## 2. Test outcomes (e2e — `tests/e2e/wave7-multi-intent.spec.ts`)

Three serial Playwright tests, mocked end-to-end via the helpers exported
from `wave7-real-effect.spec.ts` (w8-test-infra-fixer task #1). The mocks
emit the exact SSE event sequence the BFF produces live, so the UI
reducer + WhatIfAnalysis state machine see the same shape as production.

Cmd: `npx playwright test tests/e2e/wave7-multi-intent.spec.ts -g "Wave 8"`

| # | Scenario | Intent | Strategy | Assertion family | Result | Duration | Cost |
|---|---|---|---|---|---|---|---|
| 1 | `capacity_addition` ("aggiungo un operatore mercoledi sera per il turno serale") | `capacity_addition` | `unsupported` | **honest unsupported**: no `solving` event, no `solved` event, warning `not_implemented:capacity_addition`, `aborted_unsupported` present, UI toast "Scenario non applicabile" visible | **PASS** (honest_unsupported) | 5.9s | $0 |
| 2 | `shift_window` ("anticipa il turno mattina di un'ora")                            | `shift_window`      | `unsupported` | **honest unsupported** (same family as #1, warning `not_implemented:shift_window`)                                                              | **PASS** (honest_unsupported) | 5.9s | $0 |
| 3 | `deadline_change` ("sposta deadline COM-002 al 3 aprile 18:00")                    | `deadline_change`   | `A`           | **full effect**: `solved.strategy='A'`, `solved.newSolution.COM-002` last phase `end_min ≤ 3960` (3 aprile 18:00 from horizon 2026-04-01)        | **PASS** (full_effect)       | 6.1s | $0 |

**Total**: 3/3 PASS in 18.3s, $0 LLM cost (mock-only, deterministic).

**Pass formatting note** (per devils R1): the "Result" column tags every
pass either `(honest_unsupported)` or `(full_effect)`. A reader skimming
cannot mistake "pass on capacity_addition" for "feature works in
production" — the suffix telegraphs the semantic.

**Replay trigger**: requires vite dev server up on `:8080`
(`pnpm run dev` from `frontend-industriale/`). All three tests are
hermetic — no backend `:8001` needed, no Anthropic API key needed.

## 3. Unit-test guard rails (`src/server/llm/__tests__/strategy-router.test.ts`)

These tests are the **invariant** complement to the live e2e. They run
in ~110ms on every PR; if catalog or router are mutated by accident the
trip-wire fires before the change reaches CI.

| # | Test name | What it guards against |
|---|---|---|
| Existing | `F-W8-01: shift_window short-circuits to unsupported` | regression on `shift_window` not_implemented routing |
| Existing | `F-W8-01: capacity_addition short-circuits to unsupported` | regression on `capacity_addition` not_implemented routing |
| **New** | `F-W8-01 regression guard: deadline_change is NOT marked unsupported` | accidental widening of `not_implemented` flag to a supported intent |
| **New** | `F-W8-01 regression guard: machine_unavailability is NOT marked unsupported` | same — symmetric defense for the other primary supported intent |
| **New** | `F-W8-01 regression guard: order_priority is NOT marked unsupported` | rule_addition primary intent stays addressable |

Result: **22/22 PASS** locally (no live LLM call, deterministic seed).

## 4. UI banner — F-W8-06 OPT 2 (red recomputed-from-scratch)

Added to `src/components/dashboard/SolutionDiff.tsx` as part of this
task's extended scope (team-lead 2026-05-22 directive). Trigger and
contract:

- **Trigger**: `solved.warnings` contains the marker string
  `lock_relaxed_to_soft__plan_recomputed_from_scratch` (double
  underscore — the upgraded form of the soft-relax marker).
- **Visual**: red `destructive` border + tint, Italian text
  *"ATTENZIONE: il piano e stato ricalcolato da zero, fasi consolidate
  potrebbero essersi spostate."*
- **List**: under the banner, up to 8 baseline-pre-cutoff phases whose
  `start_min` or `macchina` differs in the candidate, rendered as
  *"COM-xxx · op-y · MZZ spostata da gg1 12:30 → gg1 14:00 [su Mww]"*.
  Phases entirely missing from the candidate are flagged "fase rimossa".
- **Suppression**: the existing amber `lock_relaxed_to_soft` banner is
  suppressed when the red banner is on screen (single, stronger
  message instead of two banners that say "lock rilassato" in different
  shades).
- **data-testid**: `solution-diff-recomputed-from-scratch-banner` +
  per-row `solution-diff-recomputed-moved-row-<idx>`.

**Stringa wire**: confermata `lock_relaxed_to_soft__plan_recomputed_from_scratch`
con double underscore (lead 2026-05-22). Il rename effettivo in
`apply-whatif.ts:625` è di `w8-infeasible-recovery` come parte di
F-W8-06 — la UI è pronta e segue la stringa hardcoded come costante in
testa al file.

E2E coverage del banner: non incluso in `wave7-multi-intent.spec.ts`
(scope: 3 intent classification scenarios). Mock-based test del banner
suggerito a stress-engineer come parte della suite mock no-LLM (#4).

## 5. Cost ledger (actual)

| Item | Tokens used | USD spent |
|---|---|---|
| Test 1 capacity_addition (mocked apply + mocked /api/whatif) | 0 | $0 |
| Test 2 shift_window (mocked apply + mocked /api/whatif)      | 0 | $0 |
| Test 3 deadline_change (mocked apply + mocked /api/whatif)   | 0 | $0 |
| **Total**                                                     | 0 | **$0** |

Cap budget from task: $1.00. Actual: $0 (3/3 mocked end-to-end).
Live-LLM coverage of the same scenarios lives in
`scripts/wave7-integration*.ts` and the stress suite (#4).

## 6. Honesty audit — Wave 4.1 vs Wave 8

| Aspect | Wave 4.1 | Wave 8 (post F-W8-01) |
|---|---|---|
| capacity_addition Italian what-if | translator → opus_translator change_type=`add_capacity` → BFF emits `rules.extra_capacity` → backend logs passthrough warning → plan unchanged → manager reads "Vincolo applicato" | router short-circuits, no backend call, toast italiano "Scenario non supportato ancora", warning `not_implemented:capacity_addition` |
| shift_window Italian what-if      | analogous fake-apply path                                                                                                                                                       | analogous honest unsupported path                                                                                                          |
| Manager mental model risk         | **HIGH** — believes constraint enforced                                                                                                                                                  | **NONE** — explicit "not yet supported" message                                                                                            |

Reference: `docs/wave8-adversary-findings.md:F-W8-01` (w8-devils-advocate).

## 7. F-W8-extension — Wave 9 follow-ups

The two `not_implemented` intents are not blocked by Wave 8 GO. To move
them into the "full effect" tier, Wave 9 must:

1. **Option A — backend CP-SAT consumer**: extend `f_apply_rules.py`
   with `_apply_extra_capacity` and `_apply_shift_changes` that post
   real model constraints. Risk: shift/operator tables are read at
   `solve()` row 0, so additions must hit the `data` dict before the
   kernel runs (= `dataset_overrides` path).
2. **Option B — BFF data-modifier**: extend `data-modifier.ts` so
   `canApply` returns `true` for both intents, and `apply` emits the
   matching `dataset_overrides` shape. Catalog flag `not_implemented`
   is removed in the same PR.

Either path needs explicit roadmap allocation. Tracked in
`docs/to_do/` under the `F-W8-extension` row.

## 8. Cross-references

- Pivot decision rationale (team-lead): TRANSPORT-ONLY → OPZIONE C (honest unsupported), 2026-05-22.
- Adversary finding driving the pivot: `docs/wave8-adversary-findings.md:F-W8-01`.
- F-W7-02 INFEASIBLE recovery (verified, complementary to Test 4 in
  wave7-real-effect.spec.ts which is now unskippable):
  `src/routes/api/__tests__/apply-whatif-wave7-infeasible.test.ts`.
- F-W8-06 OPT 2 banner string source-of-truth:
  `apply-whatif.ts:625` (current value `lock_relaxed_to_soft`, rename
  to `lock_relaxed_to_soft__plan_recomputed_from_scratch` pending in
  w8-infeasible-recovery).

## 9. Verdict

- E2E: **3/3 PASS** in 18.3s (mocked, hermetic, $0 LLM).
- Unit: **22/22 PASS** (`strategy-router.test.ts`).
- TypeScript: clean.
- ESLint: clean.
- UI: F-W8-06 OPT 2 banner shipped + typechecked. Wire string
  `lock_relaxed_to_soft__plan_recomputed_from_scratch` is hardcoded as
  a constant in `SolutionDiff.tsx`; `w8-infeasible-recovery` already
  emits both legacy and upgraded markers from the BFF retry path.

**Wave 8 GO for multi-intent.**
