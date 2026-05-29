# Wave 16.5 — Adversary Report

**Reviewer:** devil-advocate (Opus, read-only)
**Date:** 2026-05-29
**Scope:** 3 live-bug fixes (A1/A2/A3, B1/B2/B3) + the day_anchor "freeze-the-past" round (BE `e2eff5d`, FE `1a1aad0`) + the machine_unavail_v3 temporal work (BE `b2e4ce1`/`bbbc81e`/`d694a28`/`6bd6da1`).
**Branches:** BE `feat/wave-16.5-temporal` (daino-backend-definitivo) · FE `feat/wave-16.5-fixes` (frontend-industriale).

**Method:** static read of every commit + **runtime proof** for the DAY_MIN and off-by-one lenses (I ran the BE extractor and the FE `detectScenarioStartMin` directly; I ran the FE `reschedule-fresh` server suite). Per the mandatory protocol I reported each CRITICAL/HIGH to team-lead the moment it was confirmed.

---

## FINAL VERDICT: **MERGE-CLEAN** (all CRITICAL/HIGH/MEDIUM resolved & runtime-verified; only LOW carry-overs remain)

> Updated 2026-05-29 (final pass post-orphan-commit). Original verdict was FIX-THEN-MERGE; all blocking findings landed and were independently runtime-verified by me. **FINAL committed HEADs: BE `95a89bf`, FE `a91e861`** — both trees now **clean** (the apply-whatif F-W8-07 orphan and the BE conftest orphan were committed separately per Paolo: FE `a91e861`, BE `95a89bf`). The previously-noted committed-tree red (L-2 / apply-whatif-low-confidence:352) is now **GREEN** — `a91e861` aligned the code to the long-committed test; I re-ran that file: 5/5 passed. See the **FINAL ADDENDUM** at the end. Suites on the final clean trees (mine): BE 3-suite **191 passed**, FE server **214 passed | 7 skipped**.

