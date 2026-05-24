# Wave 10 Adversary Findings

**Owner**: `w10-devils-advocate` (Opus, plan-mode read-only)
**Date**: 2026-05-23
**Branches under review**:
- `feat/wave7-real-effect` (frontend-industriale) — local diff: `src/server/llm/strategy-router.ts`
  + new `src/server/llm/__tests__/strategy-router-extra-capacity-guard.test.ts`
- `feat/wave10-investigation` (daino-backend-definitivo) — local diff: `daino/template_solve.py`
  + new `tests/test_apply_rules_order.py`

**Methodology**: continuous adversary lens during Wave 10 — read diffs as teammates land them, build counter-examples for every "X works" claim, escalate CRITICAL/HIGH via SendMessage to the lead. Following the canonised pattern from ADR-097.5 / ADR-098.7: silent no-op + wire-contract gap + mock-tautology + stale module cache + false alarm.

Companion to `daino-backend-definitivo/docs/wave10-adversary-findings.md` (T1's H1-H6 investigation).

---

## F-W10-01 [HIGH]: T4 fix lets `extra_capacity` silently no-op when caller doesn't pre-set `f06_enabled` / `dual_resource`

**Aggiunto**: 2026-05-23
**Owner finding**: w10-devils-advocate
**Severity**: HIGH
**Status**: OPEN
**File coinvolti**:
- `daino-backend-definitivo/daino/template_solve.py:751-758` (T4 uncommitted bypass)
- `daino-backend-definitivo/daino/templates/fjsp.py:539-568` (`_auto_enable_data_implied_rules` order vs `apply_rules_to_data`)
- `daino-backend-definitivo/daino/api/routes_optimize.py:2057-2064` (HTTP auto-enable from `data_json["operator_config"]`)

**Repro steps** (verified live):

```python
# Dataset that small business with empty staff would actually load:
data["operatori"] = []
data["operator_config"] = []   # empty list, not missing
data["shift_types"] = {"mattina": {"start": 0, "end": 480}}

# Rules that BFF computes from manager "Aggiungi 2 operatori turno mattina":
rules = {
    "f04_enabled": True,           # time_config present → auto-set
    "f06_enabled": False,          # operator_config empty → NOT auto-set
    "dual_resource": False,        # same reason
    "extra_capacity": {"shift_id": "mattina", "extra_operators": 2},
    # no explicit dual_resource flag from BFF
}
res = template_solve(data, rules, time_limit=15)
# Status: OPTIMAL
# wave7_apply_rules: [extra_capacity_added × 2]
# kpis.costo_totale_operatori: 0    ← silent no-op evidence
# operators in solution: NONE (f06 not built)
```

Wave 7 apply_rules log says "2 operators added" but the solver doesn't enforce them. Manager sees:
- toast: "Vincolo applicato"
- SolutionDiff: "modifiedCount=2" (from `apply_rules_log.extra_capacity_added`)
- KPI: identical to no-rule baseline because F06 module was never wired

**Expected vs actual**:
- Expected: rule with no real effect should either fail with a clear message, OR auto-enable F06 + dual_resource so the solver actually consumes the virtual operators.
- Actual: T4's bypass at `template_solve.py:758` (`and not has_extra_capacity`) lets the solve proceed; `apply_rules_to_data` mutates `data` to add virtual operators; but the `_auto_enable_data_implied_rules` call at `fjsp.py:539-547` already ran BEFORE `apply_rules_to_data` and saw empty `operatori` / `operator_config` → didn't flip `f06_enabled` / `dual_resource`. The virtual operators land in the data but the model module that would consume them never gets built.

**Why this is exactly F-W9-01 redux (silent no-op)**:
- F-W9-01: backend received correct-shape payload but classifier funnel routed it wrong.
- F-W10-01: backend receives correct-shape payload, T4's bypass lets it through the validator gate, the consumer `apply_rules_to_data` mutates data — but the auto-enable ordering means the consumer's effect is structurally invisible to the solver.

**Why T4's test doesn't catch this**: `tests/test_apply_rules_order.py:73-86` (`_dual_resource_rules`) explicitly sets `dual_resource=True, f06_enabled=True` in the rules. That's the "happy path" — the bug is the "BFF didn't set those because the dataset is empty" path.

**Raccomandazione**:
Order swap in `daino/templates/fjsp.py`:
```python
# Currently: line ~539 auto-enable, line ~553 apply_rules_to_data
# Swap to: apply_rules_to_data FIRST (mutates data["operatori"] / data["operator_config"]),
# THEN _auto_enable_data_implied_rules (sees the now-populated tables and flips f06/dual_resource).
```
Add a regression test in `tests/test_apply_rules_order.py`:
```python
def test_extra_capacity_on_dataset_without_dual_resource_flags_still_takes_effect():
    """The bypass must not just silence the validator — the virtual
    operators must actually constrain the schedule. Verify costo_totale_operatori > 0."""
    data = _empty_operatori_dataset()
    rules = {
        "sdst_enabled": False,
        "include_start_setup": False,
        "extra_capacity": {"shift_id": "mattina", "extra_operators": 2},
        # NO dual_resource, NO f06_enabled — exactly what BFF emits.
    }
    res = template_solve(data, rules, time_limit=15, problem_type="fjsp")
    assert res["status"] in ("OPTIMAL", "FEASIBLE")
    kpis = res["kpis"]
    assert kpis.get("costo_totale_operatori", 0) > 0, (
        "extra_capacity must actually constrain ops to virtual operators; "
        f"got costo_totale_operatori={kpis.get('costo_totale_operatori')}"
    )
```

**Production blast radius**: Every B2B customer who signs up + loads a dataset without `operator_config` populated upfront (smaller plants, demo phase, "Aggiungi staff dopo") and then does "Aggiungi N operatori" will see the rule applied in the audit but zero real schedule change. This is exactly the failure mode F-W8-09 was meant to canonise out of existence.

---

## F-W10-02 [MED]: T2's `invalid_extra_capacity_count` reason string has no UI mapping → raw debug string in user toast

**Aggiunto**: 2026-05-23
**Owner finding**: w10-devils-advocate
**Severity**: MED
**Status**: OPEN
**File coinvolti**:
- `frontend-industriale/src/server/llm/strategy-router.ts:551`
- `frontend-industriale/src/components/dashboard/WhatIfAnalysis.tsx:382-386`

**Repro steps**:
1. Manager: "Aggiungi 0 operatori al turno mattina" (or omits the count).
2. Haiku parses `{intent_id: 'capacity_addition', entities: {operators: 0, shift: 'mattina'}, confidence: 'high'}`.
3. `strategy-router.ts:540-554` (T2 guard) fires `unsupported` with `reason = 'invalid_extra_capacity_count:operators_must_be_positive_integer:got=0'`.
4. `apply-whatif.ts:567-572` emits `aborted_unsupported` with that raw string.
5. `WhatIfAnalysis.tsx:385` renders: `toast.warning('Scenario non applicabile: invalid_extra_capacity_count:operators_must_be_positive_integer:got=0')`.

**Expected vs actual**:
- Expected: friendly Italian copy ("Hai chiesto 0 operatori — comando ignorato. Vuoi riprovare con un numero positivo?").
- Actual: raw debug string surfaces to the manager. Looks like an unhandled error.

**Raccomandazione**:
Either:
- (a) Translate the reason at the BFF before sending to the UI (in `apply-whatif.ts` at the `unsupported` mapping site, or at the router edge).
- (b) Add a UI-layer mapping in `WhatIfAnalysis.tsx:382-386` for known reason prefixes, fallback to the raw string when unrecognised. Pattern:
  ```ts
  const REASON_COPY: Record<string, string> = {
    'invalid_extra_capacity_count': 'Numero operatori non valido — comando ignorato.',
    ...
  };
  const prefix = payload.reason.split(':')[0];
  toast.warning(`Scenario non applicabile: ${REASON_COPY[prefix] ?? payload.reason}`);
  ```

**Coordination**: this is a tiny cross-team fix; either T2 (BFF translation) or a frontend-only patch.

---

## F-W10-03 [LOW]: T2 guard tested only at unit level — no apply-whatif integration test pins the SSE `aborted_unsupported` contract

**Aggiunto**: 2026-05-23
**Owner finding**: w10-devils-advocate
**Severity**: LOW
**Status**: OPEN
**File coinvolti**:
- `frontend-industriale/src/server/llm/__tests__/strategy-router-extra-capacity-guard.test.ts` (T2 shipped this)
- MISSING: `frontend-industriale/src/routes/api/__tests__/apply-whatif-extra-capacity-guard.test.ts`

**Repro steps**: N/A — gap is "no test exists" not a runtime defect.

**Expected vs actual**:
- Pattern of reference for integration tests: `apply-whatif-low-confidence.test.ts` (Wave 9 T3 added it as the integration counterpart to a router-level emit). T2 has the parallel router-level emit (`unsupported` for invalid count) but the integration-level counterpart is missing.

**Why it matters**:
- F-W9-08 pattern: e2e mocked the whole route and verified the mock, missing real BFF code drift. Here, T2's router emit lands in `apply-whatif.ts` at line 552-572 (`outcome.kind === 'unsupported'` → `aborted_unsupported`). A future change that moves the unsupported handling (e.g. swap to `aborted` or a different SSE event) breaks the contract silently because no end-to-end test asserts "`operators: 0` user utterance → SSE chunk with `event: aborted_unsupported` containing the reason".

**Raccomandazione**:
Add `apply-whatif-extra-capacity-guard.test.ts` mirroring the `apply-whatif-low-confidence.test.ts` shape:
```ts
it('operators=0 utterance → aborted_unsupported with invalid_extra_capacity_count reason', async () => {
  anthropicCreate.mockResolvedValueOnce(fakeHaikuReply({
    intent_id: 'capacity_addition',
    entities: { operators: 0, shift: 'mattina' },
    confidence: 'high',
  }));
  // no fetch mock needed — strategy-router short-circuits before solve-template
  const res = await invokeRoute(makeRequest({ ...baseBody, managerText: 'Aggiungi 0 operatori' }, '10.0.99.1'));
  const chunks = parseSse(await streamToString(res.body!));
  const aborted = chunks.find(c => c.event === 'aborted_unsupported');
  expect(aborted).toBeDefined();
  expect(aborted!.data.reason).toMatch(/invalid_extra_capacity_count/);
});
```

---

## F-W10-04 [MED]: T2 + catalog `positive_int` validator is mis-named — accepts `0` silently for ALL `positive_int` fields, not just `operators`

**Aggiunto**: 2026-05-23
**Owner finding**: w10-devils-advocate
**Severity**: MED
**Status**: OPEN
**File coinvolti**:
- `frontend-industriale/src/server/llm/strategy-router.ts:160-162` (`isPositiveInt`)
- `frontend-industriale/src/server/llm/catalog/constraint-catalog.yaml:29, 92, 122, 131, 163`

**Repro steps** (analysis):
```ts
function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}
```
The `>= 0` means `0` passes `isPositiveInt`. The function is documented and used as if it means "strictly positive" but accepts zero. T2's guard catches `operators: 0` AFTER validation passes — but the same problem exists silently for:
- `new_deadline_min: positive_int` (catalog line 92) — `new_deadline_min: 0` would mean "deadline at t=0", probably OK as start-of-horizon.
- `start_min: positive_int` (catalog line 29, 163) — `0` is legit (start of horizon).
- `duration_min: positive_int` (catalog line 131) — `0` is probably NOT legit but only used by data_modification path, not rule_addition guard.

**Expected vs actual**:
- The name `positive_int` implies strict positivity in math/Italian (`positivo > 0`). The actual semantic is "non-negative int" (`≥ 0`).
- For `operators` and `duration_min`, `0` is NOT a valid value but slips through. T2 added an ad-hoc guard for `operators` but `duration_min: 0` would still pass routing.

**Raccomandazione**: Option A: rename the validator + tighten the predicate:
```ts
function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;  // strictly
}
function isNonNegativeInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}
```
Update catalog entities to use the right validator: `operators: positive_int`, `start_min: non_negative_int`, etc. This makes the T2 ad-hoc guard redundant (the catalog validator catches `operators: 0` directly).

Option B (lower scope): leave catalog as-is, accept that T2's guard is the "real" gate for `operators`. Document this in the catalog YAML so a future contributor doesn't relax the guard.

**Coordination**: Option A is the principled fix; Option B is a paper trail.

---

## F-W10-05 [HIGH]: NEW SYSTEMIC PATTERN — solver schedules ops on virtual operators that the post-validator doesn't know about → silent constraint laundering

**Aggiunto**: 2026-05-23
**Owner finding**: w10-devils-advocate
**Severity**: HIGH
**Status**: OPEN
**File coinvolti**:
- `daino-backend-definitivo/daino/solution_validator.py:258` (`if f06 and wid and wid != "NONE" and wid in operator_config:`)
- companion to T1's H5 in `daino-backend-definitivo/docs/wave10-adversary-findings.md`

**Repro steps** (verified live):
```python
data = {
    "operatori": [{"operatore_id": "OP-existing", "costo_eur_min": 1}],
    "operator_config": [{"operatore_id": "OP-existing", "turno": "pomeriggio",
                         "macchine": ["M01"]}],
    "shift_types": {"mattina": {"start": 0, "end": 240},
                    "pomeriggio": {"start": 240, "end": 480}},
    "time_config": {"machine_windows": {"M01": {"start": 0, "end": 240}}, ...},
    ...
}
rules = {
    "dual_resource": True, "f04_enabled": True, "f06_enabled": True,
    "extra_capacity": {"shift_id": "mattina", "extra_operators": 1},
}
res = template_solve(data, rules, ...)
# Status: OPTIMAL
# Solution: COM-001 OP scheduled on M01, operator='W7_EXTRA_mattina_1'
# Validator violations: []
```

The kernel ran `apply_rules_to_data` which added `W7_EXTRA_mattina_1` to the in-kernel `data["operator_config"]`. Solver assigned ops to it. Post-validator runs on the CALLER's `data` which still has only `OP-existing` → validator skips `W7_EXTRA_mattina_1` because `wid not in operator_config` short-circuits the F06 check.

**Expected vs actual**:
- Expected: validator should treat unknown operators in the solution as a violation (the solver invented an operator nobody approved).
- Actual: validator silently passes any operator that isn't in its known set. This is the *same* root cause as T1's H5 — caller's `data` is stale relative to kernel's `data` — but it ALSO masks bona fide solver bugs (e.g. a solver that assigns a non-existent worker for any other reason).

**Why this is dangerous in production**:
1. T1's fix Option C (snapshot kernel mutations) closes the shift_changes regression but ALSO requires the validator to gain a "unknown_operator" violation type. Otherwise: even after T1's fix, IF a future kernel change (or LLM-generated custom_constraint) emits a worker name not in the snapshot, the validator still silently accepts.
2. Counter-example beyond F-W9-11: imagine a regression in `_apply_extra_capacity` that picks the wrong `shift_id` due to alias resolution gone wrong → operators added to `pomeriggio` but solver assigns ops at `mattina`. Validator should catch but doesn't.

**Raccomandazione**:
After T1's Option C lands, harden the validator to ALSO emit a violation for unknown workers:
```python
# In solution_validator.py:258 area
if f06 and wid and wid != "NONE":
    if wid not in operator_config:
        violations.append(
            f"F06c {jid}: solver assigned unknown operator {wid!r} "
            f"(known: {sorted(operator_config.keys())})"
        )
    else:
        op = operator_config[wid]
        # ... existing checks
```
Pre-condition: T1's Option C populates `operator_config` with virtual operators before the validator runs, so this check is *trustworthy* — it can distinguish "kernel-injected virtual operator" from "solver bug invented a worker".

---

## F-W10-06 [HIGH]: T1's H6 fix (`wave7_apply_rules` propagation on MODEL_INVALID branch) not yet committed → diagnostics still lost

**Aggiunto**: 2026-05-23
**Owner finding**: w10-devils-advocate (corroborates T1's H6 in `daino-backend-definitivo/docs/wave10-adversary-findings.md`)
**Severity**: HIGH
**Status**: OPEN
**File coinvolti**:
- `daino-backend-definitivo/daino/template_solve.py:1045-1056` (MODEL_INVALID wrapper)
- `daino-backend-definitivo/daino/template_solve.py:1103-1108` (OPTIMAL/FEASIBLE wrapper — has the fix)

**Repro steps**:
1. Send `shift_changes` payload via HTTP to a slug whose data has full column_mapping.
2. Kernel solves, mutates `data["shift_types"]` in-process, populates `result["wave7_apply_rules"] = [shift_change_alias_resolved, shift_window_modified]`.
3. Post-validator runs against caller's stale data → F06b violations → flips status to MODEL_INVALID.
4. `_post_validate_and_wrap`'s MODEL_INVALID branch (line 1045-1056) builds `wrapped` WITHOUT copying `wave7_apply_rules`.
5. BFF receives status=MODEL_INVALID with `wave7.apply_rules=[]`.

**Expected vs actual**:
- Expected: same propagation block (`for _w7_key in (wave7_apply_rules, wave7_frozen_phases, wave7_locked_count): if _w7_key in result: wrapped[_w7_key] = result[_w7_key]`) as the OPTIMAL branch at 1103-1108.
- Actual: missing. Diagnostics about WHY the validator rejected (e.g. "shift_window_modified was applied → caller stale data") are silently dropped.

**Raccomandazione**:
Add the same `for _w7_key in (...)` block after line 1056 (before the `if company_slug` block). Mirror the OPTIMAL branch exactly. This is part of T1's pending H6 fix.

---

## F-W10-07 [MED]: BFF never sends `force_cold_start` → warm-start enabled by default; stale `last_plan.json` could feed bogus hints into apply-whatif retries

**Aggiunto**: 2026-05-23
**Owner finding**: w10-devils-advocate
**Severity**: MED
**Status**: OPEN
**File coinvolti**:
- `frontend-industriale/src/lib/api.ts:262-296` (`resolveTemplate` body shape)
- `daino-backend-definitivo/daino/api/routes_optimize.py:1921-1923` (backend default)
- `daino-backend-definitivo/daino/template_solve.py:788-814` (warm start loader)

**Repro steps** (analysis):
1. Frontend `resolveTemplate(...)` at `api.ts:271-294` builds a body with `{slug, problem_type, rules, cutoff_min?, frozen_phases?, dataset_overrides?, frozen_lock_mode?}`. **No `force_cold_start`** anywhere.
2. Backend `routes_optimize.py:1923` → `force_cs = bool(body.get("force_cold_start", False))` → `False`.
3. `use_ws_raw = body.get("use_warm_start") = None` → `use_ws = None`.
4. `template_solve` at line 788-814: `if company_slug and not force_cold_start` → True. `effective_use_warm_start = True` (because `use_warm_start is None` → auto-on).
5. `storage.load_latest_plan(company_slug)` loads the previous OPTIMAL/FEASIBLE plan and injects hints.

**Why this is dangerous for apply-whatif**:
- The previous "good" plan saved to `last_plan.json` was solved under the OLD rules (before the current manager utterance). When the manager says "Sposta deadline COM-007", the new solve hints toward the OLD schedule which might be infeasible under the new deadline → CP-SAT struggles or returns MODEL_INVALID more often.
- Wave 9 LANE 3 capacity_addition saw `Strategy C` cascade ($0.20/cycle) partly due to entity validation failures; if warm-start hints also point to a now-infeasible spot, debug time goes up.

**Production blast radius (B2B)**:
- First customer who runs 5-10 what-if rounds in a session: each one carries forward the previous plan's hints. Eventually, a degenerate scenario where the hint is materially wrong causes a long search or a spurious INFEASIBLE.

**Raccomandazione**:
Option A (recommended for apply-whatif): default `force_cold_start: true` on the BFF retry path inside `apply-whatif.ts`, since the retry is meant to be a fresh attempt at a new constraint set, not warm-started from the now-stale baseline.
```ts
// In resolveTemplate(...), add an optional forceColdStart param:
if (forceColdStart) body.force_cold_start = true;
```
Then `apply-whatif.ts` passes `forceColdStart: true` to both the first and retry calls.

Option B: leave warm-start on but track its effect — emit `warm_start.used` from the solve result to the SSE so the UI/BFF can verify the hint helped/hurt.

**Coordination**: needs frontend + backend alignment. Low-impact but pre-launch hardening.

---

## F-W10-08 [LOW]: T1's planned `tests/test_solve_template_http_vs_python.py` doesn't exist yet → no regression test for the HTTP/Python divergence

**Aggiunto**: 2026-05-23
**Owner finding**: w10-devils-advocate
**Severity**: LOW
**Status**: OPEN
**File coinvolti**:
- planned: `daino-backend-definitivo/tests/test_solve_template_http_vs_python.py`
- referenced: `daino-backend-definitivo/docs/wave10-adversary-findings.md:34, 102-103`

**Repro steps**: N/A — gap is "no test exists" per T1's own admission. T1 needs to write this before claiming F-W9-11 closed.

**Why it matters**:
- The current verification plan (T1's section "Verification plan", item 1-2) is curl-based. Curl tests are slow, hard to wire into CI, and brittle on dev machines. A pytest that hammers `/api/public/solve-template` via TestClient (or directly the route handler) and asserts shapes is the durable artifact.
- Without the test, "F-W9-11 closed" is only validated against one curl run on one machine. The next dev who refactors `_post_validate_and_wrap` could re-introduce the same staleness silently.

**Raccomandazione**: T1 should add the test before marking task #1 completed. Pattern of reference: `tests/test_routes_optimize.py` (if exists) or use FastAPI's `TestClient`:
```python
from fastapi.testclient import TestClient
from daino.api.routes_optimize import router
def test_http_shift_changes_matches_python_direct(...):
    # Setup company dir with column_mapping
    client = TestClient(app_with_router)
    res_http = client.post('/api/public/solve-template', json={
        'slug': 'test-slug', 'problem_type': 'fjsp',
        'rules': {'shift_changes': {'shift_id': 'mattina', 'start_min': 420}},
    })
    res_py = template_solve(data_with_mapping, rules_with_shift_changes, ...)
    assert res_http.json()['status'] == res_py['status']
    assert len(res_http.json()['wave7']['apply_rules']) == len(res_py.get('wave7_apply_rules', []))
```

---

## F-W10-09 [MED]: T3 e2e test #5 `getPostBody()` captures only the FIRST request — INFEASIBLE+retry scenarios miss the retry payload assertion at the e2e layer (mitigated by integration test, gap remains visible to future contributors)

**Aggiunto**: 2026-05-23
**Owner finding**: w10-devils-advocate (re-validates lead watch list bullet T3.❓1)
**Severity**: MED
**Status**: OPEN (informational — T3 already redirected the assertion to the integration test; documenting for future contributors)
**File coinvolti**:
- `frontend-industriale/tests/e2e/wave9-extensions.spec.ts:201-203` (mock handler stores only `postBody`)
- `frontend-industriale/tests/e2e/wave9-extensions.spec.ts:632-754` (test 5)
- (mitigation) `frontend-industriale/src/routes/api/__tests__/apply-whatif-retry-hint.test.ts`

**Repro steps** (analysis of T3's design):
1. Mock at line 201-203: `handler` overwrites `postBody = route.request().postData()` on every intercepted request.
2. If apply-whatif makes only ONE call (the SSE start from the UI), `postBody` is the only request and is captured.
3. The BFF retry to `/api/public/solve-template` is internal — never goes through this mock because the mock intercepts `**/api/apply-whatif`, not the backend endpoint.
4. So `getPostBody()` actually captures the manager's apply-whatif request, NOT the backend retry. Lead watch list's concern about "first vs second" is partially right in spirit (the assertion target was reframed) but the mock architecture means the BFF code never runs at all in the e2e.

**T3's mitigation**: integration test `apply-whatif-retry-hint.test.ts` mocks `fetch` (stubs the backend response) and verifies `fetchMock.mock.calls[1][1].body` for the retry. That's the correct layer.

**Remaining gap**:
- The e2e test has a comment at line 706-714 documenting the limitation. Good. But the comment doesn't link to the integration test (just names it: `apply-whatif-retry-hint.test.ts`). A future contributor who deletes the integration test (thinking "the e2e covers it") will silently de-cover the contract.

**Raccomandazione**:
1. Replace the comment at e2e line 706-714 with a hard link to the integration test file (relative path) so it appears in editor "go to definition" and prevents silent removal.
2. Add a Vitest comment in `apply-whatif-retry-hint.test.ts` describing its role as the BFF↔backend payload contract test (it has a docblock but could call out the "DO NOT delete — this is the only contract test for the BFF retry payload" warning).

---

## F-W10-10 [MED]: T5 (pytest flakiness) still in_progress with no shipped fix — flake could reappear in CI on first cold run

**Aggiunto**: 2026-05-23
**Owner finding**: w10-devils-advocate
**Severity**: MED
**Status**: OPEN
**File coinvolti**:
- `daino-backend-definitivo/tests/test_frozen_lock_mode.py`
- NO conftest.py at `tests/` level — only `tests/test_constraints/conftest.py`

**Repro steps** (attempted, not reproduced locally on 2026-05-23):
1. `cd daino-backend-definitivo && .venv/bin/python -m pytest tests/test_fjsp_apply_rules.py tests/test_frozen_lock_mode.py --tb=short` → 13/13 PASS, 0.5s.
2. F-W9-07 reported: first cold run after `import fjsp` returns MODEL_INVALID for tests 2 & 3 in `test_frozen_lock_mode.py`; subsequent runs PASS.
3. I attempted to repro by clearing `__pycache__/*.pyc` — still all passing.
4. `pytest-randomly` not installed → cannot run randomly seed.

**Expected vs actual**:
- Expected: deterministic green on cold run.
- Actual (per F-W9-07): non-deterministic green on cold run. Probably a one-time bootstrap effect (lazy module load, CP-SAT initial JIT, OS-level filesystem cache warmup).

**Why this matters for Wave 10**:
- CI runs from cold. If the flake fires on the first run and the suite stops there (without retry), Wave 10 PR ships rare red builds.
- Lead watch list: "Reset module state in autouse fixture potrebbe rompere altri test che ASSUMONO state. Verifica suite full." — exactly right. The fix must not break unrelated tests.

**Raccomandazione**:
1. Install `pytest-randomly` as a dev dep → `pyproject.toml` `[dependency-groups.dev]`.
2. T5 should run the full suite with `--randomly-seed=20260523 --randomly-dont-shuffle-modules` to characterise the flake order-dependence.
3. If the flake is reproducible, the fix candidate is to add a session-scoped autouse fixture in a NEW `tests/conftest.py` that pre-warms the fjsp module:
   ```python
   @pytest.fixture(scope="session", autouse=True)
   def _warmup_fjsp_module():
       from daino.templates import fjsp  # noqa: F401 — bootstrap import
       # No actual solve, just import to materialise lazy state
   ```
4. If unreproducible (likely if F-W9-07 was a one-off OS-level cache effect), T5 should mark F-W9-07 as "WONTFIX — under monitoring" with a clear breadcrumb in the test docstring.

---

## F-W10-11 [MED]: `_data_layer_already_applied` flag set even when `apply_rules_to_data` raises → silent skip of kernel retry

**Aggiunto**: 2026-05-23 (post-T4-fix review)
**Owner finding**: w10-devils-advocate
**Severity**: MED
**Status**: OPEN
**File coinvolti**:
- `daino-backend-definitivo/daino/template_solve.py:861-867` (T4's data-layer apply + flag set)
- `daino-backend-definitivo/daino/templates/fjsp.py:574-577` (kernel-side skip-if-flag)

**Repro steps** (analysis of T4's commit):
1. Caller passes `rules["extra_capacity"]` with a payload that triggers an exception in `apply_rules_to_data` (e.g. malformed entry, internal bug, transient I/O).
2. `template_solve.py:861-866` catches the exception, logs `apply_rules_to_data_failed`.
3. `template_solve.py:867` UNCONDITIONALLY sets `rules["_data_layer_already_applied"] = True` — outside the try/except.
4. Kernel receives the tempfile, fjsp.py:574 sees the flag is True, SKIPS its own `apply_rules_to_data` call.
5. Solver runs without virtual operators (or with stale shift_types).
6. Status may be OPTIMAL (if other ops can solve), MODEL_INVALID (if F06 fails), or INFEASIBLE.

**Expected vs actual**:
- Expected: when caller-side apply fails, the kernel should retry (its own try/except will catch failures defensively, log them, and continue without crashing).
- Actual: caller-side failure silently disables the kernel-side apply path. Manager may see "vincolo applicato" while the underlying mutation never happened.

**Raccomandazione**: move the flag-set INSIDE the try block:
```python
try:
    _data_layer_log = _w9_apply_data.apply_rules_to_data(data, rules)
    rules = {**rules, "_data_layer_already_applied": True}  # only on success
except Exception as exc:
    logger.exception("apply_rules_to_data raised — proceeding: %s", exc)
    _data_layer_log = [{"type": "apply_rules_to_data_failed", "error": str(exc)}]
    # leave flag unset → fjsp.py will retry the apply with its own try/except
```

**Coordination**: trivial fix; T4 (w10-backend-order) notified.

---

## Summary table

| ID | Severity | Status | Owner | Title |
|---|---|---|---|---|
| F-W10-01 | HIGH | **CLOSED** | T4 (backend) | T4 fix lets extra_capacity silently no-op (chicken-egg in `_auto_enable_data_implied_rules` — fixed) |
| F-W10-02 | MED | OPEN | T2 (BFF) / UI | T2 unsupported reason has no UI mapping → raw debug string in toast |
| F-W10-03 | LOW | OPEN | T2 (BFF) | T2 guard tested only at unit level — no apply-whatif integration test |
| F-W10-04 | MED | OPEN | Catalog | `positive_int` validator mis-named: accepts 0 silently for ALL positive_int fields |
| F-W10-05 | HIGH | OPEN | T1 (validator) | Validator silently accepts unknown operators in solution → systemic constraint laundering |
| F-W10-06 | HIGH | **CLOSED** | T1 (backend) | T1's H6 fix shipped at `template_solve.py:1086-1091` (MODEL_INVALID branch now propagates wave7_apply_rules) |
| F-W10-07 | MED | OPEN | Cross-team | BFF never sends force_cold_start → warm-start stale plans pollute apply-whatif retries |
| F-W10-08 | LOW | **CLOSED** | T1 | `tests/test_solve_template_http_vs_python.py` shipped with shift_changes / extra_capacity / combined scenarios |
| F-W10-09 | MED | OPEN | T3 | e2e test #5 getPostBody captures first req only; integration test mitigates but link is fragile |
| F-W10-10 | MED | OPEN (defense-in-depth) | T5 | Pytest flake fix shipped as conftest reset of daino.diag loggers; root cause not reproduced |
| F-W10-11 | MED | OPEN | T4 (backend) | `_data_layer_already_applied` flag set even when apply raises → silent skip on retry |

## Pattern observation — same shape as Wave 8 + Wave 9

Wave 8 closed F-W8-09 (off-by-one seq) only because adversary ran one curl. Wave 9 closed F-W9-09 (stale Python module cache) after the lead killed PID 75665. Wave 10 reproduces TWO of those shapes simultaneously:

- **F-W10-01** is silent no-op pattern (kernel does the work, but auto-enable ordering means the work is structurally invisible to the solver).
- **F-W10-05** is a CROSS-LAYER systemic risk: validator + kernel have different views of operator set → unknown_operator violations are silently absent. After T1 ships Option C, this validator hardening becomes possible AND necessary.
- **F-W10-06** is wire-contract drop (wave7_apply_rules silently absent on MODEL_INVALID path).

If F-W10-01, F-W10-05, F-W10-06 ship unfixed, the first B2B customer who says "Aggiungi 2 operatori turno mattina" on a dataset without operator_config will see:
- green toast "Vincolo applicato"
- SolutionDiff: "2 vincoli aggiunti"
- KPI: identical to no-rule baseline
- (and if the solver had a bug, the validator would silently pass it)

**Pre-launch gate**: F-W10-01, F-W10-05, F-W10-06 must close. F-W10-02, F-W10-07, F-W10-10 should close. F-W10-03, F-W10-04, F-W10-08, F-W10-09 should be tracked for post-launch hardening.
