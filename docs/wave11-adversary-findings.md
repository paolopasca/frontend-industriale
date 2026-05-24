# Wave 11 — Adversary findings (`w11-devils-advocate`)

**Owner agent**: `w11-devils-advocate` (Opus, plan-mode read-only)
**Lead**: `team-lead`
**Policy**: ADR-099.7 — review per teammate task UNA volta marked DONE (TaskUpdate completed), NON in real-time durante working tree edit. Mitigates Wave 9/10 false-alarm-da-snapshot-intermedio anti-pattern.
**Scope**: 4 teammate tasks (T1 backend validator, T2 UX polish bundle, T3 BFF/test bundle, T4 pytest flakiness deep dive). Watch list canonized in lead briefing.
**Stress frame**: "Se domani questo codice ship in pilota cliente B2B, cosa si rompe? Quali edge case manager realistici emergeranno?"

---

## Status legend
- **OPEN** — finding documented, not addressed by teammate.
- **OPEN (informational)** — gap visible to future contributors, but mitigated.
- **CLOSED** — verified fixed in working tree.
- **FALSE_ALARM** — investigated and the concern was already covered (Wave 9/10/11 lesson: investigate before escalating).

## Severity ladder
- **CRITICAL** — production data-loss or wrong-result risk; escalate to lead IMMEDIATELY via SendMessage.
- **HIGH** — silent constraint laundering, wire-contract gap, mock-tautology; escalate to lead via SendMessage.
- **MED** — UX papercut, missing defence-in-depth, weak test coverage that will bite within 1-2 waves.
- **LOW** — documentation gap, future-contributor footgun.

---

## Watch list (reproduced from lead briefing)

### T1 (w11-validator-fix) — F06 unknown_operator violation
- ❓ Schedule con `operator_id = None` o stringa vuota → edge case validation
- ❓ `operator_config` dict vuoto → tutti gli operatori scattano violation? Backward compat?
- ❓ `W7_EXTRA_*` virtual operators (REAL aggiunti da apply_rules) → must NOT scattare violation. Verify fix preserva quello.

### T2 (w11-ux-polish) — UI mapping + positive_int rename
- ❓ Nuove reasons al map → vecchi reasons non mappati restano raw → graceful fallback?
- ❓ Rename `positive_int` → `non_negative_int` → tutti gli usi del vecchio nome migrati (catalog YAML, validator funcs check)?
- ❓ Boundary: `operators: 1.5` → "non è intero" — chiaro al manager o ambiguo?

### T3 (w11-bff-polish) — force_cold_start + e2e retry
- ❓ Backend riceve `force_cold_start: true` ma `plan_memory` è in CRITICAL state (row count > limit) → crash? silent fail?
- ❓ E2e #5 `getPostBodies` array — primo INFEASIBLE, secondo retry. Se backend ritorna 3 chiamate (retry retry) → test si rompe?

### T4 (w11-pytest-investigator) — flakiness deep dive
- ❓ Se NON trova repro → defensive conftest da Wave 10 sufficient per CI? O still emergere flakiness in CI specifico (GitHub Actions runner specifico)?
- ❓ Se trova repro e fix real → defensive conftest è ridondante e va rimosso? Trade-off mantenibilità.

---

## Pattern noti da cacciare (Wave 4.1/7/8/9/10 retrospective)
- **Silent no-op** (ricorrente)
- **Wire-contract gap** (BFF↔backend dict key mismatch)
- **Mock-tautology** (F-W9-08 ricorrente)
- **False alarm da snapshot intermedio** (NEW pattern ADR-099.7 — applicare policy "review post-done", evitare di flaggare working tree mid-edit)

---

# Findings

_Populated as teammate tasks reach DONE; severity-ranked at the bottom._

(Nessun finding ancora — in attesa di task completion.)
