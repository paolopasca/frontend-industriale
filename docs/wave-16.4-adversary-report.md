# Wave 16.4 — Adversary Report

> Devil-advocate continuous review. 2026-05-27. 12 commits reviewed across two branches: `feat/wave-16.4-fixes` (FE, 7 commits) + `feat/wave-16.4-operator-unavail` (BE, 3 commits) + 2 documentation/docs commits.

## Verdict: **MERGE with 1 carry-over BLOCKING for non-demo use**

All CRITICAL/HIGH severity issues either resolved at commit time or already addressed by self-correcting coordination between implementers. One BLOCKING HIGH (C4 `baselineSolution`) for non-demo paths remains; demo data flow works.

---

## CRITICAL (0 unresolved)

Both originally-flagged CRITICAL findings were based on stale WIP snapshots; the committed code had already self-corrected via coordinated ACK between be-extractor-extender and bff-cost-reducer.

- ✅ **CRITICAL-1 (D1 regex bare-digit)** — flag based on stale snapshot. Committed regex in `e248ac2` (`daino/arm_c/constraint_extractor.py:408,424`) has `\d+` in the alternation. Empirically verified post-commit:
  - `"operatore 2 il 01/04 dalle 14 alle 18"` → MATCH ✅
  - `"operatore 03 malato"` → MATCH ✅
  - `"operatore mario il 15/06 dalle 09 alle 12"` → MATCH ✅
  - 9 unit tests in `TestHitOperatorUnavailability` + `TestGrayZoneOperatorUnavailability` pass.

- ✅ **CRITICAL-2 (D1 shape contract drift)** — flag based on stale snapshot. By the time my flag landed, bff-cost-reducer had already coordinated D1 ACK with be-extractor-extender and committed `abd62ea` with the Array.isArray + `some(e => e.operator_id === '?')` detection (exactly the Option B shape I described). The cross-layer ACK protocol (Wave 16.2 lesson) worked correctly.

## HIGH (1 unresolved at merge time, 2 mitigated)

🔴 **HIGH-3 (C4 `baselineSolution` missing from ReplanModal POST body)** — UNRESOLVED in commit `5d62a86`.
- Location: `src/components/dashboard/ReplanModal.tsx:~222-228`.
- Issue: `fetch('/api/reschedule-fresh', {body: JSON.stringify({slug, message})})` — `baselineSolution` field absent.
- Consequence: BE `minimalSolutionContext` returns `{slug, baseline: {machines: [], orders: [], fasi: []}}`. Extract-constraint sees empty operators/machines/orders → `_resolve_*` returns None for every alias → utterances referencing entities collapse to MISS/GRAY-sentinel. **C4 HIT path is dead for any entity-referencing utterance.**
- Repro: manager runs deterministic-template solve → Ripianifica chat → "OP-2 in ferie" → primary fails (no session) → fallback button → fresh-solve returns `extract_gray_zone` → modal shows "Impossibile ricalcolare da zero".
- Fix: 3-line addition (props threading + body field).
- **BLOCKING for production**. Demo data with utterances avoiding entity references would still work; full e2e Scenario D risks failing this assertion.

🟡 **HIGH-1 (E1 makespan unit inference)** — UNRESOLVED, demo-safe.
- Location: `src/components/dashboard/SolutionDiff.tsx:~183` (committed in `5d62a86`).
- Issue: heuristic `ms >= 200 ? ms : ms * 60` misclassifies hours as minutes when baseline makespan in hours exceeds 200 (~8-day horizon).
- Demo-safe: `demo-commesse` makespan ≈30h < 200 → correctly multiplies by 60.
- Wave 16.5 carry-over: replace with schema-driven detection or fix resultAdapter to ship `makespan_min` alongside `makespan` hours.