- **C-1 (CRITICAL — dopodomani/fra-N over-freeze): RESOLVED** (task #3/4d28be4). All four reachable HIT vectors now return `needs_day_clarification=True`; FE asks instead of computing a calendar cutoff. FE dead-branch removed (#4) as root-cause cleanup.
- **H-1 (HIGH — ReDoS): RESOLVED** (task #6/3c33f1c). `(?<=\s)e(?=\s)` lookaround — 470× faster (40k spaces 8.7ms), semantically exact, compound classification preserved.
- **M-1 / M-2 / M-4 (MEDIUM): RESOLVED** (bcf45ca / 47e107f / 8a2152d). UI no longer claims a freeze that didn't happen; the impossible-caller test is re-pointed; the range-end "…a giorno N" is no longer mis-anchored.
- **Solid (unchanged):** cutoff is model-minutes never 1440, off-by-one clean, ask-flow structurally gated, A3 merge preserves all `adaptResult` fields, multi-machine→GRAY, clip-to-horizon consistent, no Wave 16.4 regression.

**Blocking status:** none. All CRITICAL/HIGH/MEDIUM resolved. Remaining LOW items (M-3, L-1, L-3, L-4) are non-blocking 16.6 carry-overs; L-2 (uncommitted `apply-whatif.ts` + orphans) is escalated to Paolo and must NOT be folded in via `git add -A`.

---

## CRITICAL

### C-1 — "dopodomani" / "fra N giorni" bypass the day_anchor ask-flow and hit the calendar-1440 freeze (the exact TD-031 over-freeze this wave claims to kill)

**Confirmed at runtime (both halves).**

**Root cause — BE/FE temporal-vocabulary divergence:**
- FE `detectScenarioStartMin` (`frozen-window-builder.ts:184-210`) recognises **four** forms and multiplies each by calendar `DAY_MIN = 1440`: `domani`, `dopodomani`, `(fra|tra|in) N giorni`, `giorno N`.
- BE recognises only **two**: `_REL_DATE = "(oggi|domani)"` (`constraint_extractor.py:342`) and `_REL_DATE_SCAN_RX = "\b(oggi|domani)\b"` (`constraint_extractor.py:708`). `dopodomani` and `(fra|tra|in) N giorni` appear **nowhere** in the BE.

**Consequence.** For an utterance containing `dopodomani` or `fra N giorni` and **no** `giorno N` anchor:
- BE: `_extract_day_anchor` → `None` (needs "giorno N"); `has_relative_date = False` (scan misses dopodomani/fra-N); therefore `needs_day_clarification = False`. **The ask-flow gate never fires.**
- If a non-temporal pattern HITs on the same sentence, the BE returns `result='hit'` with **no day meta**.
- FE `reschedule-fresh.ts:276` sees `dayAnchor === null` → ELSE branch (`:287-298`) → `detectScenarioStartMin(input.message)` → calendar cutoff → `buildFrozenPhases(baseline, cutoff)` freezes everything ending ≤ that **model-minute**. With a 960-min compressed day, `dopodomani`→2880 freezes ~3 working days; `fra 3 giorni`→4320 freezes ~4.5. Silent, no error, no ask.

**Runtime evidence I produced:**

BE (`daino-backend-definitivo`, ctx `day_length_min=960`):
```
"alza priorità COM-001 dopodomani"          -> result=hit  pattern=order_priority_v1   day_anchor=ABSENT  needs_day=ABSENT
"aumenta priorità di COM-001 fra 3 giorni"  -> result=hit  pattern=order_priority_v1   day_anchor=ABSENT  needs_day=ABSENT
"COM-001 è urgente dopodomani"              -> result=hit  pattern=order_priority_v2   day_anchor=ABSENT  needs_day=ABSENT
"ferma M-1 dalle 14 alle 18 dopodomani"     -> result=hit  pattern=machine_unavail_v1  day_anchor=ABSENT  needs_day=ABSENT
```
FE (`frontend-industriale`, `detectScenarioStartMin`):
```
"alza priorità com-001 dopodomani"          -> 2880
"aumenta priorità di com-001 fra 3 giorni"  -> 4320
"ferma m-1 dalle 14 alle 18 dopodomani"     -> 2880
```

So end-to-end: BE HIT-with-no-day-meta → FE computes a calendar cutoff (2880/4320) → over-freeze. This is the TD-031 behaviour the wave's own commit messages (BE `e2eff5d`, FE `1a1aad0`, `eea9dea`) say they eliminated.

> Note: my very first reported example, `"sposta COM-001 dopodomani"`, is only **GRAY** (`deadline_change_v3` asks "to when?"), so it is **not** a vector — it short-circuits at `reschedule-fresh.ts:236` before the freeze. I corrected this to team-lead. The `order_priority_*` and `machine_unavail_v1` HITs above ARE the reachable vectors.

> **Severity adjudication (CRITICAL-now, not HIGH-latent).** Verifier initially proposed down-banding to "latent contract gap" on the basis that they could not produce a live HIT — but they had sampled only `deadline_change_v3` (GRAY) and bare machine-unavail (MISS), which genuinely don't fire. I settled it by simulating the **pre-fix gate** (`_REL_DATE_SCAN_RX = \b(oggi|domani)\b`) against the real BE: five plausible utterances return **`result=HIT` with the pre-fix gate silent** (`old_gate_matched=False` → `needs_day=False`, no anchor) — `"alza priorità COM-001 dopodomani"`, `"aumenta priorità di COM-001 fra 3 giorni"`, `"COM-001 è urgente dopodomani"`, `"ferma M-1 dalle 14 alle 18 dopodomani"`, `"ferma M-1 dalle 14 alle 18 fra 2 giorni"`. Each, pre-fix, reaches the FE ELSE branch → `detectScenarioStartMin` → 2880/4320 calendar cutoff → real over-freeze. These HIT because `order_priority_v1/v2` and `machine_unavail_v1` match on the COM/machine ref + priority/urgent/dalle-alle window **independent of `_REL_DATE`** — the relative token is trailing text the HIT classifier ignores but the FE cutoff consumes. So the over-freeze was **live-reachable from plausible manager input**, not hypothetical. Band stays **CRITICAL**.

**Why it slipped past the wave's tests.** Every `reschedule-fresh.test.ts` case **mocks** `extractConstraintFromBackend` and hand-injects `day_anchor`/`needs_day_clarification`. They prove "IF the BE sets `needs_day` THEN the FE asks" — but nothing exercises the **real** BE→FE contract, so the vocabulary gap (BE never sets `needs_day` for dopodomani/fra-N) is invisible. There is also no FE test that drives the no-anchor `detectScenarioStartMin` fallback with a HIT. (See lens 7 and memory rule on testing the *real caller shape*.)

**Fix (LANDED — task #3, BE side):** `_REL_DATE_SCAN_RX` is now `r"\b(dopodomani|domani|oggi|(?:fra|tra|in)\s+\d{1,3}\s+giorn[io])\b"` (`constraint_extractor.py:746`, alternation longest-first so "dopodomani" beats "domani"). **Verified by me at runtime** — the four vectors above now return `needs_day_clarification=True`:
```
"alza priorità COM-001 dopodomani"          -> hit  needs_day=True
"aumenta priorità di COM-001 fra 3 giorni"  -> hit  needs_day=True
"COM-001 è urgente dopodomani"              -> hit  needs_day=True
"ferma M-1 dalle 14 alle 18 dopodomani"     -> hit  needs_day=True
```
Because the FE checks `needs_day` at `reschedule-fresh.ts:209` **before** the hit branch, the FE now returns `code: 'needs_day'` (asks the manager the day) and never reaches `detectScenarioStartMin`. The over-freeze is closed on the BE side (gate) **and** on the FE side (the calendar branch is deleted — task #4). The new alternation is ReDoS-safe (0.000s on the same input — see H-1 for the separate, pre-existing whitespace-run ReDoS that is NOT in this regex).

**Task #4 (FE root-cause cleanup) — LANDED (1339737) & verified by me.** The dead-wrong `detectScenarioStartMin` branch is removed from the no-anchor path in `reschedule-fresh.ts`: the call + import are gone (only explanatory comments remain), the no-anchor cutoff is now `currentTimeMin + cushionMin` only (else → full-horizon replan), so no text→calendar-cutoff path survives even if the BE gate ever regressed (defense-in-depth). **Hard constraint honored:** `apply-whatif.ts:13,576-577` is UNTOUCHED — it still imports/uses the functions (M-3). The M-2 impossible-caller test was re-pointed: the old `Math.max→1440` test now asserts clock-only (90), and a new regression test asserts "no anchor + no currentTimeMin + dopodomani → cutoff null, NOT 2880". So #3 (BE gate, primary closer) + #4 (FE landmine removal) together fully close C-1.

**Product-context note (team-lead, accepted):** BE scan-extend is the PRIMARY fix (not FE removal alone) because Paolo explicitly requires "il sistema deve chiedere, se non esplicitato, il giorno" — the system must ASK. FE-removal alone would silently apply "ferma M-1 dopodomani" on day 0 (wrong day, no ask). The over-asking side effect (e.g. "alza priorità COM-001 dopodomani" asks the day even though a priority boost doesn't need it) is accepted "in questa fase" and logged as a **Wave 16.6 carry-over: intent-aware ask gating** (see L-3).

**Alternative fix I recommended (cleaner, FE side):** after this wave, `detectScenarioStartMin`'s **entire reachable surface in `reschedule-fresh` is buggy** — `domani` is now caught by the BE scan (→ ask), `giorno N` now sets `day_anchor` (→ IF branch), so the *only* phrases that fall through to `detectScenarioStartMin` are exactly dopodomani + fra/tra/in N giorni, and for all of them the calendar cutoff is wrong (day-0 is deadline-anchored, not wall-clock — the wave's own premise, `ReplanModal.tsx:31-44`, commit `eea9dea`). Removing the `detectScenarioStartMin` branch from the no-anchor path in `reschedule-fresh.ts:287-300` kills the bug at the source and relies on no future BE/FE lockstep. The team chose the BE fix; either alone closes the over-freeze. **Do not delete `detectScenarioStartMin` outright** — it is still used by `apply-whatif.ts:576` (see M-3).

---

## HIGH

### H-1 — Quadratic ReDoS in `_COMPOUND_JOIN_RX` on a whitespace run (PRE-EXISTING, live in the touched module, cheap DoS on the extract endpoint)

**Confirmed at runtime.** The **pre-fix** `_COMPOUND_JOIN_RX = re.compile(r"\s+e\s+")` (was at `constraint_extractor.py:1997`), called by `_detect_compound` on every `extract_constraint` invocation. On a long whitespace run with no standalone "e", `re.search` is **O(n²)** — `search` retries at every start offset, and at each offset the first `\s+` greedily consumes the whole run, fails to find the literal `e`, and backtracks one char at a time (O(n) work × O(n) offsets). The literal `e` between the two `\s+` does not prevent this because it is never found. Measured scaling on pure-space input:
```
10000 spaces ->  0.253 s
20000 spaces ->  1.013 s
40000 spaces ->  4.044 s
80000 spaces -> 15.821 s     (perfect 4× per doubling = O(n²))
```
Reachable end-to-end: `extract_constraint("COM-001 urgente fra" + " "*40000 + "3 giorni")` hangs **4.1s** (profiled the full call → `_detect_compound` → `_COMPOUND_JOIN_RX.search`). Any utterance/API body with a large space or tab run trips it.

> **Important version distinction (a measurement trap):** this O(n²) is a property of the **OLD `\s+e\s+` regex only**. The committed fix (task #6 / 3c33f1c) replaced it with the lookaround `(?<=\s)e(?=\s)`, which is **linear** (40k spaces → 0.36 ms; 200k → 1.8 ms). So importing the *current* `_COMPOUND_JOIN_RX` and timing it shows linear behaviour — that is the fix working, NOT evidence the bug never existed. Side-by-side on identical input: OLD 40k → 4036 ms vs NEW 40k → 0.36 ms (a ~11000× difference). The bug was real pre-fix; the fix is correct and necessary.
>
> **Dispute resolved (both reviewers + the fixer agree).** A reviewer (verifier) initially measured the post-fix regex (and tail-shapes like `…x`/`…giorn` that let the OLD regex fail fast) and proposed down-banding to "LOW / not a ReDoS". On re-test with the catastrophic shape (`"COM-001 urgente fra" + " "*40000 + "3 giorni"`) they reproduced **4958 ms** (scaling 85→312→1265→5140 ms across n=5k→40k = 4.06×/doubling = O(n²)) and **retracted**, confirming it IS a genuine ReDoS. be-temporal-fixer independently reproduced the same quadratic curve (0.30/1.23/4.96s). So O(n²) is triple-confirmed; the band stays **HIGH** (bounded in practice by the FE input caps — at the 20k apply-whatif-equivalent it was ~1.3s, still a single-request DoS-able latency — and fully removed by the fix).

**Severity — HIGH in principle (genuine O(n²)), bounded in practice by input caps, but the BE endpoint itself is UNCAPPED:**
- FE `reschedule-fresh` caps `message` at 4000 chars (`reschedule-fresh.ts:48`) → worst case **~44 ms** (measured). This is the only FE route that reaches the deterministic extractor (`apply-whatif` uses the Haiku `parseIntent`, NOT `_detect_compound`, so it does not reach this regex despite its 20k `whatifText` cap).
- **BUT the BE endpoint `POST /api/internal/extract-constraint` has `instruction: str = Field(..., min_length=1)` with NO `max_length`** (`routes_internal.py:106`). A direct caller of that internal endpoint (anyone with `DAINO_INTERNAL_SECRET`, or if the endpoint is ever exposed) can send 40k+ chars → 4.1s+ per request. So the "~40 ms bound" holds only for FE-originated traffic; the BE endpoint is uncapped.

**Not the new code.** The new `_REL_DATE_SCAN_RX` alternation (dopodomani / fra-N) is ReDoS-safe — 0.000s on the same input. The wave's existing ReDoS guard (`test_redos_guard_state_regex_terminates_fast`) stresses comma/semicolon/`"da"` runs but **never a pure space run**, so it does not cover this. Per the separator-run testing rule, the missing case is exactly a single repeated whitespace separator.

**Fix — team-lead chose `(?<=\s)e(?=\s)` (lookarounds), and that is the CORRECT choice (I verified).** I initially suggested `\be\b`, but I confirmed at runtime that `\be\b` is NOT semantically equivalent to the original `\s+e\s+`: it would also match "e" adjacent to punctuation/hyphens (`a,e,b`, `word-e-word`, `prezzo e/o sconto`, leading/trailing "e"), which would change compound classification. The lookaround form `(?<=\s)e(?=\s)` matches the **exact same set** as the original across all 12 test strings I checked (whitespace-bounded "e" only — incl. tab/newline) AND is linear (200k spaces → 0.0018s). Since the regex fix makes the match O(n), input length becomes irrelevant for ReDoS — so a BE `max_length` is then just optional defense-in-depth, not load-bearing. Add a pure-space-run case to the ReDoS test (`" "*20000`, assert <1s) plus a semantic-equivalence guard (the 12 strings above).

**Scope:** pre-existing (not introduced by Wave 16.5). Team-lead **folded the 1-line fix into this wave (task #6)** — rationale: trivial, the fixer is already in `constraint_extractor.py`, and the wave's ReDoS hardening is demonstrably incomplete without space-run coverage. Recommend ALSO adding `max_length` to the BE `instruction` field as cheap defense-in-depth (the endpoint should not accept unbounded input regardless). Reported to team-lead the moment found, per protocol.

---

## Exhaustive temporal-vocabulary sweep (gate-completeness proof)

Team-lead asked me to confirm `dopodomani` + `(fra|tra|in) N giorni` is the **complete** set of FE forms the BE gate must mirror. I enumerated every form the FE `detectScenarioStartMin`/`detectScenarioPhraseMatches` recognises (the FE temporal surface is exactly four regexes, all in `frozen-window-builder.ts:179-182`; no other FE file derives a text cutoff — only `reschedule-fresh.ts` and `apply-whatif.ts` consume these) and cross-checked each against the **post-fix** BE at runtime:

| Form | FE cutoff | BE `rel_date_scan` | BE `day_anchor` | Resolves to | Aligned? |
|------|-----------|--------------------|-----------------|-------------|----------|
| `oggi` | null | True | None | FE no freeze; BE asks (needs_day) if no anchor | ✅ |
| `domani` | 1440 | True | None | needs_day → FE asks | ✅ |
| `dopodomani` | 2880 | True | None | needs_day → FE asks | ✅ (fixed) |
| `fra/tra/in N giorni` (N∈1..365) | N×1440 | True | None | needs_day → FE asks | ✅ (fixed) |
| `giorno N` (N≥2) | (N-1)×1440 | False | N | day_anchor → FE IF branch | ✅ |
| `giorno 1` | null | False | 1 | FE no freeze; BE anchor offset 0 | ✅ |
| `fra 999 giorni` (over cap) | null | True | None | FE no freeze; BE still asks | ✅ (safe dir) |
| `DOPODOMANI` / accents | 2880 | True | None | both case-fold (`_normalize` + `IGNORECASE`; FE `.toLowerCase()`) | ✅ |
| `dopo domani` (spaced) | 1440 (matches "domani") | True | None | both treat as "domani" → ask | ✅ |

**Conclusion: the gate is complete.** There is **no** form where the FE computes a non-null calendar cutoff while the BE sets neither `day_anchor` nor `needs_day_clarification`. The dangerous direction is fully closed. The only residual asymmetries are in the *safe* direction (FE caps N at 365 → null while BE still asks). The BE/FE vocabularies are now in lockstep; the only ongoing risk is future drift (see L-4 — recommend a contract test that asserts the two regex surfaces stay equal).

---

## MEDIUM

### M-1 — UI falsely claims "giorni precedenti congelati" when the freeze was skipped (day_anchor present but `day_length_min` missing)

`ReplanModal.tsx:346-349` keys the success message off `payload.day_anchor >= 2`:
```
typeof payload.day_anchor === 'number' && payload.day_anchor >= 2
  ? `Piano ricalcolato dal giorno ${payload.day_anchor} (giorni precedenti congelati). ...`
  : `Piano ricalcolato da inizio orizzonte. ...`
```
But the BFF's own defensive path (`reschedule-fresh.ts:282-286`, covered by `reschedule-fresh.test.ts:447`) returns `day_anchor: 2` **with `cutoff_min: null` and `frozen_count: 0`** when `time_config.day_length_min` is absent — it echoes the anchor (`:327`) even though it froze nothing. In that case the UI tells the manager "giorni precedenti congelati" (previous days frozen) while the solver actually replanned the **whole** horizon, including the days the manager believes are locked. That is precisely the "silent-wrong" the wave is trying to avoid, just in the message layer.

**Fix:** gate the message on what actually happened, e.g. `payload.frozen_count > 0` (or `payload.cutoff_min != null && payload.cutoff_min > 0`), not on `day_anchor >= 2`. The `ReplanModal-fresh-caller.test.tsx:158` test only covers the happy path (`day_anchor: 2, cutoff_min: 960, frozen_count: 3`); add a case with `day_anchor: 2, cutoff_min: null, frozen_count: 0` asserting the "da inizio orizzonte" wording.

### M-2 — `reschedule-fresh.test.ts:238` ("future scenario start") tests a caller shape that cannot occur in production

This test mocked the extractor to return `hit` with **no** `needs_day_clarification` for a `"...oggi... da domani torna..."` utterance, and asserted the `detectScenarioStartMin` cutoff (1440) wins. But the **real** BE, run on that same string, returns **MISS** (compound/other), and on simpler `"M-1 rotta oggi"`/`"ferma M-1 domani"` it returns **HIT + `needs_day_clarification=True`** (verified at runtime). In all real cases the FE short-circuits (extract_miss or needs_day) and **never reaches** `detectScenarioStartMin`. So the test gave false confidence that the "future scenario start" path was exercised correctly, when that path was in fact either dead (real extractor flags `needs_day`) or buggy (dopodomani → C-1). It masked C-1.

**RESOLVED (47e107f) & verified by me.** be-temporal-fixer found and re-pointed **three** tests with this mocked-impossible-caller anti-pattern, each against the real BE: (1) the no-anchor cutoff test → `"ferma M-1 dalle 14 alle 18"` (genuine `machine_unavail_v1` HIT, no needs_day, legitimately reaches the clock cutoff = 90); (2) the currentTimeMin freeze test → `"ferma M-2 dalle 14 alle 18"` (real v1 HIT, also fixed stale `pattern_id`); (3) the dopodomani regression → now mocks the **realistic GRAY + `needs_day_clarification:true`** shape and asserts the route returns `needs_day` with `fetchMock` NOT called (no 2880 path reachable), plus a non-relative-HIT companion isolating the pure no-freeze cutoff. The over-freeze guard is now structural AND realistic. 14/14 reschedule-fresh tests green. (Residual cosmetic: two older happy-path tests still mock the legacy `pattern_id 'machine_unavailability_v1'` where the BE now emits `'machine_unavail_v1'` — internally consistent, harmless echo-through, flagged as a 1-char cleanup, non-blocking.)

### M-4 — `_DAY_ANCHOR_RX` mis-reads a range-endpoint "…a giorno N" as the current-day anchor → over-freezes the disruption window (runtime-confirmed)

**Confirmed at runtime.** `"M-1 rotta da domani a giorno 5"` → BE returns `result=hit` with `day_anchor=5` and **no** `needs_day_clarification`. The bare `giorno` alternative in `_DAY_ANCHOR_RX` (`constraint_extractor.py:739`) greedily reads the **range endpoint** "a giorno 5" as the manager's **current day**. The manager means "M-1 is down *from tomorrow until day 5*"; instead the FE takes `dayAnchor=5` → `cutoffMin=(5-1)×960=3840` → freezes days 1-4 — **including day 2, the very day the breakdown starts**. The disruption window gets frozen over, so the solver cannot re-plan around the failure.

This is **not** the FE/BE vocabulary divergence (here both sides agree on 5) — it is the BE mis-*classifying* a range end as an anchor. Trigger is narrower than C-1 (requires "da \<reldate\> a giorno N" in one sentence), hence MEDIUM. The bare-`giorno` anchor shipped in **this** wave (`e2eff5d`), so this is a **Wave 16.5 regression, in-scope** (not pre-existing). Folded in as task #7.

**Suggested fix (BE):** in `_extract_day_anchor`, when the match is the bare `giorno N` form (no "siamo al"/"oggi è il" lead-in) AND a range preposition immediately precedes "giorno", return None so `needs_day`/the v3 two-date window handles it. The explicit lead-in forms must still anchor.

**Fix LANDED (8a2152d) & reviewed by me — with a residual hole (M-4b below).** be-temporal-fixer implemented the range-preposition guard (`_RANGE_PREP_BEFORE_DAY_RX` covering `a/ad/da/dal`). I verified: the reported vector "da domani a giorno 5" → `day_anchor=None`, needs_day=True; "fino a giorno 5"/"da giorno 5" → None; and crucially the legit anchors are preserved (`siamo al/oggi è il/al giorno`, AND "giorno 2 M-1 rotta oggi" → 2). **The fixer correctly chose preposition-only over my suggested "OR `_REL_DATE_SCAN_RX` present"** — I had over-suggested: the `_REL_DATE_SCAN_RX`-present condition would wrongly suppress the legit sentence-initial "giorno 2 ... oggi" anchor. Good design call; I retract that half of my suggestion.

### M-4b — range-endpoint guard preposition set is incomplete: "fino al giorno N" / "entro giorno N" still mis-anchor (residual of M-4)

While verifying the M-4 fix I found the guard's preposition set (`a/ad/da/dal`) is **narrower than the bug**. Still mis-anchoring to the endpoint (runtime-confirmed): `"M-1 rotta da domani fino al giorno 5"` → anchor=5 (the guard covers "fino **a** giorno" but not "fino **al** giorno" — the articulated preposition; **"fino al giorno N" is very common Italian for "until day N"**); `"M-1 rotta entro giorno 5"` → anchor=5 ("entro" = by/within); and the two-date list/range forms `"...domani e giorno 5"` / `"tra oggi e giorno 5"` → anchor=5. **Recommended:** add `al/allo/alla` (and ideally `entro`) to the preposition alternation — a 1-line extension that closes the common "fino al giorno N" case. The two-date forms are rarer and arguably belong to the v3 two-date window logic, so deferring those is fine. Severity MEDIUM-minus (same over-freeze as M-4 but on narrower phrasings; the originally-reported vector IS closed). Disposition (extend now vs carry-over) is with team-lead / be-temporal-fixer.

### M-3 — Same calendar-1440 path exists in `apply-whatif.ts` (PRE-EXISTING, out of W16.5 scope, flagged for follow-up)

`apply-whatif.ts:576-577` calls `detectScenarioStartMin` / `detectScenarioPhraseMatches` for its what-if cutoff (Wave 16.4 A4). The day_anchor mechanism was **not** extended to this route, and it does **not** gate on `needs_day_clarification`, so the same `dopodomani`→2880 / `fra N giorni`→4320 calendar cutoff applies to the what-if preview. The task #3 BE fix does **not** close this path (apply-whatif ignores `needs_day`). This pre-dates Wave 16.5 so it does **not** block the wave, but it is the same latent calendar issue and should become a tracked follow-up (extend day_anchor to apply-whatif, or remove the calendar fallback there too). Mitigation already present in apply-whatif that reschedule-fresh lacks: an `a4_cutoff_beyond_horizon` warning (`:611-618`) surfaces the over-freeze symptom.

---

## LOW

### L-1 — `_attach_day_meta` attaches `needs_day` to GRAY results, so a vague operator-unavailability with "oggi" asks the day instead of confirming the slot

`"operatore mario malato oggi"` → GRAY (`operator_unavail_v2`) **with `needs_day_clarification=True`** attached (`constraint_extractor.py:2064-2072`). Because the FE checks `needs_day` (`reschedule-fresh.ts:209`) *before* the gray_zone branch (`:236`), the manager is asked "che giorno è oggi?" instead of seeing the v2 "confermi lo slot?" prompt. Reasonable (an un-anchored relative date does need the day), but it loses the more specific GRAY confirmation message. Cosmetic; note only.

### L-2 — Uncommitted, out-of-scope modification to `apply-whatif.ts` sitting in the FE working tree

`git status` on `feat/wave-16.5-fixes` shows `apply-whatif.ts` **modified but not committed** (re-includes `intent_id='unknown' + low` in the `low_confidence_classification` banner — the F-W8-07 change; removes the `&& intent_id !== 'unknown'` guard at committed `apply-whatif.ts:679`). This change is **not** part of any Wave 16.5 commit. It is unreviewed and would ride along on a `git add -A`. Per the shared-worktree commit-scope rule, do not let it merge implicitly with the wave. **Status: team-lead is escalating the apply-whatif F-W8-07 banner change + the conftest orphans to Paolo as a separate scope decision — out-of-scope/known, NOT a blocker for the day_anchor wave.** (Also untracked: `docs/wave-15-adversary-report.md`, two `__tests__/*warning*.test.ts`, `.claude/` — verify these are intended.)

> **RESOLVED (Paolo committed the orphan, FE `a91e861`).** Originally: the committed FE tree had **1 red test** that the orphan toggled. I traced it — the **committed** test `apply-whatif-low-confidence.test.ts:283` (assertion `:352` `expect(solved.warnings).toContain('low_confidence_classification')`) asserts the NEW banner behavior, while the **committed** code (`apply-whatif.ts:679`) still had the OLD guard excluding `unknown` → the test FAILED against committed code (working tree with orphan green = 214; clean committed checkout red = 213+1). **Both the guard and the test dated to the same pre-Wave-16.5 commit 922136c4 (2026-05-23)** — a pre-existing committed-tree inconsistency, NOT introduced by Wave 16.5; the orphan was the *fix* re-aligning code to the long-committed test. **Paolo's decision was to commit the orphan (`a91e861` "fix(F-W8-07): low-confidence banner fires for unknown intent")**, which I verified resolves it: the file now passes **5/5**, and the full FE server suite is **214 passed | 7 skipped** on the clean committed tree (`a91e861`). So the committed FE tree IS now fully green. I flagged this so the decision was made with the full picture rather than as a silent "all green" — and it was.

> **Correctness of the change itself (independently verified by BOTH devil-advocate AND verifier, for Paolo's scope decision):** the change's load-bearing justification — "the `low_confidence_classification` banner only ever renders from `solved.warnings`; `aborted_unsupported` ignores warnings" — is **TRUE**. Confirmed in `WhatIfAnalysis.tsx`: the `aborted_unsupported` handler (`:460-464`) only sets `applying='unsupported'` + a toast and **never** calls `setCandidateWarnings`; `candidateWarnings` (the banner source) is populated **only** by the `solved` handler (`:505-509`). So dropping the `&& intent_id !== 'unknown'` guard surfaces the warning only on a genuine Strategy-C-rescue→solved outcome (unknown+LOW → Opus rescue → solved); unknown+HIGH short-circuits to `aborted_unsupported`, which ignores warnings. The change is **logically sound and safe** — if Paolo lands it, it cannot produce a double/contradictory banner.
>
> **Condition if landed:** there is **no regression test** for the unknown+LOW→rescue→solved→banner path (verifier's residual flag). It is correct-by-construction but unguarded. This is NOT a Wave 16.5 blocker (the change is uncommitted + out-of-wave-scope); it is a condition that attaches to Paolo's land-or-drop decision — if he lands it, add that test.

### L-3 — Over-asking: relative-date-with-HIT now asks the day even when the constraint doesn't depend on it (Wave 16.6 carry-over)

A consequence of the C-1 fix (accepted by team-lead per Paolo's "ask the day" requirement): "alza priorità COM-001 dopodomani" now returns `needs_day` and asks "che giorno è oggi?" even though a priority boost is day-independent. Correct-but-chatty. Logged as a **Wave 16.6 carry-over: intent-aware ask gating** — only ask the day when the matched constraint actually consumes a resolved date (machine-unavail windows) vs. when the relative date is incidental (priority/deadline-delta). Not a blocker; the safe default (ask) is the right call for now.

### L-4 — No contract test pins the BE↔FE temporal-vocabulary lockstep

C-1 was a vocabulary divergence between two regex surfaces that must stay equal: FE `frozen-window-builder.ts:179-182` and BE `_REL_DATE_SCAN_RX` + `_DAY_ANCHOR_RX`. The fix re-aligns them, but nothing prevents future drift (the exact failure mode the contract-arbiter pattern warns about). Recommend a single cross-repo contract test (or a shared fixture list of temporal phrases) asserting: for every phrase, FE-produces-a-cutoff ⟺ BE-sets-day_anchor-or-needs_day. Cheap insurance against C-1 reopening.

### L-5 — `machine_unavail_v1` (explicit dalle-alle) ignores the day_anchor offset → places the window on day 0 (PRE-EXISTING, narrow)

Found while cross-checking be-temporal-fixer's "anchor+relative combo" note. `"siamo al giorno 3, ferma M-1 dalle 14 alle 18 dopodomani"` → **HIT** with `unavailable_machines={'M-1': [{start_min:840, end_min:1080}]}` — i.e. the explicit dalle-alle window is placed at **day-0** 14:00-18:00, ignoring BOTH the stated anchor (giorno 3) AND "dopodomani". The manager meant a future day; the window lands on day 0. Confirmed root cause: `_day_anchor_offset` is read only by the v3 / v3_bare handlers (`constraint_extractor.py:971, 1076`), **not** by `_handle_machine_unavail_v1` (`:567-655`) — v1 predates the anchor mechanism and is anchor-unaware by construction. So this is **pre-existing v1 behaviour, not a Wave 16.5 regression**, and the trigger is narrow (explicit dalle-alle + a stated anchor + a trailing relative date in one sentence).

**Why it escapes the ask-flow (gate-invariant insight, credit be-temporal-fixer):** the #3 gate rule is `needs_day = has_relative_date AND day_anchor is None`. That "anchor present ⇒ safe not to ask" assumption is sound **only if the anchor actually resolves the relative date**. v1 ignores both the anchor and "dopodomani" for windowing, so for the specific combination **v1 + a relative-to-now token v1 can't resolve**, the invariant is violated and `needs_day` is wrongly suppressed. Two valid fixes (16.6): **(a)** the full fix — make v1 honor `_day_anchor_offset` AND resolve dopodomani/fra-N; **(b)** the cheaper safety net — fire `needs_day` when a relative-to-now token is present AND the matched pattern is v1 (which can't resolve it), even if an anchor exists. (b) is the minimal close; (a) is the complete behaviour. Non-blocking. (be-temporal-fixer's companion observation — anchor present + relative-to-now token where the constraint carries no window, e.g. priority/bare-stop — GRAYs safely with no fabricated window; I confirmed those cases are clean.) **Tracked in `docs/to_do/` by be-temporal-fixer for 16.6.**

---

## What I verified is SOLID (no action needed)

**day_anchor cutoff unit — never 1440 (the headline CRITICAL trap): CLEAN — MUTATION-TESTED.**
`reschedule-fresh.ts:271-300` — when `dayAnchor !== null`, the cutoff is computed **only** as `(dayAnchor-1) * dayLengthMin` with `dayLengthMin` read from `time_config.day_length_min` (`dayLengthMinFromBaseline`, `:114-120`). When `day_length_min` is absent it returns `null` and the freeze is **skipped** — there is no 1440 fallback anywhere on the anchor path, and `detectScenarioStartMin` (the only 1440 source) is unreachable when an anchor is present. Runtime: "day_anchor=2 → 960 (NOT 1440)" and "day_anchor without day_length_min → cutoff null" both pass green; the defensive null test asserts `cutoff_min: null`, `cutoff_source: 'none'`, `frozen_count: 0` AND that it still solves.
> **Mutation test (verifier, the mandated DAY_MIN proof):** reverting `reschedule-fresh.ts:283` `(dayAnchor-1)*dayLengthMin` → `(dayAnchor-1)*1440` turns EXACTLY the two day-length-dependent tests RED — "day_anchor=2 … (960, NOT 1440)" (expected 1440 to be 960) and "day_anchor=3 → 2×dl" (expected 2880 to be 1920) — while the other tests (needs_day, day_anchor=1→0, no-day_length skip) stay green. So the tests **genuinely guard** the compressed-day-length invariant; a regression to calendar 1440 WOULD be caught. File restored, `git diff` empty. This is the definitive, non-vacuous proof for the headline trap — not just observed-green but mutation-proven.

**Off-by-one: CLEAN.** `(N-1)*dl` with runtime confirmation: day 1→0 (freeze nothing, `frozen_phases` omitted), day 2→960 (freeze day 1, identity-pinned to exact baseline coords), day 3→1920. BE `anchor_offset = day_anchor - 1`, `oggi`→`anchor_offset`, `domani`→`anchor_offset+1` (`_rel_day_idx`, `:758-772`). "giorno 1" rejected by both `detectScenarioStartMin` (N≥2) and accepted-as-anchor-0 by the BE consistently. No fencepost error.

**Ask-flow is structurally gated: CLEAN.** The `needs_day_clarification` check sits **before** miss/gray/hit (`reschedule-fresh.ts:209-222`), so "needs_day ⇒ never resolveTemplate" is independent of how the extractor maps `result` (devil-advocate Option 1 from a prior wave, correctly implemented). Runtime test asserts the solve `fetch` is **not** called. Client side (`ReplanModal.tsx:313-326`) appends the clarification message and `return`s — never calls `onResult`. A HIT that also carries `needs_day` (e.g. "ferma M-1 domani") correctly routes to the ask, verified at runtime.

**MISS→LLM contract preserved: CLEAN.** `_attach_day_meta` (`constraint_extractor.py:2064-2065`) explicitly skips MISS — day meta is never attached to a MISS, so the MISS→payload-None→LLM-re-extracts-everything contract holds (`6bd6da1` pins HIT-implies-bounds; 16×2 phrasings confirm a HIT never carries a `"?"` sentinel or raw_target-only entry, so the FE forwarding `rules` verbatim is safe).

**A3 accept-candidate merge: CLEAN (no null dashboard).** `WhatIfAnalysis.tsx:615-627` merges candidate `solution/kpis/warnings` over `{...originalBackendResult}`, and `index.tsx:180` wires `originalBackendResult={backendResult}` — the full original envelope (the same object fed to `adaptResult` for the live dashboard). So `time_config`/`maintenance`/`operator_config`/machines/operators all carry through; `adaptResult` (`resultAdapter.ts:426`) always returns a `DashboardData` and never throws on a missing field. The merge is only as complete as the original envelope, but if the original were degraded the live dashboard would already be degraded — accept does not make it worse. The accept-candidate audit POST is correctly fire-and-forget (`:631` updates the parent first; a `:637` failure is swallowed).

**Compound temporal edges: CLEAN.**
- Multi-machine in one sentence → GRAY with the `"?"` sentinel, never a silent single-machine HIT (`constraint_extractor.py:862`, and the bare-stop handler `:1031`). Runtime: `"m1 ed m2 oggi rotta"`, `"m1, m2 oggi guasta"`, `"m1 oppure/poi m2 ..."` all GRAY with `keys == ["?"]`. Single machine + comma still HITs (`:392` over-trigger guard).
- ReDoS (v3 STATE regex) — the v3 STATE regex was the prior CRITICAL; the fix (letter-prefixed connectors, no comma in the inner alternation that the leading `[\s,.;]+` separator-run already consumes) holds. Test stresses **single repeated separators** (`","*20000`, `", da"*8000`, `" ; "*8000`) asserting <1s — matches the separator-run stress rule, not connector words. Genuine. **Caveat:** this guard is scoped to the v3 regex only; it does NOT cover the compound-join whitespace-run ReDoS — see H-1.
- Clip-to-short-horizon (`d694a28`): an absolute v3 window is clipped to `ctx.horizon`, never discarded; `end_min==horizon` → full block (not lost); window entirely beyond horizon → safely skipped, no crash. Consumer-side, internally consistent in model-minutes.

**Regression vs Wave 16.4: CLEAN (quick probe).** `operatore OP-2 il 01/04 dalle 14 alle 18` → HIT (operator_unavail_v1); `operatore mario malato oggi` → GRAY (v2); cost-style utterances (`aumenta budget`, `riduci i costi`) → MISS (cost short-circuit intact — deterministic layer doesn't fabricate, LLM handles). None of the 3 prior live bugs reappear in the changed surface.

**Test gaming: none found (one masking gap).** No assertion was weakened to pass. The day_anchor tests assert exact cutoffs + identity-pinned frozen phases; the HIT-implies-bounds and multi-machine tests assert the strong sentinel invariants. The only issue is **coverage**, not gaming: the mocked extractor in `reschedule-fresh.test.ts` hides the real BE→FE vocabulary gap (C-1), and the line-238 test exercises an impossible caller shape (M-2).

---

## Summary table

| ID  | Sev      | Area | One-liner | Status |
|-----|----------|------|-----------|--------|
| C-1 | CRITICAL | BE↔FE | dopodomani/fra-N bypass ask-flow → calendar-1440 over-freeze (runtime-confirmed) | **RESOLVED** (task #3/4d28be4) — 4 vectors → needs_day; verifier signed off |
| H-1 | HIGH     | BE | quadratic ReDoS in `_COMPOUND_JOIN_RX` on a whitespace run (40k→4.1s); pre-existing, folded into wave | **RESOLVED** (task #6/3c33f1c) — lookaround `(?<=\s)e(?=\s)`, 470× faster, semantically exact |
| M-1 | MEDIUM   | FE UI | "giorni precedenti congelati" claimed when freeze was skipped (anchor present, no day_length) | **RESOLVED** (task #5/bcf45ca) — gated on `frozenCount>0` |
| M-2 | MEDIUM   | FE test | `reschedule-fresh.test.ts:238` "future scenario start" tests an impossible caller shape; masks C-1 | **RESOLVED** (47e107f) — re-pointed to realistic caller shapes |
| M-3 | MEDIUM   | FE | same calendar path in `apply-whatif.ts:576` (pre-existing, not W16.5) | 16.6 carry-over, non-blocking |
| M-4 | MEDIUM   | BE | `_DAY_ANCHOR_RX` mis-reads "…a giorno N" range-end as anchor → over-freezes the disruption day (runtime-confirmed) | **RESOLVED** (task #7/8a2152d) — reported vector closed; legit anchors preserved; fixer's (b)-only design call correct |
| M-4b | MEDIUM− | BE | range-endpoint guard preposition set incomplete: "fino **al** giorno N" / "entro giorno N" still mis-anchor (same over-freeze, narrower phrasings) | OPEN — found verifying #7; 1-line fix (add `al/allo/alla/entro`); team-lead/fixer to extend-now or carry-over |
| L-1 | LOW      | BE | `needs_day` attached to GRAY → asks day instead of confirming slot | Note only |
| L-2 | LOW      | FE repo | uncommitted out-of-scope `apply-whatif.ts` change + untracked files in working tree | Escalated to Paolo (out-of-scope/known); do NOT `git add -A` |
| L-3 | LOW      | BE↔FE | over-asking: relative-date+HIT asks the day even when constraint is day-independent | Wave 16.6 carry-over (intent-aware ask gating) |
| L-4 | LOW      | BE↔FE | no contract test pins the BE/FE temporal-vocabulary lockstep | Recommend shared-fixture contract test (16.6) |

**Bottom line:** the day_anchor mechanism itself is correctly built — right unit (model-minutes, never 1440), right off-by-one (runtime-confirmed 1→0, 2→960, 3→1920), structurally-gated ask-flow (check before miss/gray/hit; solve `fetch` not called), sound A3 merge (all `adaptResult` fields preserved, no null dashboard), genuine multi-machine→GRAY and clip-to-horizon guards, no Wave 16.4 regression. The headline CRITICAL trap (1440 on the anchor path) is **clean** and the defensive null test genuinely guards it.

The defects this wave introduced — the **incomplete temporal vocabulary** (C-1, the TD-031 over-freeze reincarnation) and the **range-end mis-anchor** (M-4) — plus the **pre-existing ReDoS** (H-1) and the **UI honesty gap** (M-1) and **test-realism gap** (M-2) are **all now fixed and runtime-verified by me on the correct HEADs** (see Addendum). My exhaustive sweep proves the temporal gate is **complete** — no other form leaks. One narrow residual surfaced while verifying the M-4 fix — **M-4b** ("fino al giorno N" / "entro giorno N" still mis-anchor) — a 1-line extension of the same guard; the originally-reported M-4 vector is closed and it does not reopen C-1.

**FINAL VERDICT: MERGE-CLEAN** — all CRITICAL/HIGH/MEDIUM findings resolved and runtime-verified. Two non-blocking dispositions remain for team-lead: (1) **M-4b** — extend the range-preposition guard now (trivial) or log as a narrow carry-over; (2) verifier to re-paste the official green on the correct commits (Addendum §Evidence integrity — I independently re-ran all suites green on 8a2152d/47e107f, so this is administrative). Only LOW carry-overs otherwise. M-4b is the sole open finding and is MEDIUM-minus on rare phrasings — it does not block merge, but I flag it so the disposition is explicit rather than silently dropped.

---

## ADDENDUM (2026-05-29, post-fix) — fix outcomes #3/#4/#5/#6/#7, all verified by me at runtime

**Branches at verification time:** BE `feat/wave-16.5-temporal` HEAD **8a2152d** · FE `feat/wave-16.5-fixes` HEAD **47e107f**.

| Task | Finding | Commit | Verified outcome (my runtime re-check on current HEAD) |
|------|---------|--------|--------------------------------------------------------|
| #3 | C-1 ask-flow gate | 4d28be4 (+242dbb9 tests) | `_REL_DATE_SCAN_RX = \b(dopodomani\|domani\|oggi\|(?:fra\|tra\|in)\s+\d{1,3}\s+giorn[io])\b` (`constraint_extractor.py:746`). All 4 HIT vectors → `needs_day=True`. FE asks, never freezes. |
| #4 | FE dead-branch removal + M-2 | 1339737, 47e107f | `detectScenarioStartMin` branch removed from `reschedule-fresh.ts` no-anchor path; `apply-whatif.ts` use untouched (per my constraint). reschedule-fresh suite **14/14** (was 12). |
| #5 | M-1 UI honesty | bcf45ca | "congelati" claim gated on `frozenCount>0` (`ReplanModal.tsx:354`); honest "ricalcolo completo, nessun giorno congelato" branch for anchor-but-no-freeze; "da inizio orizzonte" for no-anchor. |
| #6 | H-1 ReDoS | 3c33f1c | `_COMPOUND_JOIN_RX = (?<=\s)e(?=\s)`. 40k-space input **8.7ms** (was 4109ms, 470×); 200k **43ms** (linear). Semantic equivalence holds across 12 strings; real compounds still MISS. |
| #7 | M-4 range-end mis-anchor | 8a2152d | "da domani a giorno 5" → `needs_day=True` (no anchor); "fino a giorno 5"/"a giorno 5" → no anchor. Legit anchors preserved: "siamo al giorno 5"/"oggi è il giorno 3"/"al giorno 4"/"giorno 2 ferma m-1" still anchor. 40k-space range-end input → 22.4ms (no ReDoS reintroduced). |

**Full-suite re-run at current HEADs (mine):**
- BE 3-suite (`test_constraint_extractor` + `test_routes_internal` + `test_constraint_extractor_contract`) @ 8a2152d → **191 passed** (0.77s).
- FE server suite (`vitest.server.config.ts`) @ 47e107f → **214 passed | 7 skipped** (20 files).

**Evidence integrity (one caveat for the official sign-off).** Verifier's posted green counts were captured on **stale checkouts** (BE 172 @ pre-fix e2eff5d; FE reschedule-fresh 12; BE extractor `-k` 16/123) — these validate the PRE-fix trees, not the fixes. On the correct current HEADs the counts are BE **191** (extractor file 158, `-k` selection 31/127) and FE reschedule-fresh **14**. I re-ran everything myself on the correct commits and it is all green, so the fixes ARE validated — but verifier should re-paste the official sign-off on 8a2152d / 47e107f so the record isn't anchored to the wrong commit. This does not change the verdict; it is a process note.

**Net:** every CRITICAL/HIGH/MEDIUM is resolved and independently runtime-verified. Remaining items (M-3, L-1, L-3, L-4) are non-blocking carry-overs; L-2 (uncommitted `apply-whatif.ts` + orphans) is escalated to Paolo and must not be folded in via `git add -A`. **MERGE-CLEAN.**

---

## FINAL ADDENDUM (2026-05-29, post-orphan-commit) — committed-clean final state

**Final committed HEADs: BE `95a89bf` · FE `a91e861`. Both trees clean (no uncommitted modifications).** The two orphans were committed separately per Paolo's decision: FE `a91e861` ("fix(F-W8-07): low-confidence banner fires for unknown intent") and BE `95a89bf` (conftest). I re-ran the full pass on these final clean trees:

| Check | Result (mine, on committed `95a89bf` / `a91e861`) |
|-------|------|
| BE 3-suite | **191 passed** (0.96s) |
| FE server suite | **214 passed \| 7 skipped** (20 files) |
| Previously-red `apply-whatif-low-confidence.test.ts` (L-2) | **5/5 passed** — `a91e861` aligned code to the long-committed test; the committed-tree red is GONE |
| #6 committed regex | `_COMPOUND_JOIN_RX = (?<=\s)e(?=\s)` (lookaround, line 2034 — NOT `\be\b`); real " e " compounds still MISS (classification unchanged) |
| #7 M-4 guard | `_RANGE_PREP_BEFORE_DAY_RX` (line 789) applied to bare `giorno` (816-817); "da domani a giorno 5" → needs_day (no anchor); lead-ins "siamo al giorno 2"→2 / "oggi è il giorno 3"→3 / "giorno 2 ferma M-1"→2 / "giorno 2 M-1 rotta oggi"→2 all preserved |
| C-1 genuine-HIT vectors | "alza priorità COM-001 dopodomani" / "COM-001 è urgente dopodomani" / "ferma M-1 dalle 14 alle 18 fra 2 giorni" → all HIT + `needs_day=True` (FE asks, no over-freeze) |
| M-1 | "congelati" claim gated on `frozenCount>0` (ReplanModal.tsx) |

**Evidence-integrity note now closed:** verifier's earlier stale-checkout counts (172/12) were reconciled — verifier confirmed they are on the same final HEADs (BE `95a89bf`-equivalent tip / FE `a91e861`) and their numbers match (191 / 214|7-skip / rf=14). Both reviewers aligned on the same committed trees.

**Carry-overs for Wave 16.6 (none blocking):**
- **M-3** — `apply-whatif.ts:576` still uses the calendar-1440 `detectScenarioStartMin` path (Wave 16.4 A4, doesn't gate on `needs_day`); extend day_anchor there or remove the calendar fallback.
- **M-4b** — **RESOLVED in-wave (#8 / commit 6c04b94)**, team-lead chose fix-now. "fino **al** giorno N" and "entro giorno N" range-ends no longer mis-anchor (→ None), and the legit "al giorno N" / "siamo al giorno N" lead-ins still anchor (verified by me). The fix correctly did NOT use my naive "add `al`" (which would have regressed the lead-in); instead it added `entro` to the bare guard + a new `_FINO_BEFORE_AL_RX` keyed on "fino" before the articulated "al giorno" span. BE suite 200 passed.
- **M-4c (NEW, narrow, fails-safe → 16.6)** — found verifying #8: `_DAY_ANCHOR_RX.search` uses **first-match**, so a compound sentence with a "fino al giorno N" range-end BEFORE a genuine lead-in anchor (`"il piano va fino al giorno 5 ma siamo al giorno 2"`) now returns **None** instead of anchoring to 2 — the first match ("al giorno 5") trips the M-4b fino-guard and the later "siamo al giorno 2" is never reached. This is the **mirror of M-4 but in the SAFE direction** (no anchor → ask-flow / full-replan, NOT a wrong freeze), so it is non-blocking — an over-ask on a rare compound phrasing, not a silent corruption. Proper fix: iterate ALL `_DAY_ANCHOR_RX` matches and prefer a non-endpoint lead-in over an endpoint, rather than first-match. Tracked alongside the deferred two-date forms (both are "first-match picks the wrong giorno-N when several are present").
- **two-date forms (deferred, pinned)** — "domani e giorno 5" / "tra oggi e giorno 5" still anchor to 5 (v3 two-date-window territory, not the anchor guard). be-temporal-fixer added a test that PINS this (asserts ==5) so a 16.6 fix flips it deliberately, not silently.
- **L-5 / TD-033** — `machine_unavail_v1` is anchor-unaware (ignores `_day_anchor_offset`); tracked as TD-033 in `daino-backend-cp/docs/to_do/tech_debt.md`. The robust fix (credited generalization) is **pattern-capability-aware gating**: fire `needs_day` whenever the matched pattern can't resolve a present relative-to-now token, anchor or not.
- **L-1** — `needs_day` attached to GRAY (operator-vague + "oggi" asks the day vs confirms the slot); cosmetic.
- **L-4** — no contract test pins the BE↔FE temporal-vocabulary lockstep; recommend a shared-fixture test (FE-cutoff ⟺ BE-anchor/needs_day) to prevent C-1-style drift.
- **L-3** — over-asking: relative-date + day-independent HIT (priority) asks the day; intent-aware ask gating.

**FINAL VERDICT: MERGE-CLEAN.** All CRITICAL/HIGH/MEDIUM resolved and runtime-verified on the final committed clean trees (BE `95a89bf` / FE `a91e861`); both reviewers (devil-advocate + verifier) aligned. The two severity disputes (C-1 down-band, H-1 down-band) were each resolved in favor of the original findings on re-test. Only non-blocking LOW carry-overs remain (M-3, M-4b, L-1, L-3, L-4, L-5/TD-033) — all tracked. Nothing blocks the merge.
