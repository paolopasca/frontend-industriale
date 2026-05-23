# Wave 9 Adversary Findings

**Owner**: `w9-devils-advocate` (Opus, plan-mode read-only)
**Date**: 2026-05-23
**Branches under review**:
- `feat/wave7-real-effect` (frontend-industriale)
- `feat/wave9-backend-extensions` (daino-backend-definitivo)

**Methodology**: continuous adversary lens during Wave 9 — read diffs as teammates land them, build counter-examples for every "X works" claim, escalate CRITICAL/HIGH via SendMessage to the lead.

---

## F-W9-01 [CRITICAL]: BFF `strategy-router.ts` extra_capacity payload silently misclassified by backend → silent no-op in production

**Aggiunto**: 2026-05-23
**Owner finding**: w9-devils-advocate
**Severity**: CRITICAL
**Status**: OPEN
**File coinvolti**:
- `frontend-industriale/src/server/llm/strategy-router.ts:413-419`
- `daino-backend-definitivo/daino/templates/fjsp_constraints/f_apply_rules.py:_normalise_extra_capacity_entries`

**Repro steps**:
1. Strategy-router emits payload for `capacity_addition` intent:
   ```ts
   return { extra_capacity: { operators: 1, shift: 'serale' } };
   ```
2. Backend `_normalise_extra_capacity_entries({operators: 1, shift: 'serale'})` runs:
   - `"shift_id" in spec` → False
   - `"extra_operators" in spec` → False
   - Falls through to the **"Mapping shift_id → payload"** branch
   - Iterates dict items: `operators=1` becomes `shift_id='operators', extra_operators=1`; `shift='serale'` becomes `shift_id='shift', payload='serale'` (string, not dict — skipped)
3. Result: `[{'shift_id': 'operators', 'extra_operators': 1}]`
4. `_apply_extra_capacity` rejects with `extra_capacity_skipped: unknown_shift_id='operators'`.

Verified live:
```python
>>> _normalise_extra_capacity_entries({'operators': 1, 'shift': 'serale'})
[{'shift_id': 'operators', 'extra_operators': 1}]
```

