# Wave 7 — Real Effect: rules consumate dal solver + frozen-window hard-lock + parser intent + catalog

> **Status**: APPROVED (autopilot mandate, Paolo 2026-05-22)
> **Branch frontend**: `feat/wave7-real-effect` (da creare dal corrente `feat/wave5.1-validation-fixes`)
> **Branch backend**: `feat/wave7-rules-and-frozen-window` (da creare dal `main` di `daino-backend-definitivo`)
> **Cost cap totale stimato**: ~$4.50 LLM (team Opus + test)
> **Stima lavoro**: 3 giorni con team da 6 teammate Opus paralleli

---

## 1. Context

Il test live nel browser del 2026-05-22 ha confermato l'audit del subagent: il
loop apply-whatif della Wave 4.1 è **una facciata cosmetica**. Il manager
scrive *"M2 si è rotto al gg2 ore 12"*, il sistema processa, paga $0.31 in
LLM, mostra una tabella "Confronto soluzioni" — **e tutti i Δ KPI sono
zero**. M2 continua a operare normalmente nel piano "candidato".

Cause radice (verdict audit + verifica live):

1. **Il solver FJSP ignora `rules.unavailable_machines`, `priority_orders`,
   `deadline_changes`, `extra_capacity`, `shift_changes`.** Sono persistiti
   in `companies/<slug>/plans/history/*.json` ma `daino/templates/fjsp.py`
   non ha consumer per nessuno di questi tipi. Verificato con
   `grep -rn unavailable_machines daino/` → zero match in codice solver.
2. **Manca un meccanismo di frozen-window hard-lock.** Il warm-start
   esistente usa `model.add_hint` (soft suggestion CP-SAT,
   `fjsp.py:1403-1438`); il solver può disattendere l'hint se trova
   ottimo migliore. Le fasi pre-cutoff sono *suggerite*, non *bloccate*.
3. **L'architettura è troppo LLM-centric**. Il translator Opus produce
   schemi JSON liberi che il backend non consuma; manca un parser-intent
   deterministico che mappi su un catalogo finito di vincoli.

## 2. Decisione architetturale

Implementiamo l'architettura discussa con Paolo:

```
[Frase manager + ora corrente T0 + baseline]
         ↓
[L1 — Intent Parser]              Haiku 4.5, $0.005, <1s
   estrae: intent + entities  (es. machine_unavailability(M02, gg2 12:00, fine giornata))
         ↓
[L2 — Strategy Router]            TS puro, $0
   Strategia A: data modification (preferita)
       → modifica il dataset (es. machine calendar) prima di mandare al solver
   Strategia B: catalog constraint
       → vincolo dal menu chiuso (es. rules.priority_orders)
   Strategia C: Opus dynamic constraint (fallback)
       → Opus mappa intent ad uno dei 5 schemi noti; mai schema inventato
         ↓
[L3 — Frozen-window builder]      TS puro, $0
   Calcola cutoff_min = T0 + 30 min cushion (override esplicito UI)
   Estrae frozen_phases dalla baseline (fasi con end_min <= cutoff_min)
         ↓
[L4 — Backend solve-template+lock] Python, $0 LLM, deterministico
   Riceve: dataset (eventualmente modificato) + cutoff_min + frozen_phases + rules
   Applica hard-lock: model.Add(start_var == fp.start_min) per ogni fase pre-cutoff
   Consuma rules.unavailable_machines, priority_orders, deadline_changes, ecc.
         ↓
[L5 — Diff baseline vs new]       TS puro, $0
   Per ogni fase: invariata (locked) / modificata / nuova
   Asserzione operativa: nessuna fase ASSEGNATA a M2 nel candidate post-cutoff
```

### Decisioni operative pinned

