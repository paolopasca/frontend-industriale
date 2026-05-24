# Wave 7 — Devil's Advocate Findings

> **Owner**: w7-devils-advocate (Opus 4.7, plan-mode)
> **Started**: 2026-05-22
> **Mandate**: 12-lens adversarial review of Wave 7 (real-effect: rules + frozen-window + intent parser + catalog).
> **Repos osservati**:
> - `frontend-industriale/` branch `feat/wave7-rules-and-frozen-window` (plan voleva `feat/wave7-real-effect` — meta-finding L0-1)
> - `daino-backend-definitivo/` branch `feat/wave7-rules-and-frozen-window` (anche qui plan voleva nome diverso)

## Verdict aggregato

**CONDITIONAL — pesa 1 CRITICAL + 3 HIGH che vanno chiusi prima di GO**

Il backend rule consumer (`f_apply_rules.py`) è scritto **correttamente**: la classe di vincoli `unavailable_machines`, `priority_orders`, `deadline_changes` viene tradotta in CP-SAT post `model.add(...)`. Il frozen-phases hard-lock branch di `fjsp.py:1407-1525` è anch'esso scritto correttamente con `model.add(start==X, end==Y, present==1)`. La route public extends `/api/public/solve-template` con `cutoff_min`, `frozen_phases`, `dataset_overrides` opzionali — backward-compat pulito.

MA: tre buchi grossi rimangono prima di poter dichiarare effettivo l'effetto:

1. **Il backend uvicorn live (PID 16378) gira ancora il codice pre-Wave-7** (avvio Thursday). I file modificati su disco non vengono importati finché nessuno riavvia il processo. Tutti i test live e e2e che dipendono dal backend OGGI girerebbero sulla vecchia logica → falsi positivi/negativi. **Il tester DEVE riavviare uvicorn prima di lanciare wave7-real-effect.spec.ts**, altrimenti i risultati non sono interpretabili.
2. **Il BFF apply-whatif route (`src/routes/api/apply-whatif.ts`) NON inietta ancora `frozen_phases`, `dataset_overrides`, `cutoff_min` nella chiamata a `resolveTemplate`**. Accetta `currentTimeMin`/`cushionMin` nel body (linee 51-61) ma poi al solve (linee 322-347) chiama `resolveTemplate(slug, problemType, tr.change.rules)` — esattamente come Wave 4.1. Task #16 in_progress: w7-bff-orchestrator deve ancora cablare intent-parser → strategy-router → frozen-window-builder. Fino a quel momento la pipeline e2e resta cosmetica.
3. **Il fixture `demo-commesse` usato dall'e2e wave7-real-effect.spec.ts ha tutte le 15 fasi M02 con `end_min <= 1437`**. La finestra di indisponibilità del test happy-path è `[2160, 2520]` (gg2 12:00 → 18:00). Il rule "M02 unavailable in [2160,2520]" è **tautologicamente soddisfatto** dalla baseline — Test 1 dell'e2e passa anche se il consumer è completamente rotto. Identico modus operandi del bug Wave 4.1 che la Wave 7 dovrebbe sanare.

Senza chiudere questi tre punti il "Real Effect" rimane un'illusione operativa.

## Tabella findings (per severità decrescente)