**Expected vs actual**:
- Expected: backend adds 1 virtual operator to shift `serale` (matching the BFF's intent).
- Actual: silent no-op — logged as `extra_capacity_skipped` with `reason='unknown_shift_id'`, schedule unchanged, manager sees "Vincolo applicato" toast.

**Why this is exactly F-W8-09 redux**:
- Wave 7 hard-lock was silent because frontend emitted `seq=0` but backend wanted `seq=1`. The off-by-one was a key-naming gap.
- Wave 9 extra_capacity is silent because frontend emits `operators/shift` but backend expects `shift_id/extra_operators` OR a `{shift_id: count}` mapping. Same key-naming gap pattern.
- Both pass type checks (everything is `dict`). Both surface only via `*_skipped` log entries.
- F-W4.1/F-W7/F-W8 review cycles did NOT catch this; the new Wave 9 backend test (`test_extra_capacity_adds_virtual_operator`) uses the canonical `{shift_id, extra_operators}` shape, never the BFF's actual `{operators, shift}` shape.

**Raccomandazione**:
Option A (backend): extend `_normalise_extra_capacity_entries` to recognise `{operators, shift}` as a shorthand:
```python
if "shift_id" in spec or "extra_operators" in spec or "operators" in spec:
    entry = dict(spec)
    entry.setdefault("shift_id", entry.get("shift") or entry.get("turno"))
    return [entry]
```
Option B (BFF): change `strategy-router.ts:413-419` to emit `{shift_id, extra_operators}`:
```ts
case 'extra_capacity': {
  const ec: Record<string, unknown> = {};
  if (normalised.operators !== undefined) ec.extra_operators = normalised.operators;
  if (normalised.shift !== undefined) ec.shift_id = normalised.shift;
  ...
}
```
**Pick B**: it's the wire-contract canonicalisation. Backend already accepts both keys at `_apply_extra_capacity` level (`shift_id or turno or shift`), but `_normalise_*_entries` is the silent funnel where the mapping vs single-entry decision is made — that's where the bug lives.

Add a unit test that uses the BFF's exact output shape (`{operators, shift}`) and asserts `extra_capacity_added`, not `extra_capacity_skipped`.

---

## F-W9-02 [HIGH]: T3 `frozen_lock_mode='hint'` retry NOT wired — banner emits wrong copy in production

**Aggiunto**: 2026-05-23
**Owner finding**: w9-devils-advocate
**Severity**: HIGH
**Status**: OPEN
**File coinvolti**:
- `frontend-industriale/src/routes/api/apply-whatif.ts:710-733`
- `frontend-industriale/src/lib/api.ts` (parameter added but never used)
- `frontend-industriale/src/components/dashboard/SolutionDiff.tsx:HINT_PRESERVED_WARNING` (constant defined but never emitted)

**Repro steps**:
1. Manager submits a what-if that produces hard-lock INFEASIBLE.
2. BFF `apply-whatif.ts:710` retries `resolveTemplate(..., [], datasetOverrides)`:
   - `frozenPhases=[]` (Opt 2 fallback, NOT Wave 9 Opt 1)
   - `frozenLockMode` argument omitted (defaults to undefined → backend defaults to `'hard'`)
3. Solve runs with NO frozen phases and hard mode → full recompute.
4. BFF emits warnings `['lock_relaxed_to_soft', 'lock_relaxed_to_soft__plan_recomputed_from_scratch']`.
5. SolutionDiff renders **RED banner** ("piano ricalcolato da zero") instead of amber "preservato come hint".

**Expected vs actual**:
- Per Wave 9 plan and `feature_gaps.md:#backend-frozen-lock-mode-hint` step 4: retry should use `frozenPhases (NON vuoto) + frozen_lock_mode: 'hint'`.
- Actual: BFF code unchanged at the retry point. `api.ts` HAS the `frozenLockMode?: FrozenLockMode` parameter wired through to the body, but the caller at line 710 does NOT supply it.

**Cross-layer evidence the wiring was prepared then forgotten**:
- `api.ts:260` defines `export type FrozenLockMode = 'hard' | 'hint';`
- `api.ts:285-291` only forwards the field when defined.
- `SolutionDiff.tsx` declares `HINT_PRESERVED_WARNING = 'lock_relaxed_to_soft__consolidated_preserved_as_hint'`, splits to `hintPreservedFromWarning` flag, and conditionally renders the amber-with-hint copy.
- `apply-whatif.ts:678-690` comment explicitly says: *"Once the backend grows the hint mode, swap the `[]` for `frozenPhases` and add `frozen_lock_mode: 'hint'` to the call."* — but the swap was not made even though T2 shipped the backend kwarg.

**Production blast radius**:
- e2e test #5 in `wave9-extensions.spec.ts:635-733` passes because the mock at line 221 hooks the apply-whatif endpoint and supplies the expected warnings directly — it does NOT exercise the actual BFF code path.
- Live runtime: every INFEASIBLE recovery still recomputes the plan from scratch. Red banner. Promised UX downgrade ("consolidated preserved as hint") is invisible.

**Raccomandazione**:
1. `apply-whatif.ts:710-718` — change:
   ```ts
   const relaxedResult = await raceWithTimeout(
     resolveTemplate(
       input.slug, problemType, rulesForSolve, cutoffMin,
       frozenPhases,                  // ← NOT [] anymore
       datasetOverrides,
       'hint',                        // ← Wave 9 Opt 1
     ),
   );
   ```
2. `apply-whatif.ts:728-732` — change warnings:
   ```ts
   warnings: [
     'lock_relaxed_to_soft',
     'lock_relaxed_to_soft__consolidated_preserved_as_hint',  // ← replace _plan_recomputed_from_scratch
     ...(relaxedResult.warnings ?? []),
   ],
   ```
3. Add a `apply-whatif` integration test (not e2e) that mocks the backend response stream and verifies the retry call carries `frozen_lock_mode: 'hint'` in its body, not the absence of the field.

---

## F-W9-03 [HIGH]: Catalog still flags `capacity_addition` + `shift_window` as `not_implemented: true` — backend T1 code unreachable in production

**Aggiunto**: 2026-05-23
**Owner finding**: w9-devils-advocate (corroborates D-W9-T4-01 from `wave9-test-report.md`)
**Severity**: HIGH
**Status**: OPEN
**File coinvolti**:
- `frontend-industriale/src/server/llm/catalog/constraint-catalog.yaml:108-153`

**Repro steps**:
1. T1 (`w9-backend-rules-consumer`) shipped `_apply_extra_capacity` and `_apply_shift_changes`.
2. T4 (`w9-tester`) ran 30 stress mock cycles → verdict: `NO-GO`. All 12 cycles for `capacity_addition` and `shift_window` fail (`expected_type_present: 0/12`).
3. Root cause: `constraint-catalog.yaml:116` and `:153` still declare `not_implemented: true`. The strategy-router (`strategy-router.ts`) short-circuits these intents to `aborted_unsupported` BEFORE they reach Strategy B.
4. Manager utterance "Aggiungi un operatore mercoledì serale" → `intent_parsed: capacity_addition` → router returns `aborted_unsupported` → backend never receives the payload → T1 backend code is dead code in production.

**Expected vs actual**:
- T1 task description (`docs/to_do/feature_gaps.md:#fjsp-capacity-shift-consumers-missing`) explicitly requires "estendere `f_apply_rules.py` con 2 consumer veri".
- T4 stress mock expects "Wave 9 NEW intents 12/12 delta KPI != 0" → 0/12.
- Catalog flag was NOT flipped by any teammate. T1 owner focused on the backend file only; T3 owner focused on the BFF retry + low-confidence + gg-default but not on the catalog.

**Raccomandazione**:
1. Edit `constraint-catalog.yaml`:
   - line 116: remove `not_implemented: true` for `capacity_addition`
   - line 153: remove `not_implemented: true` for `shift_window`
2. Re-run `npx tsx scripts/wave9-stress-mock.ts` to confirm verdict flips to GO.
3. Decide owner: T1 is the natural owner (backend consumer is theirs); the catalog flip is the "BFF visible bit" of T1's work. If T1 declines, T3 owns it.

**Risk if not fixed**: Wave 9 is unshippable. The whole point of T1 was to make `capacity_addition` and `shift_window` work end-to-end; with the catalog still gating, the manager experience is identical to Wave 8.

---

## F-W9-04 [MED]: T3 low_confidence_warning emitted even when intent_id='unknown' → wasteful Opus cascade

**Aggiunto**: 2026-05-23
**Owner finding**: w9-devils-advocate
**Severity**: MED
**Status**: OPEN
**File coinvolti**:
- `frontend-industriale/src/routes/api/apply-whatif.ts:442-452`

**Repro steps**:
1. Haiku returns `{intent_id: 'unknown', confidence: 'low', fallback_reasoning: 'asdf qwerty'}` for a typo utterance.
2. BFF `apply-whatif.ts:442-452` (Wave 9 addition) pushes `low_confidence_classification` into `wave7Warnings`.
3. BFF `apply-whatif.ts:467-490` short-circuit check (`unknown + high`) does NOT fire because confidence is `low`, NOT `high`.
4. Cascade continues → Opus translator runs (`$0.20`) → likely also returns `unsupported` → wasteful spend.
5. SolutionDiff banner: yellow "Classificazione a bassa confidenza" appears, but the manager also sees an `aborted_unsupported` event downstream → the banner is misleading because the constraint was NOT applied.

**Expected vs actual**:
- Per T3 ticket: warning should fire when "the intent is one of the 5 catalog ids but the classifier needed multiple assumptions". The `unknown + low` case is NOT one of the catalog ids.
- Actual: warning fires on `unknown + low` too. The banner copy ("verifica che il risultato corrisponda alla tua intenzione") is nonsensical when no result was produced.

**Raccomandazione**:
Tighten the guard at `apply-whatif.ts:442`:
```ts
if (parsed.intent.confidence === 'low' && parsed.intent.intent_id !== 'unknown') {
  wave7Warnings.push('low_confidence_classification');
  ...
}
```
Add unit test in `apply-whatif-low-confidence.test.ts` for the `unknown + low` case: warning MUST NOT fire; cascade still goes to Opus translator.

---

## F-W9-05 [MED]: `extra_capacity` validator rejects `0` and negative counts silently — manager sees no feedback

**Aggiunto**: 2026-05-23
**Owner finding**: w9-devils-advocate
**Severity**: MED
**Status**: OPEN
**File coinvolti**:
- `daino-backend-definitivo/daino/templates/fjsp_constraints/f_apply_rules.py:_apply_extra_capacity`

**Repro steps**:
1. Haiku/Opus parses manager utterance "Aggiungi 0 operatori" or a numerical typo → `{extra_capacity: {shift_id: 'mattina', extra_operators: 0}}`.
2. Backend logs `extra_capacity_skipped: reason='invalid_extra_operators', value=0`.
3. BFF `apply-whatif.ts:773-774` computes `modifiedCount=0, skippedRulesCount=1`.
4. SolutionDiff renders `skipped_rules_count: 1` chip — but the manager sees no specific message about why their command was dropped.

**Expected vs actual**:
- Expected: a structured BFF warning like `extra_capacity_invalid_count` so the UI can show "Hai chiesto 0 operatori — comando ignorato".
- Actual: only the generic skipped count, no actionable feedback.

**Why this is dangerous in production**:
- A `0` or negative value can come from Haiku parsing errors (e.g. "Togli 1 operatore" might be parsed as negative add).
- Manager sees green "Vincolo applicato" toast in the chat panel, sees `skipped_rules_count: 1` in SolutionDiff. The two messages contradict each other.

**Raccomandazione**:
In `apply-whatif.ts:773`, when `applyRules` contains entries with `reason: 'invalid_extra_operators'` or `reason: 'invalid_range'`, push a structured warning into `wave7Warnings` like `extra_capacity_invalid_count:0` so SolutionDiff can render a per-issue banner.

OR (cheaper option): the strategy-router should sanity-check the entity values BEFORE forwarding to the backend (reject `extra_operators <= 0` at routing time with a clean `unsupported` reason).

---

## F-W9-06 [LOW]: `extra_capacity` validator silently rejects when `operatori` is empty even though user clearly wants operators added

**Aggiunto**: 2026-05-23
**Owner finding**: w9-devils-advocate
**Severity**: LOW
**Status**: OPEN
**File coinvolti**:
- `daino-backend-definitivo/daino/template_solve.py:747` (`Rules/data mismatch` validator)
- `daino-backend-definitivo/daino/templates/fjsp_constraints/f_apply_rules.py:apply_rules_to_data`

**Repro steps**:
1. Dataset has `data["operatori"] = []` (rare but possible: small business loading minimal data).
2. Manager: "Aggiungi 2 operatori al turno mattina" → backend receives `{extra_capacity: {shift_id: 'mattina', extra_operators: 2}}`.
3. `template_solve.py:741-763` runs FIRST, rejects with `INVALID_INPUT: dual_resource ma operatori vuoto`.
4. `apply_rules_to_data` never runs. The 2 virtual operators are never added.

**Expected vs actual**:
- Manager intent was unambiguous: add operators.
- Actual: validator rejects before the rule consumer can fix the dataset.

**Raccomandazione**:
- Order swap: run `apply_rules_to_data` BEFORE the dual_resource validator (one solution).
- OR add a special-case in the validator: if `rules.get("extra_capacity")` is non-empty AND the consumer adds at least 1 operator, allow the solve to proceed.

**Risk if not fixed**: edge case, low frequency. Document and skip if no real customer hits it.

---

## F-W9-07 [LOW]: Test ordering / global state — first f_apply_rules pytest run after fresh `import fjsp` returned MODEL_INVALID; reproduces flakily

**Aggiunto**: 2026-05-23
**Owner finding**: w9-devils-advocate
**Severity**: LOW
**Status**: OPEN (under observation)
**File coinvolti**:
- `daino-backend-definitivo/tests/test_frozen_lock_mode.py` (intermittent)
- `daino-backend-definitivo/daino/templates/fjsp.py` (suspected global-state interference)

**Repro steps**:
1. First run: `pytest tests/test_fjsp_apply_rules.py tests/test_frozen_lock_mode.py` → `test_frozen_lock_mode_hint_allows_relaxation_when_infeasible` and `..._hint_prefers_consolidated_when_feasible` FAIL with `MODEL_INVALID`.
2. Subsequent runs (same command) → all 13 tests PASS.
3. Isolated run: `pytest tests/test_frozen_lock_mode.py::test_frozen_lock_mode_hint_prefers_consolidated_when_feasible` → PASS.

**Hypothesis**:
- Pytest-level state contamination via `_diag_logger` module-level state.
- Could be related to `tempfile` reuse / json caching / `_find_table_*` global lookup cache.

**Expected vs actual**:
- Expected: tests pass deterministically regardless of order.
- Actual: tests are order-dependent on first run only (probably due to a one-time bootstrap side-effect in the fjsp solve module).

**Raccomandazione**:
- Add `--randomly-seed=20260523 --randomly-dont-shuffle-modules` (pytest-randomly) to confirm the flake's order-dependence.
- If reproducible, hunt down the leaking global. Else mark as monitored and move on — does NOT block ship since CI re-runs with cached imports.

---

## F-W9-08 [MED]: e2e test #5 (`frozen_lock_mode=hint preserves consolidated softly`) is a tautology — verifies the mock, not the BFF code

**Aggiunto**: 2026-05-23
**Owner finding**: w9-devils-advocate
**Severity**: MED
**Status**: OPEN
**File coinvolti**:
- `frontend-industriale/tests/e2e/wave9-extensions.spec.ts:635-733` (test 5)
- `frontend-industriale/tests/e2e/wave9-extensions.spec.ts:153-229` (`setupWave9ApplyMock`)

**Repro steps**:
1. Test 5 calls `setupWave9ApplyMock(page, { warnings: ['lock_relaxed_to_soft', 'lock_relaxed_to_soft__consolidated_preserved_as_hint'], ... })`.
2. The mock at line 221 hooks the route `/api/apply-whatif` and replies with a pre-built SSE stream that contains the expected warnings.
3. The actual `apply-whatif.ts` BFF code is BYPASSED entirely (the mock returns before SvelteKit reaches the handler).
4. UI consumes the SSE, renders the banner with `data-testid=solution-diff-hint-preserved-banner`. Test passes.
5. But: the real BFF code (`apply-whatif.ts:710-733`) STILL emits `lock_relaxed_to_soft__plan_recomputed_from_scratch`, NOT `__consolidated_preserved_as_hint` (see F-W9-02). The mock is testing a future contract that the BFF doesn't implement.

**Expected vs actual**:
- Expected: e2e test should fail until F-W9-02 is closed.
- Actual: e2e test passes because the mock provides the expected output directly.

**Raccomandazione**:
Add an additional assertion in test 5 that the mock's `getPostBody()` captured a request payload containing `frozen_lock_mode: 'hint'`. This way the test fails when the BFF doesn't actually request hint mode from the backend.

Alternative: add a separate INTEGRATION test (not e2e) for `apply-whatif.ts` that mocks only the backend response (not the apply-whatif route itself) and verifies the BFF code path emits the right warning. See `apply-whatif-low-confidence.test.ts` for the pattern.

---

## Summary table

| ID | Severity | Status | Owner | Title |
|---|---|---|---|---|
| F-W9-01 | CRITICAL | OPEN | T1 + T3 (BFF) | extra_capacity payload silently misclassified — silent no-op |
| F-W9-02 | HIGH | OPEN | T3 (BFF) | frozen_lock_mode='hint' retry NOT wired |
| F-W9-03 | HIGH | OPEN | T1 (catalog) | Catalog still flags new intents not_implemented |
| F-W9-04 | MED | OPEN | T3 (BFF) | low_confidence warning fires on unknown intent → wasteful |
| F-W9-05 | MED | OPEN | T1+T3 | extra_capacity rejects 0/negative silently — manager confused |
| F-W9-06 | LOW | OPEN | T1 | Order: validator rejects before apply_rules_to_data can fix data |
| F-W9-07 | LOW | OPEN | T4 | Test ordering / flaky first run |
| F-W9-08 | MED | OPEN | T4 | e2e test #5 is a tautology (verifies the mock, not BFF code) |

## Pattern observation — same shape as Wave 8

Wave 8 closed F-W8-09 (off-by-one seq) only because adversary ran one curl. Wave 9 reproduces the same shape:
- **F-W9-01** is exactly the same class of bug: frontend↔backend wire-contract mismatch in dict-key naming, silent on success path, surfaced only via `*_skipped` log entries.
- **F-W9-02 + F-W9-08** is a different shape: wiring exists everywhere EXCEPT at the call site; e2e mocks hide the fact in CI.

If F-W9-01 ships unfixed, the first B2B customer who says "Aggiungi un operatore mercoledì serale" sees green "Vincolo applicato" but the schedule is unchanged. **The whole point of T1 was to NOT have that happen.** This is exactly the "silent no-op for a customer scenario" pattern that F-W8-09 was about.

Pre-production gate: F-W9-01, F-W9-02, F-W9-03 must close before merge. F-W9-04, F-W9-05, F-W9-08 should close before launch.