| # | Decisione | Razionale |
|---|---|---|
| D1 | Cutoff temporale = **"now + 30 min cushion"** + override esplicito UI ("Da quando ricalcolare: [now] [now+30] [now+1h] [custom]") | Bilancia automazione + controllo manager. Cushion evita di disturbare fasi che stanno per iniziare |
| D2 | **Lock duro + fallback soft** se INFEASIBLE | Garanzia "produzione invariata" + recovery se vincolo nuovo è impossibile. Il fallback emette warning UI |
| D3 | Backend modificato in **estensione additiva** (nuovi campi opzionali su `solve-template`, no breaking) | Rispetta principio plugin-pattern: vecchi caller funzionano identici |
| D4 | Frontend usa **Haiku per intent parser** (10× più economico di Opus, basta per intent classification + entity extraction) | Il LLM fa intent classification, non ragionamento strategico — Haiku 4.5 è sufficiente |
| D5 | Catalog dei vincoli in **YAML versionato** (`docs/constraint-catalog.yaml`) | Auditable, no prompt engineering per estendere intent |
| D6 | Wave 4.1 attuale (apply-whatif route) → **diventa Strategy C** della nuova architettura. Non si butta nulla | Riuso codice esistente come fallback |
| D7 | Test e2e DEVE assertare: "nessuna fase su M2 con `end_min > cutoff_min` nel candidate", "tutte le fasi con `end_min <= cutoff_min` invariate" | Il bug Wave 4.1 era che i test verificavano flow, non effetto |

### Alternative scartate

- **Modifica dati per TUTTI gli intent**: non è sempre traducibile (es. priority order è naturale come `rules.priority_orders`, non come modifica dataset). Mantengo entrambe le strade.
- **Solo backend modifica (no frontend)**: lasciamo lo schema schiavo del backend → meno auditable, blocca evoluzione frontend.
- **Solo frontend (preprocessing dataset al BFF, no backend tocco)**: hack, peggiora performance (payload dataset enorme), il backend non sa che le fasi pre-cutoff sono lock — qualunque ottimo locale potrebbe spostarle.
- **AddHint con peso elevato**: già esiste e non basta. Per "produzione invariata" serve `model.Add` puntuale.

## 3. File critici

### Frontend (`frontend-industriale/`)

| File | Stato | Azione |
|---|---|---|
| `src/server/llm/intent-parser.ts` | NUOVO | Haiku 4.5 + entity extraction |
| `src/server/llm/strategy-router.ts` | NUOVO | Routing A/B/C deterministico + lookup catalog |
| `src/server/llm/catalog/constraint-catalog.yaml` | NUOVO | Menu chiuso di intent supportati |
| `src/server/llm/catalog/loader.ts` | NUOVO | Carica + valida YAML, espone `lookupIntent(intentId)` |
| `src/server/llm/data-modifier.ts` | NUOVO | Strategia A: trasformazioni deterministiche del dataset |
| `src/server/llm/frozen-window-builder.ts` | NUOVO | Estrae frozen_phases dalla baseline + cushion logic |
| `src/server/llm/constraint-translator.ts` | ESISTENTE | DIVENTA Strategy C fallback (no nuova logica, solo wrapper) |
| `src/routes/api/apply-whatif.ts` | ESISTENTE | Orchestra: parse intent → router A/B/C → frozen-window → backend |
| `src/lib/api.ts` | ESISTENTE | `resolveTemplate` esteso con `cutoff_min, frozen_phases, dataset_overrides` |
| `src/components/dashboard/WhatIfAnalysis.tsx` | ESISTENTE | Cutoff selector (now / +30 / +1h / custom) |
| `src/components/dashboard/SolutionDiff.tsx` | ESISTENTE | Mostra `locked_count, modified_count`, badge "Vincolo applicato" se machine assignment cambia |

### Backend (`daino-backend-definitivo/`)

| File | Stato | Azione |
|---|---|---|
| `daino/api/routes_optimize.py` | ESISTENTE | Accetta nuovi body fields opzionali `cutoff_min, frozen_phases` |
| `daino/arm_c/template_solve.py` | ESISTENTE | Propaga nuovi kwargs a `templates/fjsp.py` |
| `daino/templates/fjsp.py` | ESISTENTE | **Branch nuovo**: se `rules._frozen_phases` o `rules._cutoff_min`, applica `model.Add(start == X)` puntuale per ogni fase locked |
| `daino/templates/fjsp_constraints/f_apply_rules.py` | NUOVO | Modulo che consuma `rules.unavailable_machines, priority_orders, deadline_changes, extra_capacity, shift_changes` e li aggiunge al model CP-SAT |
| `daino/templates/fjsp.py:1392-1412` | ESISTENTE | Branch warm-start: aggiunge call a `f_apply_rules.apply(model, rules, data, vars)` |
| `tests/test_fjsp_apply_rules.py` | NUOVO | Unit test backend per ogni rule type |
| `tests/test_fjsp_frozen_phases.py` | NUOVO | Unit test backend per hard-lock |

### Test (`frontend-industriale/`)

