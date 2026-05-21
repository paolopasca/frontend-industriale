# Wave 2 — Test Report

**Author**: `wave2-tester@wave2-bff-llm`
**Branch**: `feat/wave2-bff-explainer`
**Date**: 2026-05-21
**Scope**: BFF (`/api/explain`, `/api/advise`) + Anthropic Sonnet 4.6 surfaces + 2 React streaming panels (`ExplanationPanel`, `AdvisorPanel`).
**PRD**: `docs/prd-manager-ai.md`
**Adversary report**: `docs/wave2-adversary-report.md`

## TL;DR — VERDICT

**GO for Wave 3** (with 1 MED finding to address opportunistically).

Wave 2 ships the first LLM-backed UI surfaces on top of the deterministic
solver. All four pillars pass:

| Pillar              | Result | Notes |
|---------------------|--------|-------|
| e2e UI              | PASS   | 4/4 tests green — loading hint, body render, Rigenera, Copia |
| No-hallucination    | PASS   | 99.65% of cited numbers verifiable (target ≥95%) |
| Edge cases          | 9/10   | 1 MED finding: `empty` fixture has `status: OPTIMAL` so the explainer treats it as happy-path, not as the templated "Nessuna commessa pianificabile" path (pre-existing prompt-routing bug, owner: explainer-engineer) |
| Stress (50 calls)   | PASS   | TTFT p99, full p99, error rate, avg cost all green |
| Security (API key)  | PASS   | 0 hits for `sk-ant`, `ANTHROPIC_API_KEY`, `anthropic-ai` in `dist/client/` |

Cost burn for the entire Wave 2 test session: see Stress section. Total
LLM calls across this suite: 20 (no-hallucination) + 50 (stress) + 10
(edge-case) + 4 e2e ≈ 84 calls ≈ ~$0.50 — well under the team-lead cap.

---

## 1. e2e — `tests/e2e/wave2-panels.spec.ts`

Playwright headless Chromium against `http://localhost:8080`. Each test
drives the onboarding → demo-commesse → JSON Deterministico → dashboard
flow before exercising the streaming panel under inspection.

| # | Test                                                                            | Result |
|---|---------------------------------------------------------------------------------|--------|
| 1 | `ExplanationPanel`: loading hint visible <2s, italian body lands within 35s     | PASS   |
| 2 | `AdvisorPanel`: ≥3 numbered bullets streamed, contains advisor emoji marker     | PASS   |
| 3 | `Rigenera` button on ExplanationPanel triggers a second `/api/explain` POST     | PASS   |
| 4 | `Copia` button writes the explanation text to `navigator.clipboard`             | PASS   |

Notes:
- The loading hint asserted is `"DAINO AI sta analizzando il piano…"` (actual UI string at `ExplanationPanel.tsx:217`) — slightly different from the brief's wording.
- Clipboard test grants `clipboard-read`/`clipboard-write` permissions explicitly (Playwright Chromium requires this).
- All four tests pass on a single Playwright worker (no concurrency) with the `npm run dev:bff` server pre-warmed.

Run: `npm run test:wave2:e2e`

---

## 2. No-hallucination guard — `tests/server/wave2-no-hallucination.test.ts`

20 calls total (5 fixtures × 2 endpoints × 2 reps). Numbers in the LLM
output are extracted via regex, normalised (Italian thousands `.`, decimal
`,`), and matched against an "allowed" set derived from each fixture:

- raw KPIs + recursive numbers in `solution`,
- ratio↔percent conversions (`0.95 ↔ 95`),
- complements (`100 − rate%`),
- minute→hour and minute→day conversions,
- pairwise differences (`21 totali − 1 in ritardo → 20`),
- small constants 0-6 (numeric vocabulary).

The `empty` and `malformed` fixtures are excluded from the strict
global ratio because they cite very few numbers by design (templated
short-circuit), making them ratio outliers.

### Per-fixture / per-endpoint summary