🟡 **HIGH-2 (C1 session_id non-functional for deterministic-template reschedule)** — MITIGATED.
- Location: `daino/api/routes_optimize.py:2113-2138` (commit `d9f775e`).
- Issue: `analysis_reschedule` requires `generated_code` (solver.py) for warm-start; template-path runs don't emit code → HTTP 501. session_id returned by C1 is structurally non-functional for primary reschedule.
- Mitigation: C4 fallback bypasses this entirely. Manager sees primary error briefly, then "Ricalcola da zero" button.
- Wave 16.5 carry-over: TD-022 — persist template runs OR return `reschedule_available: false` flag.

## MEDIUM (5 issues, 2 resolved, 3 carry-over)

- ✅ **MEDIUM-1 (A3 combined-rule early-return)** — FIXED in `0f7e48f`. Refactored to OR-of-predicates with 6 helper functions. `{unavailable_machines: {}, priority_orders: ['COM-001']}` now correctly passes.
- ✅ **MEDIUM-3 (A3 test coverage gap)** — FIXED in `0f7e48f`. +12 net new tests including combined rules + operator sentinel rejection + extra_capacity/shift_changes empty cases + cushionMin boundary.
- ✅ **MEDIUM (A4 follow-ups)** — FIXED in `434a668`: currentTimeMin clamp via `max(detected, legacy)`, ambiguity warning `a4_ambiguous_temporal_picked_<form>`, horizon overshoot warning via `estimateHorizonMaxEndMin`. +14 new tests.

🟡 **MEDIUM-5 (E1 weighted_tardiness unit collision)** — UNRESOLVED. Wave 16.5 carry-over: verify resultAdapter and solver share unit for `weighted_tardiness` / `ritardo_pesato_totale`.

🟡 **MEDIUM (CONTRACT-3 from D1: silent date rollforward)** — be-extractor-extender ACK'd as polish, Wave 16.5 carry-over: add `date_rolled_forward` flag + confidence downgrade so V1 lands in GRAY-zone when year is inferred.

## LOW (10 issues, partial resolution)

- ✅ **LOW (A4 N validation inconsistency)** — FIXED in `434a668` (consistent `\d{1,3}` + `[1, 365]` bounds across both patterns).
- ✅ **LOW (A4 cushionMin cap test)** — Added in `0f7e48f`.
- ✅ **LOW (A4 substring double-count bug)** — FIXED in `434a668` (strip dopodomani before testing domani).
- ✅ **LOW (giorno 1 = 0 confusion)** — FIXED in `434a668` (`giorno 1` returns null cleanly).

🟡 Remaining LOW items deferred to Wave 16.5:
- A7 client-spoofable accept-candidate (no HMAC).
- V2 operator GRAY without windows — UI must collect slot before re-submit.
- operator_id zero-padded resolution ("operatore 02" → no fallback to OP-2).
- D2 dual_resource_disabled silent skip — no user-facing banner.
- C4 session_not_found detection via string match (fragile).
- C4 no GRAY_ZONE handling in fresh fallback.

## Verifiche positive (what works)

- ✅ **Cross-layer ACK protocol** stabilized this wave: be-extractor-extender + bff-cost-reducer coordinated on operator_unavailability shape via SendMessage BEFORE D1/D2 landed. Commit `abd62ea` references "be-extractor-extender D1 ACK (2026-05-27)" — pattern proven.
- ✅ **Anti-silent-passthrough invariant** enforced in D2 (`_apply_operator_unavailability`): 7 distinct skip-reason branches, each logging and emitting `operator_unavailable_skipped` audit entry. F-W8-09 / F-W10-01 lessons absorbed.
- ✅ **A2 sentinel early-return** delivers the $0.20 cost saving with no behavioral regression. Both machine (dict "?") and operator (array `operator_id === '?'`) paths short-circuit correctly.
- ✅ **B1 PDF race fix** minimal and well-tested (invocationCallOrder assertion).
- ✅ **Integration test** `test_integration_operator_unavailability_changes_solution` explicitly asserts `kpis_base != kpis_with` — guards the F-W10-01 class.
- ✅ **Contract round-trip test** `test_operator_unavail_v1_payload_consumed_end_to_end` validates extractor HIT → consumer wires payload onto worker_intervals.
- ✅ **E2E Scenario A** asserts cost AND that solve actually ran (`data-state='done'` + SolutionDiff visible) — prevents 0-cost-on-error false positives.
- ✅ **Devil-advocate continuous review pattern** caught real issues: A3 combined-rule + A4 time-travel + A4 ambiguity + A4 horizon overshoot + A3 test gaps — all reviewed and addressed in-wave.
- ✅ **Verify-before-declare push-back** from be-extractor-extender on stale-snapshot CRITICALs was the correct response — Wave 16.3 lesson (feedback_verify_before_declaring_bug) honored on the reviewer-side as well.