| File | Stato | Azione |
|---|---|---|
| `tests/e2e/wave7-real-effect.spec.ts` | NUOVO | E2E che verifica DAVVERO l'effetto: M2 fuori post-cutoff, fasi pre-cutoff invariate |
| `src/server/llm/__tests__/intent-parser.test.ts` | NUOVO | Unit Haiku parser |
| `src/server/llm/__tests__/strategy-router.test.ts` | NUOVO | Unit router A/B/C |
| `src/server/llm/__tests__/data-modifier.test.ts` | NUOVO | Unit modifica dataset |
| `src/server/llm/__tests__/frozen-window-builder.test.ts` | NUOVO | Unit frozen-window extraction |
| `tests/e2e/wave7-cutoff-cushion.spec.ts` | NUOVO | E2E cutoff override UI |

## 4. Team — 6 teammate Opus

Sweet spot ufficiale è 3-5, ma Wave 7 è critica e tocca 2 repo (frontend + backend) — accetto 6 con ownership disgiunte rigorose.

### Teammate `w7-backend-engineer` (Opus, repo `daino-backend-definitivo`)

**Ownership esclusiva**:
- `daino/templates/fjsp.py` (estensione)
- `daino/templates/fjsp_constraints/f_apply_rules.py` (NUOVO)
- `daino/api/routes_optimize.py` (estensione payload)
- `daino/arm_c/template_solve.py` (propagazione kwargs)
- `tests/test_fjsp_apply_rules.py` (NUOVO)
- `tests/test_fjsp_frozen_phases.py` (NUOVO)

**Deliverable**:
1. Branch `feat/wave7-rules-and-frozen-window` da `main`
2. Nuovo modulo `f_apply_rules.py` che traduce ogni rule type in vincoli CP-SAT:
   - `unavailable_machines: {M02: [{start_min, end_min}]}` → `model.Add(start_var[op] >= end_min).OnlyEnforceIf(machine_assigned[op,M02])` o `model.AddNoOverlap` con intervalli "unavailable"
   - `priority_orders: ["COM-007"]` → `model.Add(start_var[com-007 op 1] <= start_var[other op 1])` pairwise per ogni altra commessa
   - `deadline_changes: {"COM-007": {new_deadline_min: X}}` → override del campo `deadline_min` nel data dict prima del solve, oppure vincolo `end_var[last_op_of_COM-007] <= X`
   - `extra_capacity: {operators: 1, shift: "serale"}` → estende `data["operators"]` con un nuovo operatore generico
   - `shift_changes: {turno_mattina: {start_min: X, end_min: Y}}` → modifica `data["shifts"]`
3. Hard-lock branch in `fjsp.py:1392-1412`:
   - Se `rules._frozen_phases` presente: per ogni `(commessa, operazione, start_min, end_min, machine_id)` in lista, fai `model.Add(start_var == start_min)`, `model.Add(end_var == end_min)`, `model.Add(machine_assigned[op, machine_id] == 1)`. Niente `add_hint` per le frozen.
4. Estensione payload `routes_optimize.py` POST `/api/public/solve-template`: body accetta opzionalmente `cutoff_min: int`, `frozen_phases: list[dict]`, `dataset_overrides: dict | null`. Backward-compat: se null, comportamento attuale invariato.
5. Test:
   - `test_fjsp_apply_rules.py`: 5 test (uno per rule type) che verifica `result.solution` rispetta il vincolo
   - `test_fjsp_frozen_phases.py`: 3 test (no-op cutoff = makespan invariato; fase a cavallo del cutoff = correttamente vincolata; INFEASIBLE → status restituito senza crash)

**Pattern caching/cost**: nessuno (Python solver puro, no LLM).

**Cap costo**: $0 LLM (lavoro Python). Cap iterazioni con se stesso (re-test): max 3 cicli.

### Teammate `w7-bff-orchestrator` (Opus, repo `frontend-industriale`)

**Ownership esclusiva**:
- `src/routes/api/apply-whatif.ts` (estensione orchestrazione)
- `src/lib/api.ts` (estensione `resolveTemplate`)
- `src/server/llm/frozen-window-builder.ts` (NUOVO)
- `src/server/llm/data-modifier.ts` (NUOVO)