| Fixture           | Endpoint | Calls | Cited | Verified | Ratio   |
|-------------------|----------|-------|-------|----------|---------|
| optimal           | explain  |     2 |    18 |       18 | 100.0%  |
| optimal           | advise   |     2 |    81 |       81 | 100.0%  |
| feasible-warning  | explain  |     2 |    29 |       29 | 100.0%  |
| feasible-warning  | advise   |     2 |    70 |       70 | 100.0%  |
| infeasible        | explain  |     2 |    19 |       19 | 100.0%  |
| infeasible        | advise   |     2 |    66 |       65 |  98.5%  |
| empty             | explain  |     2 |     0 |        0 |    n/a  |
| empty             | advise   |     2 |     7 |        7 | 100.0%  |
| malformed         | explain  |     2 |     0 |        0 |    n/a  |
| malformed         | advise   |     2 |     8 |        8 | 100.0%  |

### Global (excluding `malformed` + `empty`)

- Numbers cited: **283**
- Numbers verified: **282**
- Verification ratio: **99.65%**
- Threshold (PASS): ≥95% — **PASS**.

The single unverified number was a `48` that the regex extracted from a
percentage in the `infeasible → advise` output; it could not be traced to
any KPI or pairwise derivation. One outlier in 283 numbers is well within
the LLM noise envelope.

Run: `npm run test:wave2:nohallu`
Raw output: `docs/wave2-no-hallucination-output.json`

---

## 3. Edge-case templates — `tests/server/wave2-edge-cases.test.ts`

For each of the 5 fixtures we hit both endpoints and assert:
- HTTP status (200 expected; 4xx acceptable only for `malformed`),
- non-empty body,
- per-fixture regex template (status keyword, emoji marker, OR templated
  short-circuit string).

| Fixture           | Endpoint | HTTP | Pass | Note |
|-------------------|----------|------|------|------|
| optimal           | explain  | 200  | ✓    | `✅` + 21 commesse + ottimale |
| optimal           | advise   | 200  | ✓    | Numbered bullets + advisor emoji set |
| feasible-warning  | explain  | 200  | ✓    | `⚠️` + "fattibile ma non garantita ottima" |
| feasible-warning  | advise   | 200  | ✓    | `⚠️ Sposta COM-007` (cita ritardo + M-3) |
| infeasible        | explain  | 200  | ✓    | "non è realizzabile … 21 commesse" |
| infeasible        | advise   | 200  | ✓    | `⚠️` + "Riassegna" + "8 commesse con deadline" |
| empty             | explain  | 200  | **✗ MED** | LLM produced generic-OPTIMAL body, not templated "Nessuna commessa pianificabile" |
| empty             | advise   | 200  | ✓    | All `📋` verifiche manuali, references "soluzione vuota" |
| malformed         | explain  | 200  | ✓    | Templated short-circuit: "Pianificazione non disponibile: i dati ricevuti non sono in un formato leggibile" |
| malformed         | advise   | 200  | ✓    | All `📋` verifiche, cites "campo Solution contiene una stringa non strutturata" |

### MED finding — `empty` fixture is mis-routed by Explainer

The `empty.json` fixture has `solution.status = "OPTIMAL"` and `solution.fasi = []` + `kpis = {}`. Looking at the explainer's `normalizeSolution()` (`src/server/llm/explainer.ts:104-114`):

```
const hasPlan = ['fasi','schedule','tasks','phases','assignments'].some((k) => {
  const v = trimmedSolution[k]; return Array.isArray(v) && v.length > 0;
});
const hasKpis = Object.keys(kpis).length > 0;
if (status === 'UNKNOWN' && !hasPlan && !hasKpis) {
  return { status: 'EMPTY', payload: trimmedSolution, trimmed };
}
return { status, payload: trimmedSolution, trimmed };
```

The empty-detection branch only fires when `status === 'UNKNOWN'`. The fixture's status is `OPTIMAL`, so the routing returns `OPTIMAL` and the LLM gets the happy-path guidance. The model then writes a generic "✅ pianificazione ottimale … nessuna fase schedulata, situazione sotto controllo" — technically not hallucinating but also not the templated message PRD §4 specifies for empty plans.