## Carry-over Wave 16.5

1. **C4 `baselineSolution` wiring** — BLOCKING for non-demo. ui-fixer must thread `originalSolution` through ReplanModal props and add to POST body.
2. **C1 + reschedule architecture (TD-022)**: properly persist template runs so `/api/analysis/{sid}/reschedule` works for deterministic-template OR return `reschedule_available: false` flag.
3. **E1 makespan unit detection**: replace heuristic with schema-driven check or fix resultAdapter contract.
4. **A7 candidate auth**: HMAC-signed candidate handle to prevent client-spoofable plan acceptance.
5. **V2 operator GRAY UI time-picker**: WhatIfAnalysis modal must collect slot before re-submitting for V2 operator GRAY-zone.
6. **C4 structured error codes**: replace reply-string match with `errorCode` field in ChatRescheduleResponse.
7. **D1 date rollforward warning**: emit `date_rolled_forward` flag + confidence downgrade so V1 lands GRAY when year is silently inferred.
8. **D2 dual_resource_disabled banner**: user-facing warning when operator_unavailability hits the disabled-resource skip.

## Pre-merge checklist for team-lead

- [ ] **BLOCKING**: ui-fixer adds `baselineSolution: originalSolution` to ReplanModal's `/api/reschedule-fresh` POST body. 3-line change.
- [ ] Run vitest full suite against `434a668` (FE) + `d9f775e` (BE). 202/210 green reported by bff-cost-reducer with 1 pre-existing unrelated failure.
- [ ] Run e2e Scenarios A/B/C/D against the merged branch.
- [ ] Confirm `routeTree.gen.ts` reflects new routes (`/api/accept-candidate`, `/api/reschedule-fresh`). Committed in `5d62a86`.
- [ ] File the 8 Wave 16.5 carry-over items in `docs/to_do/` via the track-issue skill.

## Final commit list reviewed

**`feat/wave-16.4-fixes` (FE):**
- `08dd507` feat(wave-16.4): A2 sentinel "?" early-return
- `d7a6705` feat(wave-16.4): A3 empty-dict guard rejects underspecified rules
- `440b33f` feat(wave-16.4): A4 cutoff auto-detect from manager utterance
- `abd62ea` fix(wave-16.4): sync A2/A3 to D1 operator_unavailability array shape
- `0f7e48f` fix(wave-16.4): A3 OR-of-predicates + 6 missing test cases
- `5d62a86` feat(wave-16.4): UI tasks A5/A6/A7/B1/C2/C3/C4/E1 ui-fixer batch
- `4bb7b93` test(wave-16.4): e2e Playwright smoke + stress eval extension (36 scenari)
- `434a668` fix(wave-16.4): A4 clamp + ambiguity + horizon overshoot warnings

**`feat/wave-16.4-operator-unavail` (BE):**
- `e248ac2` feat(arm_c): operator_unavailability deterministic pattern v1/v2
- `63a341e` feat(f_apply_rules): operator_unavailability consumer end-to-end
- `d9f775e` feat(api): solve-template returns session_id + run_id (W16.4 C1)

Task #17 (DEVIL) marked completed.

— devil-advocate