**Deliverable**:
1. `frozen-window-builder.ts`: funzione `buildFrozenPhases(baseline, cutoffMin) → FrozenPhase[]`. Per ogni fase nella baseline (struttura FJSP `{commessa: {fasi: [...]}}`), se `fase.end_min <= cutoffMin`, includila. Edge case fase a cavallo: include con `start_min = baseline.start_min`, `end_min = min(cutoff_min, baseline.end_min)` (spezzata) — flag warning per devil's advocate.
2. `data-modifier.ts`: strategia A. Funzione `applyDataModification(dataset, intent, entities) → modified_dataset`. Per ora implementa **2 trasformazioni**:
   - `machine_unavailability`: nel campo `data["maintenance"]` aggiunge entry `{machine_id, weekday, start_min, end_min}` (formato esistente backend)
   - `deadline_change`: nel campo `data["orders"][order_id]["deadline_min"]` sostituisce il valore
3. Estensione `apply-whatif.ts`:
   - Bodyschema accetta opzionalmente `currentTimeMin: number, cushionMin: number = 30`
   - Compute `cutoffMin = currentTimeMin + cushionMin`
   - Chiama `intent-parser` (vedi teammate w7-intent-parser)
   - Chiama `strategy-router` (vedi teammate w7-intent-parser)
   - Esegue strategia: A modifica dataset prima di chiamare backend, B/C aggiunge rules
   - Estrae `frozenPhases` via `frozen-window-builder`
   - Chiama `resolveTemplate(slug, problemType, rules, cutoffMin, frozenPhases, datasetOverrides)`
4. Estensione `api.ts` `resolveTemplate(...)`: accetta nuovi params, li mette nel body.

**Pattern caching/cost**: SSE come oggi, no nuova LLM chiamata diretta.