| ID | Severity | Lente | File:line | Descrizione | Fix proposto | Stato |
|---|---|---|---|---|---|---|
| F-W7-01 | **CRITICAL** | L8 (e2e effetto) | `tests/e2e/wave7-real-effect.spec.ts:223-312` | Test 1 happy-path "M2 rotta gg2 12:00" passa vacuamente sul fixture `demo-commesse`: tutte le 15 fasi M02 della baseline finiscono entro min 1437, la finestra unavail `[2160,2520]` è interamente post-orizzonte. L'assertion ASSERT 1 (`m02Inside.length === 0`) è soddisfatta SENZA che il backend imponga alcun vincolo. ASSERT 3 viene esplicitamente disabilitato dalle righe 302-308 quando `preCutoff.length === baselinePhases.length`, che è esattamente questo caso. La regressione che la Wave 4.1 aveva è **identica e ripetuta**. | Spostare il cutoff a `300` o `600` minuti (gg1 metà giornata) e bloccare M02 in `[600, 1200]` — la baseline ha 6 fasi M02 con start>600. Oppure usare un fixture con orizzonte più lungo (`demo-commesse-test-60` o `demo-commesse-test-300`). Aggiungere un'assertion difensiva: `expect(preCutoffM02.length, 'fixture must contain at least 1 M02 phase that the rule actually blocks').toBeGreaterThan(0)` prima di concludere green. | open — DM w7-tester |
| F-W7-02 | **HIGH** | L1 (hard-lock INFEASIBLE) | `src/routes/api/apply-whatif.ts:539-577` | Plan §2 D2: "lock duro + fallback soft se INFEASIBLE" con `warning: lock_relaxed_to_soft`. | Retry-without-frozen-phases nel BFF. | **FIXED + UNIT TESTED (2026-05-22, task #16)** — w7-bff-orchestrator ha implementato retry-on-infeasible (apply-whatif.ts:539-577) + test in `apply-whatif-wave7.test.ts` che verifica `lock_relaxing` event + `lock_relaxed_to_soft` warning + 2 fetch backend (con/senza frozen_phases). 16/16 route tests pass. Backend invariato (Plan D2 rispettato). |
| F-W7-03 | **HIGH** | L4 (rule effectively applied) | `daino/templates/fjsp.py:1771-1779` (post-fix) | Uvicorn stale + secondo bug: `fjsp.py:1761` short-circuit INFEASIBLE costruiva `infeasible_result` separato e returnava PRIMA di appendere `wave7_apply_rules`/`wave7_frozen_phases`. Caso più informativo (INFEASIBLE) era l'UNICO senza diagnostica. | Restart uvicorn + copiare append wave7_* anche nel branch INFEASIBLE. | **FULLY FIXED + LIVE VERIFIED (2026-05-22, task #14, commit bba231a)** — w7-backend-engineer ha (a) killato PID 16378 + restartato (nuovo PID 55587), (b) trovato e fixato il secondo bug nel branch INFEASIBLE (fjsp.py:1771-1779), (c) aggiunto regression test `test_apply_rules_log_reaches_caller_on_infeasible`. Live verification mia: full-block M02 → `status:INFEASIBLE` ma `wave7.apply_rules: [{type: "unavailable_machine_block", machine_id: "M02", start_min: 0, end_min: 38400}]` presente. Partial-block M02 [1320,1920] → `status:FEASIBLE`, 15 fasi M02 totali, 0 overlap con [1320,1920]. Rule consumer ora ha effetto reale. 19/19 wave7 tests pass. |
| F-W7-04 | **HIGH** | L12 (concurrent races) | `src/routes/api/apply-whatif.ts:156-314` | Lock per-IP non copriva same-slug cross-IP. Race su companies/<slug>/plans/history. | Lock per-slug parallelo. | **FIXED + UNIT TESTED (2026-05-22, task #16)** — w7-bff-orchestrator ha aggiunto `_inFlightBySlug` parallelo a `_inFlight` (IP). 409 `slug_conflict` ritornato quando slug già in-flight da diverso IP, cleanup a riga 314. Test verifica scenario two-IP-same-slug → 2° riceve 409. **NUOVO BACKLOG F-W7-16** per Redis-lock multi-replica vedi sotto. |
| F-W7-05 | **HIGH** | L8 (e2e effetto, soft-fail) | `tests/e2e/wave7-real-effect.spec.ts:231, 242, 322, 331, 368, 377, 405, 425, 443` | I test usano `test.skip(!healthy, ...)` su quasi ogni step Opus call: 529 da Anthropic = silent skip, non failure. In CI un outage Anthropic = wave 7 e2e "verde". Inoltre `test.skip(solved === null, 'translator likely classified as unsupported')` (Test 2 riga 331, Test 3 riga 377): se il translator non riconosce lo scenario (bug del traduttore!) il test si autoesime. Spinning di scope: il test "valida l'effetto" diventa "valida il flow se il flow non si rompe". | Trasformare gli `skip` per `solved === null` in `expect.fail()` con messaggio chiaro. Mantenere skip solo per 529 esterni Anthropic (con annotation). Aggiungere asserzione difensiva all'inizio: `expect(translatorChange.type).not.toBe('unsupported')` per Test 1/2/3. | open — DM w7-tester |
| F-W7-06 | **HIGH** | L3 (hallucination Haiku) | `src/server/llm/intent-parser.ts:134-160` + `catalog/constraint-catalog.yaml:38-49` | Inconsistenza nelle convenzioni temporali. | (a) Allineare prompt + catalog. (b) Integration test live Haiku. | **FULLY FIXED (2026-05-22)** — Regola temporale unificata (intent-parser.ts:134-157) + 6 integration test live Haiku PASS (gated INTENT_PARSER_HAIKU_LIVE=1). Residuo F-W7-06b catturato e successivamente chiuso. |
| F-W7-06b | **MED** | L3 (residuo F-W7-06) | `src/server/llm/intent-parser.ts:178, 184` (post-fix) | Due few-shot non allineati: riga 178 ancora 2880, riga 184 ancora 360. | (a) Riga 178 → 2520. (b) Riga 184 → 420. (c) Tightening test #5. | **FULLY FIXED (2026-05-22)** — Verificato sorgente: intent-parser.ts:178=`new_deadline_min:2520`, :184=`start_min:420`. Test discrimination tightened: test #5 range narrowed [400, 440] (`intent-parser-haiku.integration.test.ts:93-94`), NEW test #7 deadline_change "fine giornata di domani" range [2400, 2640] esclude 2880 esplicitamente. 7/7 Haiku live PASS, ~$0.06 cumulativo (80% del cap $0.075). 73/73 mock unit pass + tsc clean. |
| F-W7-07 | **MED** | L7 (localStorage cushion) | `src/components/dashboard/WhatIfAnalysis.tsx:135` | Il selettore cutoff (`cushionPreset`) usa `useState(30)` senza persistenza. Refresh della pagina → torna a +30min default. Manager che ha appena selezionato "+1h" perde la scelta dopo F5. Non è un bug critico ma è una scelta che il manager pagherebbe rifare ogni volta. | Wrap `useState` in custom hook `useLocalStorageState('whatif:cushion', 30)` che persiste su localStorage. Schema versionato (key `v1`) per evolvere senza rompere user state esistente. | open — DM w7-ui-cutoff-diff |
| F-W7-08 | **MED** | L5 (Strategy A visibility) | `src/routes/api/apply-whatif.ts:126-150, 613` + `src/components/dashboard/SolutionDiff.tsx:252-619` | Quando router sceglie Strategy A, manager non sapeva che il dataset era stato modificato. | BFF emette `dataset_overrides_summary` plain-text via SSE solved; UI lo rende. | **FULLY FIXED (2026-05-22, task #16 + #17)** — BFF emette il summary (apply-whatif.ts:126-150, 613). UI render: `SolutionDiff.tsx:252` (prop), :322 (passed), :615 (count badge), :619 (lista rendered); WhatIfAnalysis.tsx:69 (typing), :395-396 (state set su solved). Banner `lock_relaxed_to_soft` reso a SolutionDiff.tsx:426 da event `lock_relaxing` (:172, :194). Audit trail completo per il manager. |
| F-W7-16 | **LOW** | meta (multi-replica race) | `src/routes/api/apply-whatif.ts:156-314` post-F-W7-04 | Il lock `_inFlightBySlug` è in-memory single-instance. Se la BFF gira con >1 worker/replica (cluster mode, Render auto-scale, ecc.), la race torna: due replica non vedono lo stesso Map. Out-of-scope launch single-instance ma must-fix prima di scaling. | Sostituire la map locale con un Redis SET NX EX (lock distribuito) keyed by `apply-whatif:${slug}` con TTL = SOLVE_TIMEOUT_MS+10s. Oppure file-lock backend (`fcntl` su `companies/<slug>/.lock`) — preferito perché l'unica risorsa contesa è il filesystem `companies/<slug>/plans/history`. | backlog (scaling phase) |
| F-W7-09 | **MED** | L6 (cutoff UI bypass) | `src/components/dashboard/WhatIfAnalysis.tsx:269-282` + `src/routes/api/apply-whatif.ts:61` | Il custom datetime UI accetta qualsiasi valore (`datetime-local` browser-native). Manager mette data del 2030 → `customMs - nowMs` enorme → `derivedCushion` enorme → bloccato a 1440 dal BFF Zod schema con 400 generico. UX terribile: errore "invalid_body" senza spiegazione che il valore era out-of-range. Non è una vulnerabilità ma un UX gap. | Aggiungere validazione client-side: se `customMs > nowMs + 24h` → mostrare warning UI rosso e disabilitare bottone "Esegui". Stesso per cutoff in passato (`customMs < nowMs`). | open — DM w7-ui-cutoff-diff |
| F-W7-10 | **MED** | L2 (cushion edge case) | `src/components/dashboard/WhatIfAnalysis.tsx:266-282` + `src/routes/api/apply-whatif.ts:61` | Edge case mid-shift: alle 23:59, cushion=30min → cutoffMin pointing a gg+1 00:29. Per fixture con `time_config.machine_windows={M01:{start:0,end:480}}` (orario lavorativo 8:00-16:00), il cutoff cade FUORI dalla finestra di lavoro. `frozen-window-builder` non ne tiene conto: le fasi precedenti 00:29 della giornata sono tutte locked anche se non c'erano fasi schedulate (notturno chiuso). Non è bug funzionale (lock di 0 fasi = no-op) ma il banner "Nessun lock applicato" (`SolutionDiff:408-422`) si attiva anche legittimamente, confondendo il manager. | `frozen-window-builder.ts:buildFrozenPhases` può ritornare metadati addizionali: `{ frozen: [], reason: "cutoff during off-hours" }`. BFF emette `frozen_window` SSE event con quel reason. SolutionDiff mostra messaggio più specifico: "Nessuna fase consolidata: cutoff durante off-hours, ricalcolo completo legittimo". | open — DM w7-bff-orchestrator |
| F-W7-11 | **LOW** | L10 (catalog YAML cache) | `src/server/llm/catalog/loader.ts:73-123` | `loadCatalog()` memorizza il YAML una volta sola in `_catalog`, mai re-letto. Modifica del catalog a runtime → ignorata fino a restart. Documentato come "intentional" (commento riga 11-20) ma il plan §2 D5 dice "Auditable, no prompt engineering per estendere intent" — l'auditing manuale di un YAML cache-hot è confuso. | Aggiungere un endpoint admin `/api/admin/reset-catalog-cache` (auth-required) che chiama `resetCatalogCache()`. Documentare nel scheda-prodotto-non-tecnica.md. | open — backlog |
| F-W7-12 | **LOW** | L11 (prompt injection in customDatetime) | `src/components/dashboard/WhatIfAnalysis.tsx:321` + `src/routes/api/apply-whatif.ts:44-62` | `customCutoffIso` è inviata nel body POST ma il BodySchema non la include. Zod default mode = "strip" → silently dropped. Non vulnerabilità ma input ignorato in modo invisibile. Se UI in futuro si aspettasse di poter passare un cutoff esplicito invece di un cushion → fallirebbe silenziosamente. | (a) Rimuovere `customCutoffIso` dall'invio o (b) aggiungerlo allo schema con Zod refinement `iso_datetime_string`. Documentare il choice. | open — backlog |
| F-W7-13 | **LOW** | L4 (canary marker) | `/api/health` response | Difficile distinguere "backend non ricaricato" da "backend funzionante ma rule consumer disabilitato". | Aggiungere capabilities/version field a `/api/health`. | **FULLY FIXED (2026-05-22, task #14, commit bba231a)** — `/api/health` ora ritorna `{"status":"ok","timestamp":...,"capabilities":["wave7-apply-rules","wave7-frozen-phases"]}`. Live verified. Tester può `curl -s host/api/health \| jq -e '.capabilities \| contains(["wave7-apply-rules"])'` come precheck. |
| F-W7-14 | **LOW** | L9 (backend timeout 60s con N=500) | `src/routes/api/apply-whatif.ts:104` (`SOLVE_TIMEOUT_MS = 60_000`) | Per fixture `demo-commesse-test-300` (300 ordini), warmly seeded a tempo X, una solve con frozen-phases hard-lock potrebbe sforare 60s. Plan §6 gate-finale tace su questo. Non bug ma misurato adversarialmente. | Eseguire `scripts/wave7-integration.ts` su `demo-commesse-test-300` con 5 ripetizioni. Se p95 > 50s, alzare timeout a 90s + emettere `partial_result` event. | open — DM w7-tester |
| F-W7-15 | **INFO** | meta | repos branch names | Plan §0 dichiara branch `feat/wave7-real-effect` (frontend) e `feat/wave7-rules-and-frozen-window` (backend); il working tree ha entrambi i repo su `feat/wave7-rules-and-frozen-window`. Naming inconsistente non blocca ma confonde search/git-log per la prossima review. | Allineare i branch names PRIMA del commit finale. Frontend → rename branch a `feat/wave7-real-effect` se il piano è canonico. | open — backlog |

## Appendice — verifiche live eseguite

### Curl test 1 (M02 rotta gg2 12:00 → 18:00)

```bash
curl -X POST http://localhost:8001/api/public/solve-template \
  -H "Content-Type: application/json" \
  -d '{"slug":"demo-commesse","problem_type":"fjsp","rules":{"unavailable_machines":{"M02":[{"start_min":2160,"end_min":2520}]}}}'
```

Risultato: `status: FEASIBLE`, **wave7: None** (backend non ricaricato — F-W7-03). 15 fasi M02 totali, **0 nella finestra [2160,2520]** (ma è perché la baseline M02 finisce tutta entro min 1437, F-W7-01).

### Curl test 2 (M02 completamente bloccato 0..99999)

Stesso comportamento: 15 fasi M02 ancora presenti, dimostra che il rule consumer NON viene chiamato (backend pre-Wave-7).

### Distribuzione fasi M02 nel fixture demo-commesse baseline

```
[('COM-002','OP-2',304,340), ('COM-003','OP-1',419,480), ('COM-004','OP-1',33,55),
 ('COM-006','OP-3',382,418), ('COM-007','OP-1',960,1072), ('COM-010','OP-2',1426,1437),
 ('COM-011','OP-2',1293,1392), ('COM-012','OP-2',1215,1293), ('COM-013','OP-1',105,194),
 ('COM-014','OP-2',1092,1134), ('COM-015','OP-1',55,87), ('COM-016','OP-2',1137,1215),
 ('COM-017','OP-1',194,283), ('COM-018','OP-3',1392,1426), ('COM-020','OP-1',340,382)]
```

Max end_min = 1437. Cutoff 2160 è **tutta dopo** → il rule non incide → e2e Test 1 passa vacuamente. F-W7-01.

## DM inviati durante la wave (5 / 8 used)

1. **w7-tester** — F-W7-01 CRITICAL (Test 1 vacuo) + F-W7-05 HIGH (test.skip masks failures) + cross-link F-W7-03.
2. **w7-bff-orchestrator** — F-W7-02 HIGH (INFEASIBLE no fallback) + F-W7-04 HIGH (concurrency per-slug) + F-W7-08 MED (dataset_overrides_summary).
3. **w7-intent-parser** (#1) — F-W7-06 HIGH (Haiku temporal inconsistency, mock-only tests).
4. **w7-backend-engineer** — F-W7-03 HIGH (uvicorn pre-W7 still serving old code) + F-W7-13 LOW (canary marker).
5. **w7-intent-parser** (#2, post-fix) — F-W7-06b MED (residual: few-shot example riga 178 ancora 2880, riga 184 start_min=360).

Budget restante: 3 DM. Trattenuti per HIGH che emergano dopo task #14/#16/#18 completion.

## Append-only log

### 2026-05-22 — sessione iniziale

- Claim task #19, set in_progress.
- Letto `docs/wave7-plan-real-effect.md` (372 righe, plan approvato).
- Stato osservato all'apertura: branch divergono dal plan (F-W7-15). Backend file `f_apply_rules.py` esiste come untracked. Backend `fjsp.py` ha sia hard-lock branch (lines 1407-1525) che apply_rules hook (lines 1185-1205). Route `/api/public/solve-template` estesa con `cutoff_min, frozen_phases, dataset_overrides` (routes_optimize.py:1947-1958, 2057-2087).
- Frontend: `intent-parser.ts`, `strategy-router.ts`, `catalog/constraint-catalog.yaml`, `catalog/loader.ts`, `data-modifier.ts`, `frozen-window-builder.ts` tutti presenti. UI `WhatIfAnalysis.tsx` ha cutoff selector (lines 470-553) + cushion preset state (line 135). `SolutionDiff.tsx` ha extras (lockedCount, modifiedCount, intentId, violatedConstraint, machineExclusionStatus).
- BFF `apply-whatif.ts` accetta `currentTimeMin, cushionMin` (lines 51-61) ma **NON li USA nel solve call** (lines 322-347): chiama ancora `resolveTemplate(slug, problemType, tr.change.rules)` come Wave 4.1. Task #16 ancora in_progress → atteso fix lì.

### 2026-05-22 — primo round live testing

- Curl diretto al backend dimostra che `wave7: None` resta sempre nelle response → **backend uvicorn (PID 16378, avviato Thu10AM) non ha ricaricato il nuovo codice** (F-W7-03).
- Distribuzione M02 nel fixture demo-commesse rivela: tutte le 15 fasi finiscono entro min 1437. Test 1 e2e usa finestra [2160,2520] → tautologicamente soddisfatto (F-W7-01 CRITICAL).
- Test files `tests/test_fjsp_apply_rules.py` (~277 righe, 7 test) e `test_fjsp_frozen_phases.py` (~210 righe, 4 test) presenti e ben strutturati. Manca scenario "lock + conflicting rule" che produca INFEASIBLE reale.
- E2e wave7-real-effect.spec.ts 6 test con escape hatch `test.skip` su Opus 529 e `solved===null` (F-W7-05). Test 1 ASSERT 3 si auto-disabilita se `preCutoff.length === baselinePhases.length` — bandiera rossa.

### 2026-05-22 — DM inviati + chiusura sessione

- 4 DM inviati (vedi sezione DM). Budget restante 4/8.
- Stato dei task all'atto della chiusura: #14 in_progress, #15 in_progress, #16 in_progress, #17 completed, #18 in_progress, #19 completed (questo).
- L'e2e suite gira come worker playwright (PID 53035 + 53039) sul backend stale → output atteso: failure sui Test 1/4/6 per i motivi descritti F-W7-03 + F-W7-01.

### Verdict aggregato (chiusura)

Findings: **1 CRITICAL, 4 HIGH (1 partially-fixed), 5 MED, 4 LOW, 1 INFO** (totale 15 fix-actionable).

**Aggiornamento 2026-05-22 (post-team-lead notify, dopo completion task #16)**:
- F-W7-02 (HIGH) → **FIXED** da w7-bff-orchestrator (task #16): INFEASIBLE recovery con retry-without-frozen-phases + warning `lock_relaxed_to_soft`. apply-whatif.ts:539-577.
- F-W7-04 (HIGH) → **FIXED** da w7-bff-orchestrator (task #16): `_inFlightBySlug` lock parallelo all'IP. apply-whatif.ts:156-314.
- F-W7-06 (HIGH) → **partially-fixed** da w7-intent-parser: regola temporale riscritta + 6 integration test live Haiku PASS. RESIDUO F-W7-06b (MED, vedi riga separata).
- F-W7-08 (MED) → **partially-fixed** da w7-bff-orchestrator: `dataset_overrides_summary` ora nel payload `solved` (apply-whatif.ts:126-150, 613). Residuo lato UI (`SolutionDiff.tsx` deve render il campo) — atteso da task #17.

**Stato post-fix gate (aggiornato 2026-05-22, post task #14 + #15 + #16 + #17 chiusi)**:
- 1 CRITICAL aperta: F-W7-01 (Test 1 vacuo) — pending da w7-tester (task #18 ancora in_progress).
- 5 HIGH originali → **4 FULLY FIXED** (F-W7-02 INFEASIBLE retry, F-W7-03 uvicorn restart + INFEASIBLE diagnostic copy, F-W7-04 per-slug lock, F-W7-06 Haiku temporal + F-W7-06b residuo), **1 ancora aperto** (F-W7-05 test.skip pendente task #18).
- F-W7-08 (MED) → **FULLY FIXED** (BFF emit + UI render `dataset_overrides_summary`).
- F-W7-13 (LOW) → **FULLY FIXED** (`/api/health` capabilities ora live).
- **Bonus bug catturato durante F-W7-03 fix**: il branch INFEASIBLE in `fjsp.py:1761` strippava `wave7_apply_rules`/`wave7_frozen_phases` dalla response — quello che il manager più si aspetta di sapere ("perché ha fallito?") era l'UNICO caso senza diagnostica. Chiuso da w7-backend-engineer con regression test dedicato.
- Senza F-W7-01 (CRITICAL) + F-W7-05 (HIGH) chiusi, gate Wave 7 §6 non passa. Entrambi su w7-tester (task #18).

- 1 CRITICAL (F-W7-01) — Test 1 vacuo, identico bug Wave 4.1.
- 4 HIGH — F-W7-02 (INFEASIBLE fallback), F-W7-03 (uvicorn stale), F-W7-04 (race per-slug), F-W7-05 (test.skip masking), F-W7-06 (Haiku ambiguità temporale). 
- 4 MED — F-W7-07 (localStorage), F-W7-08 (Strategy A audit), F-W7-09 (UI cutoff validation), F-W7-10 (off-hours cushion).
- 4 LOW — F-W7-11 (catalog cache), F-W7-12 (customCutoffIso silently stripped), F-W7-13 (canary marker), F-W7-14 (timeout 60s scale).
- 1 INFO — F-W7-15 (branch naming).

Verdict GO/CONDITIONAL/NO-GO: **CONDITIONAL**.
- Sblocchi mandatori per GO: chiusura F-W7-01 (CRITICAL), F-W7-02 (HIGH), F-W7-03 (HIGH), F-W7-05 (HIGH), F-W7-06 (HIGH).
- F-W7-04 può essere accettato come known-issue per single-tenant launch ma deve essere fixato prima del primo deployment B2B multi-utente.
- Tutti i MED/LOW sono backlog (non bloccano gate Wave 7 §6).

