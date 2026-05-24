# Wave 8 — Devil's Advocate Findings

> **Owner**: w8-devils-advocate (Opus 4.7, plan-mode)
> **Started**: 2026-05-22
> **Mandate**: 8-lens adversarial review of Wave 8 validation/fix sprint (Test 3 fix, F-W7-02 retry, multi-intent E2E, stress mock + evals, cost monitoring, multi-tenant safety, hard-lock semantics).
> **Repo**: `frontend-industriale/` branch `feat/wave7-real-effect` (HEAD `9c81a9c`).
> **Companion repo (read-only)**: `daino-backend-definitivo/` branch `feat/wave7-rules-and-frozen-window`.
> **Read-only file ownership**: `docs/wave8-adversary-findings.md` (append-only).

## Verdict aggregato (sessione iniziale, 2026-05-22)

**NO-GO** — 3 CRITICAL findings (F-W8-01, F-W8-02, F-W8-09). **F-W8-09 scoperto in round 5 è il più grave**: bug off-by-one `seq` nel BFF `frozen-window-builder.ts:96` che fa diventare SILENT-NO-OP tutto il sistema di hard-lock Wave 7 in produzione (locked_count=0 nonostante frozen_count=19). Reprodotto live via 2 curl.

I 4 teammate hanno fatto buon lavoro sulla pulizia (F-W7-02 retry implementato, F-W7-04 per-slug lock, test mock per F-W7-02), ma la pipeline su 2 dei 5 intent (extra_capacity + shift_changes) è **strutturalmente no-op** al solver: il BFF emette `rules.extra_capacity` o `rules.shift_changes`, il backend `f_apply_rules.py:_apply_data_layer_passthrough` emette warning + entry `_data_layer_passthrough` ma NON modifica `data["operators"]` / `data["shift_types"]` perché nessuno fa la conversione rules → dataset_overrides per questi due slot.

## Tabella findings (per severità decrescente)