**Cap costo**: $0 LLM nel BFF stesso (le LLM calls le fa l'intent-parser).

### Teammate `w7-intent-parser` (Opus, repo `frontend-industriale`)

**Ownership esclusiva**:
- `src/server/llm/intent-parser.ts` (NUOVO)
- `src/server/llm/catalog/constraint-catalog.yaml` (NUOVO)
- `src/server/llm/catalog/loader.ts` (NUOVO)
- `src/server/llm/strategy-router.ts` (NUOVO)
- `src/server/llm/__tests__/intent-parser.test.ts` (NUOVO)
- `src/server/llm/__tests__/strategy-router.test.ts` (NUOVO)
- `src/server/llm/__tests__/catalog-loader.test.ts` (NUOVO)

**Deliverable**:
1. `constraint-catalog.yaml`: definisce 5 intent iniziali con schema:

```yaml
intents:
  - id: machine_unavailability
    description_it: "Macchina indisponibile per finestra oraria"
    strategy: data_modification
    fallback_strategy: rule_addition
    fallback_rule_key: unavailable_machines
    entities:
      machine_id: { required: true, validator: must_exist_in_solution }
      start_min: { required: true, validator: positive_int }
      end_min: { required: false, validator: gt_start, default_to: horizon_end }
    italian_triggers:
      - "{verbo_fermo} {machine}( {dalle/al}? {time}( {alle/fino_a} {time})?)?"
      - "{machine} (rotta|fuori|kaput|indisponibile)"
    examples:
      - input: "M2 si è rotto al gg2 ore 12"
        intent: machine_unavailability
        entities: { machine_id: "M02", start_min: 2160, end_min: 2520 }
  - id: order_priority
    # ... (4 altri intent: order_priority, deadline_change, capacity_addition, shift_window)
```

2. `loader.ts`: parse YAML, valida con Zod schema, espone `findIntent(intentId): IntentDef`.

3. `intent-parser.ts`: Haiku 4.5 con prompt italiano breve (catalog injection minimale, ~500 token tot), forced JSON output `{intent_id, entities, confidence, fallback_reasoning}`. Cache_control on system. Se Haiku non riconosce nessun intent → `{intent_id: "unknown", ...}` → router cade in C.

4. `strategy-router.ts`: funzione `routeIntent(intent, entities, baseline, catalog) → StrategyOutcome`. Logica:
   - Lookup intent nel catalog. Se non esiste → strategy C.
   - Se `intent.strategy === 'data_modification'`: chiama `dataModifier.canApply(intent, entities, baseline)`. Se sì → A. Se no → fallback strategy del catalog.
   - Se `intent.strategy === 'rule_addition'` (o fallback): valida entities deterministicamente contro baseline, costruisce `rules` payload dal catalog schema → B.
   - Se nessuno → C (Opus translator esistente Wave 4.1).
5. Test (vitest):
   - intent-parser.test: 10 casi italiani sample (incluso prompt injection)
   - catalog-loader.test: 5 casi (YAML valido, schema invalido, intent inesistente, ecc.)
   - strategy-router.test: 8 casi (A si applica, A non si applica → B, B non si applica → C, ID inesistente → unsupported, ecc.)

**Pattern caching/cost**: Haiku 4.5 con cache_control sul system prompt (~1500 tok). Costo target: $0.005/parse.

**Cap costo**: 15 Haiku call durante test (~$0.075).

### Teammate `w7-ui-cutoff-diff` (Opus, repo `frontend-industriale`)

**Ownership esclusiva**:
- `src/components/dashboard/WhatIfAnalysis.tsx` (estensione: cutoff selector)
- `src/components/dashboard/SolutionDiff.tsx` (estensione: lock count + violation badge)

**Deliverable**:
1. WhatIfAnalysis cutoff selector:
   - Sezione "Da quando ricalcolare:" con 4 bottoni radio: `Adesso`, `+30 min` (default), `+1 h`, `Personalizza`
   - Se "Personalizza" → input datetime-local
   - Passa `currentTimeMin, cushionMin` nel body POST `/api/apply-whatif`
2. SolutionDiff:
   - Badge "Vincolo applicato" se intent === `machine_unavailability` → verde se nel candidate la macchina target NON ha fasi post-cutoff; rosso se ne ha
   - Sezione "Fasi consolidate (invariate)" con count + lista fasi pre-cutoff
   - Sezione "Fasi ricalcolate" con count + delta start_min/machine per ogni fase modificata
   - Se backend ritorna `locked_count: 0` (nessuna frozen applicata) → warning banner "Nessun lock applicato — il piano è stato ricalcolato da zero"

**Cap costo**: $0 LLM (UI only).

### Teammate `w7-tester` (Opus, repo `frontend-industriale` + `daino-backend-definitivo`)

**Ownership esclusiva**:
- `tests/e2e/wave7-real-effect.spec.ts` (NUOVO, Playwright)
- `tests/e2e/wave7-cutoff-cushion.spec.ts` (NUOVO, Playwright)
- `scripts/wave7-integration.ts` (NUOVO, tsx integration test)
- `docs/wave7-test-report.md` (NUOVO)

**Deliverable**:
1. E2E spec `wave7-real-effect.spec.ts` con **assertion sull'EFFETTO** (NON solo flow):
   - Test 1 — happy path "M2 rotta gg2 12:00": solve baseline, apply-whatif, asserisci:
     a. `candidate.solution` non contiene fasi con `machine_id == "M02"` e `start_min >= 2160` (la finestra di indisponibilità)
     b. Per ogni fase `f` nella baseline con `f.end_min <= cutoff_min` (= 2160): `candidate.solution[f.commessa].fasi[f.idx]` ha `start_min == f.start_min` e `machine_id == f.machine_id` (lock duro verificato)
     c. `delta_kpi.makespan_min > 0` (qualche impatto)
   - Test 2 — priority order: "anticipa COM-007", asserisci che `candidate` ha `start_min` di COM-007 op-1 ≤ `start_min` di qualsiasi altra commessa op-1
   - Test 3 — deadline_change: "sposta COM-002 entro 3 aprile", asserisci `candidate.solution["COM-002"]` ultima fase con `end_min <= new_deadline_min`
   - Test 4 — INFEASIBLE recovery: scenario impossibile (block 4/5 macchine), asserisci `result.warnings` include `lock_relaxed_to_soft` + status non-error
   - Test 5 — unknown machine (M99): translator emette `unsupported`, no solver call
   - Test 6 — cutoff cushion: clicca "+1h", verifica `currentTimeMin + 60` arriva al backend
2. Integration script `wave7-integration.ts`: 10 cicli back-to-back su demo-commesse con random machine block + assertion. Report costo medio, latenza p50/p95, fail rate.
3. Report finale `docs/wave7-test-report.md`: tabella e2e (6 test × pass/fail/duration), integration (10 cicli aggregati), backend unit (estratto da test_fjsp_apply_rules.py + test_fjsp_frozen_phases.py), verdict GO/CONDITIONAL/NO-GO, cost reale.

**Cap costo**: $2.00 totali (10 integration + 6 e2e × Opus + 3-4 repro tests).

**Quando completed**: SendMessage team-lead con verdict + costo + path report.

### Teammate `w7-devils-advocate` (Opus, plan-mode obbligatorio, repo entrambi)

**Ownership esclusiva**:
- `docs/wave7-adversary-findings.md` (NUOVO, append-only)

**READ-ONLY**: tutto il resto.

**Deliverable**:
Lente avversariale su 12 dimensioni:
1. Hard-lock causa INFEASIBLE? (lock di una fase pre-cutoff confligge con vincolo nuovo)
2. Frozen-window cushion troppo corto/lungo? Edge: ora 23:59 → cushion 30min va a gg seguente, gestito?
3. Hallucination intent-parser: Haiku capisce davvero "fine giornata" come `end_min` corretto?
4. Backend rule_addition implementata davvero? Test isolato che la macchina M2 non appaia post-cutoff
5. Strategy A modifica dataset in modo che il diff sia plausible? Manager si rende conto che ha modificato il dataset, non aggiunto vincolo?
6. Cutoff override UI bypassabile (qualcuno mette cutoff negativo, gigantesco)?
7. localStorage del cutoff selezionato sopravvive a refresh?
8. Test e2e davvero verificano effetto o solo presenza del bottone?
9. Backend timeout 60s con N=500 ordini + lock duro?
10. Catalog YAML modificabile a runtime? Cache invalidation?
11. Prompt injection nel campo cutoff custom date?
12. Concorrenza: 2 manager fanno apply-whatif sullo stesso slug — race condition sul cutoff?

**Output**: tabella severity (CRITICAL/HIGH/MED/LOW) × file:line × descrizione × fix proposto.

**Cap costo**: $0.40 (5 Opus call investigation).

## 5. Dipendenze e timeline

```
w7-backend-engineer  ─────────►  test backend ──┐
w7-intent-parser     ─────►  ┐                  │
                             ├─►  w7-bff-orchestrator  ─►  test BFF
w7-ui-cutoff-diff    ──►  ┘                            │
                                                       │
                                          w7-tester ◄──┘
                                                       │
w7-devils-advocate   ════════════════════════════════►  (continuous, no block)
```

Stima parallelizzata: **2.5-3 giorni** con team da 6.

## 6. Gate finale Wave 7

Per dichiarare Wave 7 done:

1. ✅ Tutti i 6 test e2e PASS (con assertion sull'effetto, non solo flow)
2. ✅ 5 unit test backend rule consumer PASS
3. ✅ 3 unit test backend frozen-phases PASS
4. ✅ Integration 10/10 cicli green
5. ✅ Devils advocate: 0 HIGH/CRITICAL aperti
6. ✅ Costo reale per click ≤ $0.10 (vs $0.31 attuale — drop atteso grazie a Haiku parser)
7. ✅ Test live UX (manuale, fatto dal lead): "M2 rotta gg2 12:00" produce candidate dove M2 effettivamente sparisce post-cutoff
8. ✅ Commit Wave 7 su feature branch frontend + backend, push, NO merge to main

## 7. Plugin pattern preservation

D1 originale: "backend = plugin, non modificare".

Wave 7 **estende** il backend in modo **additivo**:
- Nuovi field opzionali su `/api/public/solve-template`: `cutoff_min, frozen_phases, dataset_overrides`. Se null → comportamento attuale.
- Nuovo modulo `fjsp_constraints/f_apply_rules.py` — additivo, non sostituisce.
- Nuovo branch in `fjsp.py:1392` per hard-lock — additivo.

I caller esistenti del backend (altri frontend, test interni) **continuano a funzionare identici** perché tutti i nuovi campi sono opzionali con default no-op.

## 8. Comunicazione team

Mailbox-based, ogni teammate notifica:
- Quando completa il proprio task → SendMessage al teammate dipendente con: file path, contract output, eventuali quirks
- Se trova bug nel codice di un altro → SendMessage diretto
- Findings HIGH severity dal devils-advocate → SendMessage diretto al teammate owner

Team name: `wave7-real-effect`.

## 9. Cleanup post-wave

- Frontend: commit + push `feat/wave7-real-effect`
- Backend: commit + push `feat/wave7-rules-and-frozen-window`
- TaskList: clean tutti i task wave 7 dopo completion
- Team teardown via shutdown_request + TeamDelete (se possibile)
- Aggiorna `docs/scheda-prodotto-non-tecnica.md` con i nuovi numeri di costo + nuova architettura

---

*Piano scritto in autopilot da lead-orchestrator il 2026-05-22 14:30 — Paolo
autorizza l'esecuzione integrale "ti autorizzo a tutto, il piano che fai lo
accetto". Eventuali deviazioni in corsa saranno documentate in
docs/wave7-adversary-findings.md.*