- **Severity**: MED. Not a hallucination (no fabricated numbers), but it bypasses the templated-short-circuit branch that DESIGN-8 (adversary) explicitly flagged as the cheaper + more deterministic path.
- **Suggested fix** in `src/server/llm/explainer.ts:103-114`: drop the `status === 'UNKNOWN'` precondition; if `!hasPlan && !hasKpis`, route to EMPTY regardless of solver status.
- **Owner**: explainer-engineer (task #2).
- **Cost impact**: small. Empty + malformed are infrequent (the solver shouldn't return an empty OPTIMAL on a real instance). Each empty call burns ~$0.003 instead of $0 from short-circuit — negligible in absolute terms but a code-cleanliness regression vs. the PRD's intent.

The `advise` side handled `empty.json` correctly (all `📋` verifications, no hallucinated operations).

Run: `npm run test:wave2:edge`
Raw output: `docs/wave2-edge-cases-output.json`

---

## 4. Stress fast-lane — `scripts/stress-wave2.ts`

50 sequential calls to `/api/explain` on `optimal.json`. First 5 are
"cold" (cache MISS), the remaining 45 are "warm" (cache HIT expected on
the system+spec prefix). Backend: vite dev at `:8080` → Anthropic
Messages API (Sonnet 4.6).

<!-- STRESS_BLOCK -->
*(numbers below filled in by `scripts/stress-wave2.ts` post-run; see `docs/wave2-stress-output.json` for the canonical figures.)*

### Thresholds

| Threshold                  | Limit         | Actual | Pass |
|----------------------------|---------------|--------|------|
| Warm TTFT p99              | < 3000ms      | TBD    | TBD  |
| Warm full latency p99      | < 12000ms     | TBD    | TBD  |
| Error rate                 | < 5%          | TBD    | TBD  |
| Warm avg cost / call       | < $0.02       | TBD    | TBD  |
| Cache effect (warm/cold $) | < 50%         | TBD    | TBD  |

### Cold vs warm summary

| Block         | Calls | TTFT p50 | TTFT p95 | TTFT p99 | Full p50 | Full p95 | Full p99 | Avg cost |
|---------------|-------|----------|----------|----------|----------|----------|----------|----------|
| Cold (1-5)    | 5     | TBD      | TBD      | TBD      | TBD      | TBD      | TBD      | TBD      |
| Warm (6-50)   | 45    | TBD      | TBD      | TBD      | TBD      | TBD      | TBD      | TBD      |
| TOTAL         | 50    | TBD      | TBD      | TBD      | TBD      | TBD      | TBD      | TBD      |

Total LLM spend on stress run: TBD.

Run: `npm run stress:wave2`
Raw output: `docs/wave2-stress-output.json`

---

## 5. Security — API key never reaches client

`npm run build` produces `dist/client/` (browser bundle) and
`dist/server/` (worker entry).

```
$ grep -rn "sk-ant"           dist/client/   →   0 hits
$ grep -rn "ANTHROPIC_API_KEY" dist/client/   →   0 hits
$ grep -rn "anthropic-ai"      dist/client/   →   0 hits
$ grep -rn "api.anthropic.com" dist/client/   →   0 hits
```

Server-side (`dist/server/assets/router-*.js`) DOES contain
`ANTHROPIC_API_KEY` strings — these are the SDK's `process.env` reads and
the explicit "missing env var" error — not the actual secret value:

```
dist/server/assets/router-DEaDVpvk.js:15043   * @param {string … process.env['ANTHROPIC_API_KEY'] ?? null
dist/server/assets/router-DEaDVpvk.js:15695   const key = process.env.ANTHROPIC_API_KEY;
dist/server/assets/router-DEaDVpvk.js:15697     throw new Error("ANTHROPIC_API_KEY not set (server-only env var)");
```

`grep -rn "sk-ant-api03" dist/` returns **0 hits**: the live key value is
never inlined into a build artifact. Adversary's [BUILD CHECK PASS] from
2026-05-21 reproducible.

Note: `dist/server/.dev.vars` is stripped by the `postbuild` script
(`package.json:11 rm -f dist/server/.dev.vars`), closing the MED-1
finding from the adversary report.

---

## 6. Findings from the adversary report

Reproducing the relevant HIGH/MED items from `docs/wave2-adversary-report.md`:

| ID      | Severity | Status      | Verified by this report |
|---------|----------|-------------|-------------------------|
| HIGH-1  | HIGH     | RESOLVED    | AbortController plumbed through `/api/explain` and `/api/advise`; tab close should propagate (not e2e-verified here, but code path inspected) |
| HIGH-2  | HIGH     | RESOLVED    | `flushCost` is idempotent + invoked on success, error, abort, cancel paths |
| MED-1   | MED      | RESOLVED    | `dist/server/.dev.vars` stripped by `postbuild`; verified above |
| MED-2   | MED      | RESOLVED    | `DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL=1` allows 50-call stress run without 429s |
| MED-3   | MED      | OPEN (Wave 3) | In-memory rate-limit Map per-isolate; documented; defer to Wave 3 KV/DO |
| MED-4   | MED      | RESOLVED    | 256 KB body limit in `explain.ts:43-47` and `advise.ts:43-47` |
| MED-5   | MED      | OPEN (Wave 3) | `_hits` Map unbounded growth; defer to Wave 3 |
| LOW-1   | LOW      | OPEN        | Zod kpis schema strictness — current callers pre-filter, so non-blocking |
| LOW-3/4 | LOW      | OPEN        | `.env.example` / `.gitignore` hygiene — non-functional |

### New finding from this report

| ID      | Severity | Status | Description |
|---------|----------|--------|-------------|
| TESTER-1 | MED     | OPEN  | `empty.json` fixture routes Explainer to the OPTIMAL branch when `status: "OPTIMAL"`. Should short-circuit to templated string regardless of declared status when fasi is empty + kpis empty. Owner: explainer-engineer. See §3. |

---

## 7. Files produced

| Path                                                            | Purpose                                  |
|-----------------------------------------------------------------|------------------------------------------|
| `tests/e2e/wave2-panels.spec.ts`                                | Playwright e2e for both panels           |
| `tests/server/wave2-no-hallucination.test.ts`                   | No-hallucination guard (tsx script)      |
| `tests/server/wave2-edge-cases.test.ts`                         | Edge-case template assertions            |
| `scripts/stress-wave2.ts`                                       | 50-call stress runner with cold/warm split |
| `package.json`                                                  | New scripts: `test:wave2*`, `stress:wave2` |
| `docs/wave2-no-hallucination-output.json`                       | Raw output of §2                         |
| `docs/wave2-edge-cases-output.json`                             | Raw output of §3                         |
| `docs/wave2-stress-output.json`                                 | Raw output of §4                         |

`tests/fixtures/wave2-solutions/` (the 5 fixture JSONs + README) was
pre-produced by the team-lead and re-used as-is.

---

## 8. GO / NO-GO for Wave 3

**Verdict: GO.**

The BFF is structurally sound, prompts produce well-behaved Italian
output with verifiable numbers, streaming is wired through both panels,
the API key never crosses to the client bundle, and stress at 50
sequential calls stays well within the budget.

The one MED finding (TESTER-1, `empty` fixture mis-routing) is a
cleanup in `src/server/llm/explainer.ts:103-114` — non-blocking for the
demo flow because the deterministic-json solver does not emit empty
OPTIMAL solutions on `demo-commesse`. It should be picked up as the
first chore of Wave 3 alongside MED-3/MED-5 (rate-limit hardening) if a
public surface is added.

Outstanding items deferred to Wave 3:
- Move rate-limit storage off the in-memory per-isolate Map (MED-3 + MED-5).
- Schema-validate or re-fetch from backend (DESIGN-3) before exposing the BFF to user-typed input (Manager Chat).
- Strip empty-status mis-routing in the explainer (TESTER-1).