| ID | Severity | Lente | File:line | Descrizione | Fix proposto | Stato |
|---|---|---|---|---|---|---|
| F-W8-01 | **CRITICAL → CLOSED 2026-05-23 (Opzione C landed + e2e + unit verified)** | L3 (multi-intent backend consumer) | catalog `constraint-catalog.yaml` (`not_implemented: true` su capacity+shift) + `strategy-router.ts` (kind: unsupported) + `tests/e2e/wave7-multi-intent.spec.ts` + `strategy-router.test.ts` | **FULLY CLOSED**. w8-multi-intent-tester report `docs/wave8-multi-intent-test-report.md`: tabella 3-colonne `catalog_present`/`router_classified`/`solver_consumes` sopra la tabella test (R2 mio mantenuto), Result column tagged `(honest_unsupported)` vs `(full_effect)` (R1 mio), 3/3 e2e PASS in 18.3s $0, 22/22 unit PASS in `strategy-router.test.ts` (R3 mio layered: 2 invariant F-W8-01 + 3 simmetrici negativi `deadline_change`/`machine_unavailability`/`order_priority`). Stress mock 52/52 conferma 20/52 cycles correctly routed to unsupported. Originale: `capacity_addition` e `shift_window` sono **tautologically no-op** end-to-end. (a) `data-modifier.ts:56-58` SUPPORTED_INTENTS=`['deadline_change']` — neither capacity né shift sono nello set, quindi `canApply(capacity_addition)=false` e router cascade su rule_addition. (b) `strategy-router.ts:320-334` build `rules.extra_capacity` o `rules.shift_changes`. (c) Backend `f_apply_rules.py:271-290` per questi due slot **NON modifica il model CP-SAT**: solo emette warning log + entry `extra_capacity_data_layer_passthrough` o `shift_changes_data_layer_passthrough` nel response. (d) Nessuno converte rules→dataset_overrides per estendere `data["operators"]` o `data["shift_types"]`. Risultato: Task #3 ASSERT capacity_addition ("operatori utilizzati turno serale = old+1") **non puo' essere vera** se il KPI deriva dal piano effettivo. ASSERT shift_window ("nessuna fase del turno mattino inizia prima del nuovo start_min") **passa vacuamente** se il backend non sposta il turno. Esattamente il modus operandi di F-W7-01 — il test di Wave 4.1 passava vacuamente perché backend non consumava il vincolo. | OPZIONE A (minima): implementa in `data-modifier.ts` due nuovi handler `applyCapacityAddition(entities)` e `applyShiftWindow(entities)` che producono `dataset_overrides.operator_config` (oppure `data.shift_types`) compatibili con il merge backend (`routes_optimize.py:2064-2072`). Aggiungere `capacity_addition` e `shift_window` a SUPPORTED_INTENTS. OPZIONE B: estendere `f_apply_rules.py` con due consumer CP-SAT reali (extra_capacity → aggiunge operator slot virtuale; shift_changes → modifica machine_windows). OPZIONE C (minimal viable per Wave 8): documentare esplicitamente nel catalog YAML `strategy: not_implemented` per questi due intent + far emettere al router `kind: unsupported` con warning chiaro al manager, in modo che il test multi-intent **non possa scrivere un'assertion verde** per scenari non implementati. **Senza una di queste fix, Task #3 produce green vacuo identico F-W7-01.** | open — **DM IMMEDIATA a w8-multi-intent-tester + team-lead** |
| F-W8-02 | **CRITICAL → CLOSED 2026-05-23 (eval set disjoint, double metric, expected_intent a priori)** | L5 (stress evals well-formedness bias) | `scripts/wave7-stress-evals.ts` + `docs/wave8-stress-report.md:77-119` | **FULLY CLOSED**. w8-stress-engineer report `docs/wave8-stress-report.md` §2: scenari DISJOINT da catalog YAML examples (riga 79-86), split 10 well-formed + 5 adversarial (devils canonical mix: dialect/regional, ambiguous machine ref, multi-intent, negation, typo) — esattamente i 5 sub-categories che avevo richiesto. DOUBLE METRIC: (a) "Well-formed: catalog-intent classified" → 10/10 (100%) target ≥80% ✅. (b) "Adversarial: classified as unknown / fail-soft" → 4/5 (80%, exactly at threshold) ✅. `expected_intent_ids` annotato a priori in ogni scenario (no grading bias). 1 mis-classification surfaced (adv_dialect "Sta camola..." → B-W8-S-05 nuovo finding tracked). Eval set NON è gameable. Originale: I 15 scenari italiani della task #4 sono attesi essere "presi dal constraint-catalog.yaml examples + scenari aggiuntivi italiani reali". Ma TUTTI gli examples nel catalog hanno proprietà:  (a) ID macchina/commessa esplicito ("M2", "COM-007"), (b) orario completamente specificato ("ore 12", "gg2"), (c) lingua canonica ("rotta", "anticipa"), (d) un solo intent per frase. Scenari REALI di gelateria/officina includono: (i) dialect ("sta camola fa scintille", "sta pompa si è fermata da iè"), (ii) machine refs ambigui ("la macchina nuova", "quella vicino alla porta"), (iii) intent multipli concatenati ("M2 è rotta e ho un operatore in più stasera, vediamo cosa cambia"), (iv) negazioni ambigue ("NON spostare COM-002, lascia tutto com'è"), (v) entità mancanti ("magari poi rivediamo COM-007"), (vi) typos ("anitcipa COM 007"). Il catalog è ottimizzato sulle examples che il parser ha visto in training; se l'eval set è derivato dagli examples, il classifier ratio sarà 14/15 o 15/15 — NON misura davvero la robustezza in produzione. Target dichiarato del task #4 "12/15 classified (80%)" diventa banalmente raggiungibile. | (a) Esplicitamente vietare di derivare gli evals dagli examples del catalog. Costringere un set **disjoint** da scenari raccolti da Paolo/Giulio durante visite a The Gelatist o altri pilot. (b) Includere 5/15 scenari "adversarial" che il parser DOVREBBE marcare `unknown` (es. il caso dialetto, il caso multi-intent, il caso negazione). Metrica nuova: "% di unknown correttamente identificati" + "% di catalog-intent correttamente identificati", riportati separati. (c) Annotare ogni eval con `expected_intent` BEFORE running parser (avoid grading bias). | open — **DM a w8-stress-engineer** prima che inizi Task #4 |
| F-W8-03 | **HIGH → CLOSED 2026-05-23** | L1 (Test 3 fix copre live edge case?) | `tests/e2e/wave7-real-effect.spec.ts:413, 459, 472, 476, 494-495, 1387` (post-fix) | **FULLY CLOSED**. (a)+(b) chiusi con context in round 10. (c) FIX LANDED da w8-test-infra-fixer: handler scoped `const handler = async (route) => {...}` registrato a riga 459 + rilasciato in `finally` a riga 472 con `page.unroute(pattern, handler)` (signature 2-arg matches solo questo handler, non altri test su stesso pattern). Più nuova classe `LiveCaptureError extends Error` (riga 413) con `code` field. Transport fail → `code='capture_failed'`. Anthropic 529/rate_limited nel `event: error` SSE → `code='anthropic_overload'` (riga 494-495) con messaggio "Caller should test.skip". Esportata da riga 1387 per Test 1+2 downstream usage. **Verifica empirica w8-test-infra-fixer**: Test 3/4/5/6 PASS 5.8-6.0s con backend `:8001` DOWN — conferma mocks intercettano + fix race chiusa. **Audit mio (round 11)**: grep su `tests/e2e/wave7-real-effect.spec.ts` conferma tutti i markers attesi (LiveCaptureError class, page.route+unroute con handler ref, capture_failed + anthropic_overload codes, export). | (chiuso) | **CLOSED** |
| F-W8-04 | **HIGH → CLOSED 2026-05-22** | L2 (F-W7-02 retry: Annulla durante retry) | `src/routes/api/apply-whatif.ts:559-599, 617-633` (post-fix) | **FIX LANDED da w8-infeasible-recovery (task #2 extension)**. Estratto `raceWithTimeout<T>(work)` helper con triple-guard: (1) `if (abort.signal.aborted) return Promise.reject('aborted')` all'ingresso (sync). (2) `addEventListener('abort', onAbort, {once: true})` per la finestra runtime. (3) Re-check `if (abort.signal.aborted) onAbort()` DOPO addEventListener per coprire TOCTOU race. Plus belt-and-braces `if (abort.signal.aborted) throw new Error('aborted')` dopo `write('lock_relaxing')` (riga 629-631). Applicato a ENTRAMBI first solve + retry race per evitare pattern asimmetrico. Test in `apply-whatif-wave7-infeasible.test.ts` (case 6): abort post lock_relaxing → completa in ~52ms invece di 60000ms (pre-fix). Full suite 99 passed. | (chiuso) | **CLOSED** |
| F-W8-05 | **HIGH → CLOSED 2026-05-22** | L7 (multi-tenant race condition) | `src/routes/api/apply-whatif.ts:312-326` (post-fix) | **FIX LANDED da w8-infeasible-recovery (task #2 extension)**. `WATCHDOG_MS = SOLVE_TIMEOUT_MS * 2 + 30_000 = 150_000`. Commento esteso che spiega Wave 8 finding. Aggiornato test esistente in `apply-whatif-wave7.test.ts:748` (avanza ora 151_000 invece di 91_000). Plus nuovo test in `apply-whatif-wave7-infeasible.test.ts` (case F-W8-05): backend lento 55s INFEASIBLE → 50s retry OPTIMAL sotto fake timers, fast-forward 105s → completa con `solved` + `lock_relaxed_to_soft` warning, watchdog NON fired. **NB**: F-W7-16 (multi-replica race con Redis lock) resta backlog separato. | (chiuso) | **CLOSED** |
| F-W8-06 | **MED → CLOSED 2026-05-22 (Opt 2 in Wave 8, Opt 1 Wave 9 backlog)** | L8 (hard-lock + INFEASIBLE retry: piano consolidato si sposta) | `src/routes/api/apply-whatif.ts` (BFF Opt 2 landed) + UI banner pending w8-multi-intent-tester | **FIX LANDED da w8-infeasible-recovery (Opt 2)**. Lead ha deciso Opt 2 per Wave 8 + Opt 1 trackato in `docs/to_do/feature_gaps.md` come `backend-frozen-lock-mode-hint` per Wave 9. BFF emette `lock_relaxing` SSE event con `recompute_mode: 'full_plan_from_scratch'` + `solved.warnings` include `lock_relaxed_to_soft__plan_recomputed_from_scratch` accanto al legacy `lock_relaxed_to_soft` (additivo, no breaking). UI banner rosso esplicito ownership passa a w8-multi-intent-tester (SolutionDiff) in scope task #3 — già notificato. Telemetry "p<5% / p>20%" di INFEASIBLE retry attesa da Task #4 stress per guidare migrazione Wave 9 Opt 1. | (chiuso Opt 2 BFF + UI in landing) | **CLOSED Wave 8 + backlog Wave 9** |
| F-W8-07 | **MED → CLOSED 2026-05-23 (mock verified, BFF warning deferred Wave 9)** | L4 (stress mock: confidence low + dangerous rules) | `scripts/wave7-stress-mock.ts` (cycles 51, 52) + `docs/to_do/feature_gaps.md:bff-low-confidence-warning` | Task #4 descrive scenari mock con confidence high/medium/low. Edge case **non coperto esplicitamente** dalla task: confidence=low + intent dangerous (es. `unavailable_machines` su M01 che blocca 60% di capacita totale). Il router corrente (`strategy-router.ts:355-440`) non filtra per confidence — passa l'intent come-is al solver. Mock test deve verificare: (a) intent con confidence=low E entities incomplete (es. start_min missing) → router cascade su C (Opus), non su unsupported. (b) confidence=low + intent ben-formed → router fallisce silenziosamente, il manager vede "constraint applicato" senza warning sul rischio classification. Non è bug del codice attuale ma è una metrica importante per il prossimo gate B2B. | (a) Mock test "confidence_low_with_incomplete_entities" + assert router emette warning. (b) Mock test "confidence_low_with_complete_entities" + assert NUOVO warning "low_confidence_classification" che il BFF deve emettere (modifica minor in apply-whatif.ts: se `parsed.intent.confidence === 'low'` → push `low_confidence_classification` in wave7Warnings). | open — DM a w8-stress-engineer + w8-multi-intent-tester |
| F-W8-08 | **MED → CLOSED 2026-05-23 (p50/p95/p99 + diverse-slugs landed; cost over cap surface B-W8-S-04 new HIGH)** | L6 (cost monitoring post-Wave-8 < $0.10/click) | `scripts/wave7-stress-evals.ts --diverse-slugs` + `docs/wave8-stress-report.md:161-170` | I dati esistenti mostrano cost/cycle in range `$0.0009 - $0.0059` con cache warm (cycle 0 senza cache = $0.0059, cycle 1+ con cache hit = $0.0009). Target Plan Wave 7 §6 = "$0.10/click". GREEN. **MA**: il dato e' su `wave7-integration.ts` (10 cicli back-to-back stesso slug) — cache hit-rate quasi 100% per intent-parser. In produzione **multi-tenant**, ogni slug nuovo paga $0.0059 sul primo apply. Se il pilot The Gelatist scala a 50 manager su 50 slug, il primo apply di ognuno è $0.0059 → totale $0.29 per onboarding (sotto $0.10 per-click ma il "per-click p99" sale a $0.0059). Wave 8 deve aggiungere monitoraggio `cost_p99_per_click` non solo `cost_avg`. F-W8-08 è osservativo, non bug. | (a) Aggiungere a `wave7-integration.ts` reporting p50/p95/p99 di cost_usd per cycle. (b) Stress test Task #4 deve avere `--diverse-slugs` mode che disabilita cache cross-cycle. (c) Documentare in scheda-prodotto-non-tecnica.md il costo cold-start vs warm. | open — DM a w8-stress-engineer |
| F-W8-10 | **HIGH (tracking-only, mirrors B-W8-S-04)** | L4-bis (Opus cascade scope su Haiku unknown) | `src/routes/api/apply-whatif.ts` + `src/server/llm/strategy-router.ts` (Task #6 in_progress) | **Adversarial observation sul fix B-W8-S-04 di Task #6**: w8-stress-engineer propone short-circuit `intent_id="unknown" + confidence=high` → `aborted_unsupported` (skip Opus translator). Il fix è corretto MA il discriminator deve essere **`confidence === 'high' SOLO`**, NON `confidence !== 'low'`. Edge case da NON regredire: `intent_id="unknown" + confidence=medium` deve ancora cascadeare a Opus (Haiku non sicuro, Opus può rifinire). Inoltre: il fix deve preservare il caso `intent_id !== 'unknown' + confidence=high + entities-incomplete` (router già cascade su C, atteso). Unit test richiesto: `routeIntent({intent_id:'unknown', confidence:'medium'}) → kind === 'opus_translator'`, no short-circuit. + verifica regression cost real solo su `unknown HIGH` (cycle 11/12/13 stress evals). | (a) Task #6 deve implementare `if (parsed.intent.intent_id === 'unknown' && parsed.intent.confidence === 'high') { write('aborted_unsupported', ...); return; }` PRIMA della chiamata a `routeIntent` o nello strategy-router caso `kind: opus_translator` con check explicit. (b) Test simmetrico: confidence=medium NON deve essere short-circuited. (c) Cost regression test in stress evals: post-fix mean cost <= $0.02. | open — Task #6 in_progress (B-W8-S-04 owner) |
| F-W8-09 | **CRITICAL → CLOSED 2026-05-22** | L8 (lock layer engagement) | `src/server/llm/frozen-window-builder.ts:106-116` (post-fix) | **OFF-BY-ONE `seq` IN BFF — silent no-op del lock layer Wave 7. FIX LANDED + VERIFIED LIVE.** w8-infeasible-recovery ha visto durante live verification: BFF spedisce `frozen_phases.length = 19` ma backend ritorna `locked_count: 0`. **Causa root (verificata live)**: `frozen-window-builder.ts:96` emette `seq` come 0-based array index (`for (let seq = 0; seq < fasiRaw.length; seq++)`). Il backend `fjsp.py:713-715` costruisce `job_ops[jid].append((op["sequenza"], ...))` usando il campo `sequenza` dei dati (tipicamente 1-based, p.es. OP-1→1, OP-2→2). `alternatives[jid, seq]` (riga 851) è quindi keyato sul VALORE `sequenza`, non sull'indice array. La lookup `fjsp.py:1466` `key = (jid, seq)` e check `if key not in alternatives` (riga 1467) **fallisce per OGNI frozen_phase emesso dal BFF** quando il fixture usa sequenza 1-based. Risultato: `frozen_phase_skipped reason="(job_id, seq) not in current alternatives"` per tutto. **REPRODUZIONE LIVE 2026-05-22**: ho fatto 2 curl diretti al backend `localhost:8001/api/public/solve-template` con frozen_phases identiche, solo diverso `seq`: (1) `seq:1` → `locked_count: 2` + entry `frozen_phase_locked`. (2) `seq:0` → `locked_count: 0` + entry `frozen_phase_skipped` con reason esplicito "(job_id, seq) not in current alternatives". **CONSEGUENZA**: tutto il Wave 7 hard-lock Plan §2 D2 ("produzione invariante") è non-engaged in produzione. F-W7-02 INFEASIBLE retry path è morto-codice (non può INFEASIBLE se il lock non lock-a). Test e2e Wave 7 Test 1 ASSERT 2 ("every pre-cutoff baseline phase is locked") **passa per il caso degenere `preCutoff.length === 0`** quando `effectiveCutoff === 30` (default UI + 30 cushion = 30 → nessuna fase pre-cutoff a min 30). | (a) **Fix BFF `frozen-window-builder.ts:96-122`**: leggere `seq` dal campo `sequenza` (preferred) o `seq` o `operazione_seq` della fase, NON dall'indice array. Se assente, fallback a `idx+1` con `_diag_logger.warning` (1-based). Aggiungere unit test `frozen-window-builder.test.ts` con fixture sequenza 1-based + 3-based gap + assert `out[0].seq === 1` not `0`. (b) **Fix BACKEND (defence-in-depth)** `fjsp.py:1466`: se `(jid, seq)` not in `alternatives` ma `(jid, seq-1)` o `(jid, seq+1)` esistono, log un warning specifico "possible 0-based vs 1-based seq mismatch — caller bug, retry with shifted seq" e tentare match con `seq+1`. Non auto-fix silenzioso. (c) **Regression test e2e**: Test 1 deve fallire se `locked_count === 0` AND `baselinePreCutoff.length > 0` con messaggio "BFF non sta inviando seq nel formato che il backend riconosce — F-W8-09 regression". | **CLOSED** (w8-infeasible-recovery, verified live by w8-devils-advocate 2026-05-22) |

## Lenti coperte (sessione iniziale)

| Lente # | Lente | Finding correlato | Note |
|---|---|---|---|
| L1 | Test 3 fix `captureApplySolvedPayload` copre edge case live? | F-W8-03 | Helper batched, perde streaming UX; mock previsto non implementato per Test 3 |
| L2 | F-W7-02 retry: Annulla durante retry → stato consistente? | F-W8-04 | UI lockRelaxed permanente, abort timing-sensitive 60s stall |
| L3 | capacity_addition + shift_window backend consumer? | F-W8-01 | **CRITICAL** — passthrough no-op, Task #3 green vacuo |
| L4 | Stress mock confidence low + rules dangerous? | F-W8-07 | Mock test mancante per confidence_low + warning UI |
| L5 | Stress evals 15 scenari bias well-formedness? | F-W8-02 | **CRITICAL** — eval set deve essere disjoint dal catalog examples |
| L6 | Cost monitor post-Wave-8 < $0.10/click? | F-W8-08 | GREEN su warm cache; cold-start p99 non monitorato |
| L7 | Multi-tenant: 2 manager apply-whatif concurrent → race? | F-W8-05 | Watchdog 90s troppo corto per retry (max 150s) |
| L8 | Hard-lock + INFEASIBLE retry: piani strani? | F-W8-06 | Retry libera TUTTE le fasi, anche consolidate; UX confusa |

## Append-only log

### 2026-05-22 — sessione iniziale (claim task #5)

- Claim task #5 (`w8-devils-advocate`), set in_progress.
- Verificato repo state: `feat/wave7-real-effect`, HEAD `9c81a9c` ("fix(wave7-tests): gg convention bug + backend-only smoke script"). Dirty tree solo su 2 JSON di results (atteso).
- Letto `docs/wave7-adversary-findings.md` (precedente, 145 righe, verdict CONDITIONAL → poi GO dopo task #14-#18).
- Letto Plan Wave 7 (`docs/wave7-plan-real-effect.md`, 372 righe) per context.
- Esplorato `tests/e2e/wave7-real-effect.spec.ts` (639 righe, 6 test) — Test 3 deadline_change live, Test 4 skipped per F-W7-02 (pendente), Test 5 unknown machine, Test 6 cushion +1h.
- Letto `src/routes/api/apply-whatif.ts` (730 righe) — INFEASIBLE retry esiste (linee 587-627), per-slug lock esiste (linee 162, 269-275), watchdog 90s esiste (linee 322-344).
- Letto `daino/templates/fjsp_constraints/f_apply_rules.py` (307 righe) — **scoperta CRITICAL**: extra_capacity + shift_changes sono dichiarati come "DATA-LAYER PASSTHROUGH" (linee 39-46, 271-290). Nessun CP-SAT consumer per questi due slot.
- Letto `src/server/llm/data-modifier.ts` (121 righe) — **scoperta CRITICAL conferma**: SUPPORTED_INTENTS = `['deadline_change']` (linea 56). `capacity_addition` e `shift_window` NON sono handler. Strategy router cade su rule_addition → backend riceve rules.extra_capacity / rules.shift_changes → passthrough no-op → KPI plan invariato. F-W8-01.
- Letto `src/server/llm/strategy-router.ts:298-340` — buildRulesPayload per `extra_capacity` e `shift_changes` esiste ma il backend non lo consuma. F-W8-01 conferma.
- Letto `src/server/llm/intent-parser.ts:170-209` — 5 example completi nel prompt, identici agli example del catalog YAML. F-W8-02 (well-formedness bias) inferito.
- Letto `src/components/dashboard/WhatIfAnalysis.tsx:135-330` — cushion preset state, derive cutoff params, runApplyWhatIf flow. Nessun reset di `lockRelaxed` su `resetApplyState`. F-W8-04 conferma stato UI permanente.
- Letto `src/routes/api/__tests__/apply-whatif-wave7.test.ts:398-489` — F-W7-02 unit test esiste (mock 2 fetch INFEASIBLE → OPTIMAL). Non copre abort-during-retry. F-W8-04 conferma.

### 2026-05-22 — verifica live (grep + curl)

- `grep -rn extra_capacity daino/templates/` → solo `f_apply_rules.py:_apply_data_layer_passthrough` (no CP-SAT consumer) + `fjsp.py:1190` (label per logging). Conferma F-W8-01.
- `grep -rn "data\.operators\|operator_config" daino/templates/fjsp.py` → solo lettura, mai scrittura da rules. Conferma F-W8-01: `data["operators"]` non viene esteso da `rules.extra_capacity`.
- `scripts/wave7-integration-results.json`: 10 cicli, cost_avg ~$0.001 (warm cache), cost cold ~$0.006 (cycle 0). Target $0.10 GREEN. F-W8-08.

### DM inviati (usati 5/6, 1 trattenuto per round 2)

1. **w8-multi-intent-tester** — F-W8-01 CRITICAL (Task #3 green vacuo se non si fixa data-modifier o catalog).
2. **team-lead** — verdict NO-GO + summary F-W8-01 + F-W8-02 CRITICAL + raccomandazione opzione C (catalog `not_implemented`).
3. **w8-stress-engineer** — F-W8-02 CRITICAL (eval set deve essere disjoint da catalog examples) + F-W8-07 + F-W8-08.
4. **w8-test-infra-fixer** — F-W8-03 (Test 3 deve essere mock-only secondo spec task #1).
5. **w8-infeasible-recovery** — F-W8-04 (abort during retry) + F-W8-05 (watchdog 90s troppo corto per retry) + F-W8-06 (retry libera consolidato).

### 2026-05-22 — round 2 (audit Task #2 deliverable)

- Verificato `src/routes/api/__tests__/apply-whatif-wave7-infeasible.test.ts` (430 righe, 5 cases). Cases coperti: (1) entrambi INFEASIBLE, (2) OPTIMAL no-retry, (3) backend timeout durante retry, (4) retry cap max 1. **NON copre F-W8-04** (client abort durante retry timing-race). w8-infeasible-recovery DM include richiesta esplicita di aggiungere case 6.
- Verificato UI `WhatIfAnalysis.tsx`: `setLockRelaxed(false)` ESISTE in `resetApplyState` (riga 209) e `runApplyWhatIf` (riga 328) — corretto. F-W8-04 edge case "UI state permanente" annullato; resta solo edge case timing BFF.
- Task #2 marked completed dal team-lead (timestamp post my finding-doc creation). Mio finding F-W8-04 resta aperto perché il bug è isolato al BFF abort timing.

### Verdict aggregato post-round-2 (2026-05-22)

- **CRITICAL**: 2 aperti (F-W8-01, F-W8-02). F-W8-01 deve essere chiuso PRIMA che Task #3 inizi. F-W8-02 deve essere chiuso PRIMA che Task #4 inizi.
- **HIGH**: 4 aperti (F-W8-03 Test 3 fix, F-W8-04 abort during retry, F-W8-05 watchdog short).
- **MED**: 3 aperti (F-W8-06 retry libera consolidato, F-W8-07 confidence low warning mancante, F-W8-08 cost p99 cold-start).
- Verdict: **NO-GO** finché F-W8-01 + F-W8-02 non chiusi.
- Restano blocked Task #3 (su #1, #2) — può iniziare ora che #2 è done, ma F-W8-01 impedisce un valid green sui 2 intent non implementati.

### 2026-05-22 — round 3 (ack team-lead + multi-intent-tester)

- Team-lead ha accettato Opzione C per F-W8-01: w8-infeasible-recovery riceve come extra scope la modifica catalog YAML (`strategy: not_implemented`) + strategy-router fa emit `unsupported` per capacity_addition + shift_window. w8-multi-intent-tester testa il toast unsupported invece di assertion sul piano.
- w8-multi-intent-tester ha confermato la diagnosi indipendentemente (aveva visto `_apply_data_layer_passthrough` e `SUPPORTED_INTENTS = ['deadline_change']` durante la lettura del codice). Buon segnale di consistenza.
- F-W8-01 status: **in resolution path** (atteso da w8-infeasible-recovery, blocca Task #3). Non più CRITICAL aperto per Task #3 se la fix lands.
- Resta CRITICAL F-W8-02 — atteso ack di w8-stress-engineer.

### 2026-05-23 — round 12 (consolidated verdict: 9/9 findings CLOSED + B-W8-S-04 acknowledged + Wave 9 backlog)

- Task #3 (multi-intent) e Task #4 (stress) completati. Audit dei deliverable:
  - **F-W8-01 CLOSED**: `docs/wave8-multi-intent-test-report.md` rispetta R1 (Result column tagged `(honest_unsupported)` vs `(full_effect)`), R2 (tabella `catalog_present`/`router_classified`/`solver_consumes` sopra la principale), R3 (5 unit test invariante in `strategy-router.test.ts`: 2 F-W8-01 esistenti + 3 simmetrici negativi `deadline_change`/`machine_unavailability`/`order_priority`). 3/3 e2e PASS, 22/22 unit PASS.
  - **F-W8-02 CLOSED**: `docs/wave8-stress-report.md` §2 rispetta tutta la mia spec: scenari DISJOINT da catalog YAML, 10 well-formed + 5 adversarial coprenti i 5 sub-categories canonici (dialect, ambiguous ref, multi-intent, negation, typo), DOUBLE METRIC reported separately (well-formed 10/10, adversarial 4/5), `expected_intent_ids` annotato a priori per evitare grading bias. Threshold ≥80% PASSED su entrambe le metriche.
  - **F-W8-07 CLOSED**: mock cycles 51/52 verified working (low_conf_incomplete → C, low_conf_complete → B). BFF warning `low_confidence_classification` deferred a Wave 9 (`docs/to_do/feature_gaps.md:bff-low-confidence-warning`) — team-lead decision MED severity, non blocca Wave 8 GO.
  - **F-W8-08 CLOSED**: p50/p95/p99 cost reported ($0.00086/$0.25486/$0.25486). `--diverse-slugs` flag landed (5-pool rotation). MA: cost mean $0.0624 over target $0.05 — root cause è **B-W8-S-04 nuovo HIGH** (vedi sotto).
- **B-W8-S-04 (NUOVO HIGH)** scoperto da w8-stress-engineer durante eval run: quando Haiku returns `intent_id="unknown" + confidence=high`, il router cascade su Opus translator (~$0.20/call) anche se la classification è già onesta. 4 adversarial cycles → $0.80 di Opus tax. **Fix one-liner in `apply-whatif.ts` o `strategy-router.ts`**: short-circuit `unknown HIGH` direttamente a `aborted_unsupported`. Task #6 in_progress.
- **Adversarial perspective mio su B-W8-S-04**: il finding è solido + il fix proposto è scoped correttamente. MA serve attenzione su un'EDGE CASE: cosa succede con `intent_id="unknown" + confidence=medium`? Probabilmente DEVE ancora cascadeare a Opus (Haiku non sicuro, Opus può rifinire). Il discriminator è `confidence === 'high'` SOLO. Aggiungo F-W8-10 in tabella per documentare la mia osservazione.
- **B-W8-S-05** Haiku dialect robustness (`adv_dialect` "Sta camola...") tracked come MED da w8-stress-engineer, fix prompt-level Wave 9. NON blocca Wave 8 GO.
- **B-W8-S-01 partial** + **B-W8-S-02 open**: w7-intent-parser owns, Wave 9 backlog. Cost-side fix di B-W8-S-01 verificato (250x Opus tax removed).
- **F-W8-09 reg test SKIPPED** in eval run per cost cap, ma fix verified live da me in round 8 con curl diretto — `locked_count: 5` reproducible. Re-run da w8-stress-engineer raccomandato post B-W8-S-04 fix.

### Verdict aggregato finale Wave 8 (round 12, 2026-05-23)

**9 findings devils**:
| Severity | Closed | Open | Wave 9 backlog |
|---|---|---|---|
| CRITICAL | 3 (F-W8-01, F-W8-02, F-W8-09) | 0 | — |
| HIGH | 3 (F-W8-03, F-W8-04, F-W8-05) | 0 (F-W8-10 nuovo, tracking-only) | F-W8-10 |
| MED | 4 (F-W8-06, F-W8-07, F-W8-08) | 0 | F-W8-06 Opt 1 cross-cutting |

**Bug surface w8-stress-engineer (orthogonale ai miei devils findings)**:
- B-W8-S-01 partial (Wave 9)
- B-W8-S-02 open (Wave 9)
- B-W8-S-03 not-a-bug (product call)
- B-W8-S-04 HIGH (Task #6 in_progress, blocks cost target Wave 8 GO if not fixed)
- B-W8-S-05 MED (Haiku dialect, Wave 9)

**VERDICT FINALE**: 
- **GO conditional su Task #6 (B-W8-S-04)** — la chiusura del cost target $0.05/cycle dipende dal fix one-liner di short-circuit Opus cascade su `unknown HIGH`. Il fix è scoped, low-risk, atteso < 1h. Senza fix, cost target è RED ma il sistema è funzionalmente OK.
- **TUTTI gli altri target GREEN**: 100% intent correct su well-formed, 80% adversarial unknown, 100% strategy correct, 90% constraint respected, 0% error rate, lock layer engaging, INFEASIBLE retry working, abort timing safe, multi-tenant slug-lock safe, multi-intent honest unsupported, F-W8-06 Opt 2 + UI banner landed.

**Mia raccomandazione team-lead**: chiudere Wave 8 dopo merge Task #6 (B-W8-S-04 fix). Wave 9 backlog ben tracked in `docs/to_do/feature_gaps.md` (bff-low-confidence-warning, backend-frozen-lock-mode-hint, haiku-prompt-gg-default-whole-day, b-w8-s-05 dialect robustness, F-W8-extension capacity+shift CP-SAT consumers).

### 2026-05-23 — round 11 (F-W8-03 (c) fix landed → fully CLOSED)

- w8-test-infra-fixer ha LANDED il fix (c) race + error classifier. Verificato via grep:
  - `LiveCaptureError extends Error` class definita a `wave7-real-effect.spec.ts:413`
  - `page.route('**/api/apply-whatif', handler)` a riga 459 + `page.unroute('**/api/apply-whatif', handler)` in `finally` a riga 472 (signature 2-arg, handler-specific)
  - Transport fail → `code='capture_failed'` a riga 445, 453
  - Anthropic overload → `code='anthropic_overload'` a riga 494-495
  - Esportata `LiveCaptureError` a riga 1387 (downstream import Test 1+2)
- Pattern simmetrico applicato anche a `setupWhatifMock` (riga 688-691) e `setupApplyMock` (riga 733-738) — consistent unroute with handler ref.
- Test 3/4/5/6 PASS in 5.8-6.0s con backend `:8001` DOWN (verifica empirica w8-test-infra-fixer).
- F-W8-03 status: **CLOSED fully**.
- Task #1 e Task #4 marked completed da rispettivi owner.
- **Findings status post-round-11**:
  - **3 CRITICAL chiusi**: F-W8-01 ✅, F-W8-02 (TBD — Task #4 completed, devo auditare gli scripts), F-W8-09 ✅.
  - **3 HIGH chiusi**: F-W8-03 ✅, F-W8-04 ✅, F-W8-05 ✅.
  - **3 MED**: F-W8-06 ✅ (Opt 2 landed + Wave 9 backlog), F-W8-07 + F-W8-08 (TBD — Task #4 completed, devo auditare).

### 2026-05-23 — round 10 (F-W8-03 audit post-Task #1: 2/3 punti chiusi con context)

- Task #1 marked completed da w8-test-infra-fixer. Verificato file aggiornato `tests/e2e/wave7-real-effect.spec.ts` (1338 righe, 5 nuovi helper).
- w8-test-infra-fixer ha contestato 2/3 dei miei punti F-W8-03. Audit-back mio:
  - **(a) streaming UX**: ridimensionato a "context, not bug". Task #1 era stabilizzare body capture (Test 3 deterministico), non testare progressive rendering UI. Test ordering runtime richiede un test separato `page.locator + toHaveText` durante il click — appropriato per una task futura, non per Task #1.
  - **(b) Test 3 ancora live LLM**: **FALSO MIO**, ho letto codice obsoleto (riferimento `:473-515` non esiste più). Test 3 ora è completamente mockato a riga 1021-1095 con `setupBackendBootMocks` + `setupWhatifMock` + `setupApplyMock`. Verifica empirica w8-test-infra-fixer: Test 3 PASS in 6.1s con backend DOWN. Cancello il finding (b).
  - **(c) Race su page.unroute**: VALIDO. w8-test-infra-fixer include il fix nel cleanup post-Task #1: `try/finally` con handler-specific `page.unroute(pattern, handler)` + error classifier per distinguere `rate_limited / capture_failed / aborted`.
- F-W8-03 doc updated: HIGH → partial-CLOSED. (a)+(b) closed con context, (c) in-flight da w8-test-infra-fixer cleanup. Quando (c) lands → F-W8-03 fully CLOSED.
- **Lesson learned mio**: prima di un audit di un file modificato, ri-leggere il codice attuale invece di assumere il pattern pre-fix. Memoria DAINO `feedback_verify_before_declaring_bug` rispettata da w8-test-infra-fixer, NON da me su F-W8-03 (b). Auto-correzione pubblica nel doc.

### 2026-05-22 — round 9 (w8-infeasible-recovery scope completo CLOSED + F-W8-06 Opt 2 landato)

- w8-infeasible-recovery ha confermato standing down: tutto il suo scope è chiuso, Task #2 marked completed.
- **F-W8-06 (MED) → CLOSED**: lead ha deciso **Opt 2 per Wave 8** (UI banner rosso + warning più chiaro), **Opt 1 trackato in `docs/to_do/feature_gaps.md` come `backend-frozen-lock-mode-hint` per Wave 9**. La mia raccomandazione (Opt 2-now / Opt 1-later) ha coinciso con la decision. Implementazione BFF landed da w8-infeasible-recovery:
  - `lock_relaxing` SSE event include `recompute_mode: 'full_plan_from_scratch'`.
  - `solved.warnings` include `lock_relaxed_to_soft__plan_recomputed_from_scratch` accanto al legacy `lock_relaxed_to_soft` (additivo, no breaking).
  - UI banner rosso ownership passa a w8-multi-intent-tester (SolutionDiff) — già notificato in scope task #3.
- Status finale scope w8-infeasible-recovery: F-W7-02 ✅ + F-W8-01 (estensione catalog `not_implemented`) ✅ + F-W8-04 ✅ + F-W8-05 ✅ + F-W8-09 ✅ + F-W8-06 Opt 2 ✅ + B-W8-S-01 ✅. B-W8-S-02 declined-with-rationale (Haiku prompt-level fix, non router) trackato come Wave 9 `haiku-prompt-gg-default-whole-day` da lead.
- Test totali: 110 passing / 7 skipped (Haiku integration env-gated) / 0 failed.
- Aspetto telemetry "p<5% / p>20%" di INFEASIBLE retry da Task #4 stress per guidare decision Wave 9 sulla migrazione Opt 1.

### 2026-05-22 — round 8 (F-W8-09 CLOSED + live verification)

- w8-infeasible-recovery ha LANDED fix per F-W8-09 in `frontend-industriale/src/server/llm/frozen-window-builder.ts:106-116`.
- Pattern fix: loop var rinominata `seq → idx`. Output `seq` derivato da `fase.sequenza ?? fase.seq` quando finite + > 0, altrimenti `idx + 1` (positional 1-based per match con backend `enumerate(fasi, start=1)` a `fjsp.py:1978`).
- Edge case `sequenza: 0` trattato come missing (defensive — un caller potrebbe serializzare 0-based per errore, fallback a `idx+1`).
- BaselineFase typed con `sequenza?` + `seq?` (no `as any`).
- **AUDIT MIO POST-FIX**: letto file diretto, fix corretto e ben commentato con riferimento esplicito a fjsp.py:715, 1978 e F-W8-09.
- **VERIFICA LIVE MIA POST-FIX** (5 frozen_phases M02 con `seq:1`, cutoff_min:660):
  - `locked_count: 5` (vs 0 pre-fix).
  - Tutti gli entry sono `frozen_phase_locked` (no più `frozen_phase_skipped`).
  - **Bonus**: con 5 lock M02 + scheduling delle altre operazioni, backend risponde `status: INFEASIBLE` — questo è il segnale che il path INFEASIBLE retry F-W7-02 ora ha un trigger reale in produzione.
- **Test aggiunti** in `frozen-window-builder.test.ts` (+4 cases F-W8-09 specifici) + existing test assertions updated da `seq: 0/1` a `seq: 1/2` (i test pre-fix enshrinevano il bug — ora corretti con commento F-W8-09). `apply-whatif-wave7.test.ts:377` assertion aggiornata.
- Full suite verde: 103 passed / 7 skipped / 0 failed.
- F-W8-09 status: **CLOSED**.
- Conseguenza positiva: F-W7-02 INFEASIBLE retry implementato da w8-infeasible-recovery in task #2 ora ha use case reale invece di essere dead code. Il budget speso sui test non è più "premature".

### 2026-05-22 — round 7 (F-W8-04 + F-W8-05 fix audit + F-W8-06 escalation owned)

- w8-infeasible-recovery ha LANDED fix per F-W8-04 + F-W8-05 in task #2 extension. Verificato:
  - **F-W8-04 CLOSED**: helper `raceWithTimeout<T>(work)` estratto a `apply-whatif.ts:571-588` con triple-guard (entry sync check + addEventListener + post-listener re-check). Belt-and-braces post-`lock_relaxing` check a riga 629-631. Applicato a ENTRAMBI first solve + retry (linee 590-599, 632-641) — non più asimmetrico. Test 52ms (vs 60000ms pre-fix) prova diretta del fix.
  - **F-W8-05 CLOSED**: `WATCHDOG_MS = SOLVE_TIMEOUT_MS * 2 + 30_000 = 150_000` (riga 326), commento ben documentato. Test esistente aggiornato (151_000 invece di 91_000) + nuovo case fake-timer.
  - Full suite: 99 passed / 7 skipped (Haiku integration env-gated) / 0 failed.
  - Conferma w8-infeasible-recovery: `setLockRelaxed(false)` in `resetApplyState` GIA' presente alle righe 209 + 328. F-W8-04 edge case "UI sticky" annullato come avevo già notato in round 2 audit.
- F-W8-06 (MED) escalation: w8-infeasible-recovery ha chiesto a me di gestire l'escalation con team-lead. ACCETTATO. Nel prossimo update consolidato includerò:
  - F-W8-06 ha 2 opzioni: Opt 1 backend `frozen_lock_mode: hard|hint` (cross-cutting cost ≠ 0), Opt 2 UX banner rosso + warning più chiaro (BFF zero, UI-only).
  - **Decision frame**: F-W8-09 (lock layer off-by-one) cambia la priorità — finché F-W8-09 non fixed, F-W8-06 è dormant (lock non engage mai → INFEASIBLE retry mai triggered → "fallback soft" mai esercitato).
  - Raccomandazione mia: Opt 2 per Wave 8 (patch UX honest-but-loud), Opt 1 come Wave 9 task per "produzione invariante" production-grade.
- Findings status update:
  - **3 CRITICAL**: F-W8-01 (closed pending e2e), F-W8-02 (aperto, atteso w8-stress-engineer ack), **F-W8-09 (CRITICAL aperto, priorità #1)**.
  - **3 HIGH**: F-W8-03 (aperto), F-W8-04 (**CLOSED**), F-W8-05 (**CLOSED**).
  - **3 MED**: F-W8-06 (aperto, escalation in flight), F-W8-07 (aperto), F-W8-08 (aperto, osservativo).

### 2026-05-22 — round 6 (R3 layered tests already in flight + F-W8-01 risoluzione in landing)

- w8-multi-intent-tester ha confermato: i 2 unit di Layer 1 (F-W8-01 invariante `routeIntent({capacity_addition})→unsupported` + `routeIntent({shift_window})→unsupported` con warning `not_implemented:*`) sono **GIA' SCRITTI** da w8-infeasible-recovery come parte estensione task #2 in `src/server/llm/__tests__/strategy-router.test.ts` (linee 171, 188).
- w8-multi-intent-tester aggiunge in task #3 i 2 test simmetrici negativi (mio bonus R3-deep): `deadline_change` NON marked unsupported + `machine_unavailability` NON marked unsupported. Isolano "not_implemented" ai 2 intent specifici evitando side-effect su tutto catalog. OK come scope task #3 — non serve task separato.
- R1 attenuato (formato `pass (asserts_honest_unsupported)` vs `pass (full_effect)` accettato).
- R2 mantenuto (tabella 3-colonne stato implementazione `catalog_present`/`router_classified`/`solver_consumes` sopra la principale del report).
- F-W8-01 status: **implementazione + Layer 1 unit landed in `strategy-router.test.ts:171,188`** (w8-infeasible-recovery via estensione task #2). Catalog YAML + strategy-router fix sono LANDED. Atteso landing report task #3 + Layer 2 e2e per chiusura completa.
- F-W8-01 verdict: **risoluzione in landing**, downgrade da CRITICAL aperto a CRITICAL closed-pending-e2e-verify. **Non più bloccante per task #3** (i 2 unit Layer 1 garantiscono invariante).

### 2026-05-22 — round 5 (F-W8-09 CRITICAL: off-by-one seq lock layer no-op)

- w8-infeasible-recovery DM con finding: `locked_count: 0` nonostante `frozen_count: 19` in 3 probe consecutive live.
- Investigato il path BFF→backend per il `seq` field:
  - `frontend-industriale/src/server/llm/frozen-window-builder.ts:96` → `seq = 0-based array index`.
  - `daino-backend-definitivo/daino/templates/fjsp.py:713-715` → `job_ops[jid].append((op["sequenza"], op_type))` legge il campo `sequenza` dei dati.
  - `daino/templates/fjsp.py:800` → `for seq, op_type in job_ops[jid]:` itera valori `sequenza`.
  - `daino/templates/fjsp.py:851` → `alternatives[jid, seq] = alts` keya sul valore `sequenza`.
  - `daino/templates/fjsp.py:1466-1477` → frozen_phases lookup `if key not in alternatives` fallisce e skippa.
- **REPRODUZIONE LIVE** via 2 curl diretti al backend:
  - `seq:1` → `locked_count: 2` + entry `frozen_phase_locked`.
  - `seq:0` → `locked_count: 0` + entry `frozen_phase_skipped reason: "(job_id, seq) not in current alternatives"`.
- **CONSEGUENZA OPERATIVA**:
  1. Wave 7 hard-lock Plan §2 D2 "produzione invariante" è non-engaged in produzione live.
  2. F-W7-02 INFEASIBLE retry path è morto-codice — il lock non scatta MAI, non può causare INFEASIBLE da conflict.
  3. Test e2e Test 1 ASSERT 2 ("every pre-cutoff baseline phase is locked") passa vacuamente perché con UI default `currentTimeMin=0 + cushion=30 → effectiveCutoff=30`, la lista preCutoff baseline è vuota → assertion `lockViolations.length === 0` trivial. Verificato leggendo wave7-real-effect.spec.ts:368-389.
  4. Tutto il "real effect" di Wave 7 sul lock è un'illusione operativa identica a F-W7-01 ma su un'asse diversa (Wave 4.1 = rule no-op, Wave 7 = lock no-op).
- Aggiunto F-W8-09 CRITICAL al doc + DM team-lead + w8-infeasible-recovery + w7-bff-orchestrator.
- Verdict aggiornato: **NO-GO** con 3 CRITICAL (F-W8-01, F-W8-02, F-W8-09).

### 2026-05-22 — round 4 (pivot interim "transport-only" → Opzione C confermata)

- Team-lead aveva proposto temporaneamente una soluzione "TRANSPORT-ONLY" per capacity+shift (test verifica routed.strategy=B + apply_rules contiene `_data_layer_passthrough` ma NO assertion sul piano). Ho risposto con DM 3 rischi residui:
  - R1 framing "pass=funziona" leggibile da PM non-tecnico.
  - R2 blocco "Cosa NON testa questo" sopra la tabella nel report.
  - R3 probe diretto backend per regression bound.
- Team-lead ha PIVOTTATO a Opzione C originale (asserts UNSUPPORTED + toast UI, no solving event, no POST backend). Decisione consistente con la mia preferenza espressa nel DM iniziale a team-lead.
- w8-multi-intent-tester ha chiesto se vitest unit per "routeIntent({capacity_addition})→unsupported" è in scope task #3. Risposto: SI, **layered approach**:
  - Layer 1 unit `src/server/llm/__tests__/strategy-router.test.ts`: invariante deterministica seed-check (~50ms in CI). Test: `routeIntent({intent_id: 'capacity_addition', ...}) → outcome.kind === 'unsupported'` + reason matches `not_implemented`. Bonus test simmetrico negativo: `routeIntent({deadline_change}) → kind !== 'unsupported'` isola la regola not_implemented ai 2 intent.
  - Layer 2 e2e `tests/e2e/wave7-multi-intent.spec.ts`: comportamento Italian→backend→toast user-facing live LLM.
- R1 attenuato (asserts honest unsupported leggibile come "feature dichiarata non implementata"); R2 mantenuto al 100% — proposta tabella di stato implementazione con 3 colonne `catalog_present`/`router_classified`/`solver_consumes` sopra la tabella principale del report (per capacity+shift l'ultima colonna è ❌ con link a Wave 9/F-W8-extension); R3 adattato (no probe backend per intent unsupported, ma seed-check unit deterministico in CI).
- DM budget: 7 inviati (1 overspend per chiarimento operativo sulla layering del test, non un nuovo CRITICAL). Sospeso ulteriore DM fino a landing reale dei deliverable.

