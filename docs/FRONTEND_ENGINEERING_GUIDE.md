# DAINO Frontend — Engineering Guide

> **Cos'è**: la guida tecnica al funzionamento del codice di `frontend-industriale` (TanStack Start BFF su Cloudflare Workers + React 19). Spiega, **sottosistema per sottosistema, COME funziona ogni feature** — con riferimenti `file:riga` reali — così da poterla consultare prima/mentre si legge il codice.
> **Per chi**: chi apre il repo e vuole capire il meccanismo (non solo cosa fa) senza ricostruirlo a mano.
> **Compagni di stanza**: backend → [`../../daino-backend-definitivo/docs/BACKEND_ENGINEERING_GUIDE.md`](../../daino-backend-definitivo/docs/BACKEND_ENGINEERING_GUIDE.md); decisioni architetturali → [`../../daino-backend-definitivo/docs/RESEARCH_LOG.md`](../../daino-backend-definitivo/docs/RESEARCH_LOG.md) (ADR-107 = anti-allucinazione); indice unico → [`../../CODEBASE_GUIDE.md`](../../CODEBASE_GUIDE.md).
> **Convenzione**: ogni sezione segue lo stesso schema — *Cosa fa · File chiave · Come funziona · Flusso dati/interfacce · Invarianti & gotcha · Cross-reference*.
> **Generata**: 2026-05-30 (Wave 16.6) con un *dynamic workflow* (subagent paralleli, uno per sottosistema, con validazione prima dell'integrazione). Da rigenerare/estendere quando il codice cambia in modo sostanziale.

## Indice

| Sezione | Di cosa parla |
|---------|---------------|
| **FE-A — Core AI conversazionale + gate anti-allucinazione (3 strati)** | Il cuore: l'interprete Haiku a insieme chiuso. Come il sistema capisce il linguaggio naturale del manager **senza poter mai inventare** un'entità (macchina/commessa/turno). Enum chiuso + gate deterministico + show-and-confirm. |
| **FE-B — Motore What-If + Ripianifica (pipeline SSE)** | Come uno scenario testuale diventa un re-solve reale: i due path (interprete vs translator), il ledger dei vincoli cumulativi (NEW-WINS), il re-gate M-4, la guardia "solution vuota", il cutoff/day-anchor, il retry INFEASIBLE. |
| **FE-C — Superfici Manager AI (chat, explainer, advisor, What-If UI, accept)** | I pannelli LLM: il loop agentico Haiku della chat (con risoluzione alias), explainer/advisor Sonnet, il merge dell'envelope su "Accetta" che aggiorna Gantt+KPI+produzione. |
| **FE-D — Infrastruttura BFF + flusso dati dashboard** | Come scorre una richiesta client→BFF→Anthropic e client→BFF→backend; chiave server-only mai nel bundle; rate-limit/costi; `adaptResult`; storage slug-scoped; PDF; il gotcha dell'env in dev. |

---

## FE-A — Core AI conversazionale + gate anti-allucinazione (3 strati)

### Cosa fa
Trasforma un'istruzione libera in italiano scritta dal manager ("m2 rotta", "blocca la linea 2 da domani pomeriggio fino a fine giornata", "anticipa la commessa 7") in un payload `rules` canonico che il solver backend consuma — con la garanzia che il sistema **non possa mai** emettere un id di macchina/commessa/turno che non esista nel piano corrente. Haiku classifica + estrae soltanto (mai calcola KPI o schedule); tre strati indipendenti garantiscono che ogni entità sia un membro del closed-set o venga rifiutata prima di un solve.

### File chiave
- `src/server/llm/instruction-interpreter.ts` — l'interprete Haiku: costruisce il tool con enum chiusi, fa una sola chiamata forzata, poi applica il gate deterministico (`interpretToolOutput` → `applyDeterministicGate`).
- `src/server/llm/strategy-router.ts` — `validateEntities` (bounds + required + canonicalizzazione via catalogo) e `buildRulesPayload` (mappa entità → forma `rules` del solver); il gate deterministico riusa entrambi.
- `src/lib/idCanon.ts` — `canonicaliseId`: probe deterministico padding/separatore con contratto ambiguo→null (mai inventa un id).
- `src/lib/entityResolver.ts` — `resolveMachineAlias` / `resolveOrderAlias` / `resolveShiftAlias` (sopra `resolveAgainstSet`): risoluzione token→id canonico contro il closed-set, fail-closed.
- `src/lib/solutionContext.ts` — `buildSolutionContext`: estrae il closed-set (machines/orders/shifts/alias/deadlines) dal piano live; è la FONTE unica degli id validi.
- `src/server/llm/catalog/loader.ts` + `src/server/llm/catalog/constraint-catalog.yaml` — i 5 intent chiusi e i loro validatori dichiarativi (Zod-validati, memoizzati).
- `src/server/llm/intent-parser.ts` — esporta `CONVENZIONI_TEMPORALI` (riusato verbatim dall'interprete) e il tipo `IntentConfidence`.
- `src/routes/api/apply-whatif.ts` / `src/routes/api/reschedule-fresh.ts` — i due consumer BFF; il secondo costruisce un re-gate (`regateConfirmedRules`) sulla conferma del gray.

### Come funziona (meccanismo passo-passo)

#### Strato 0 — il closed-set come fonte di verità (`buildSolutionContext`)
Tutto parte da `buildSolutionContext` (`src/lib/solutionContext.ts:213-246`), che riceve la soluzione corrente del piano e produce un `SolutionContext` con `machines`, `orders`, `shifts`, `machine_aliases`, `order_deadlines`, `shift_types` (interfaccia a `solutionContext.ts:3-11`). Questo oggetto è l'**unica** fonte di id validi a valle.

Punto non ovvio: l'estrazione è *shape-agnostic*. Il BFF può passare tre forme diverse di `originalSolution` — flat `{fasi:[…]}`, nested `{COM-001:{fasi:[…]}}`, o raw backend `{solution:{COM-001:{fasi}}}`. `extractMachines` raccoglie da BOTH il `fasi[]` top-level E ogni `commessa.fasi[]` (`solutionContext.ts:36-50`); `extractOrders` mirrora la stessa logica raccogliendo le commesse dalla mappa *e* dal `fasi[].commessa` flat (`solutionContext.ts:125-132`); `extractCommesse` riconosce le tre forme con un guard contro falsi positivi (un `time_config`/`kpis` senza `fasi` non è mai trattato come commessa, `solutionContext.ts:191-211`). Il commento a `solutionContext.ts:27-35` e `116-124` spiega il *perché*: pre-fix, leggere solo il `fasi[]` top-level produceva `machines=[]`/`orders=[]` per le forme nested → l'enum veniva omesso → ogni istruzione falliva silenziosamente il gate. È il presupposto del fail-closed: un set vuoto deve essere un bug del costruttore, non lo stato normale.

`shifts` è derivato SOLO da `shift_types` (`solutionContext.ts:235`): se il piano non espone i tipi di turno, `shifts=[]` e il sistema degrada a MISS sui pattern turno invece di inventare nomi.

#### Strato 1 — enum chiuso nel tool schema Haiku (`emit_constraint`)
`buildEmitTool(ctx)` (`instruction-interpreter.ts:137-211`) costruisce un singolo tool forzato il cui `input_schema` **incorpora gli id reali del piano come enum JSON-schema**:
- `machineProp.enum = ctx.machines` solo se la lista è non-vuota (`instruction-interpreter.ts:141-142`); idem `orderItem.enum` (`:146-147`) e `shiftProp.enum` (`:149-150`).
- `intent_id` è un enum dei 5 intent + `"unknown"` (`:159-164`); `shift` è un enum dei nomi canonici `mattina|pomeriggio|serale|notte` (`:173-176`).
- C'è un campo `unresolved_target` dedicato (`:197-201`): la descrizione istruisce il modello a popolarlo col testo grezzo ("M99", "linea 42") *invece* di scegliere un id a caso quando l'entità non è in lista.

Questa è la garanzia **strutturale**: il modello letteralmente non può collocare un id fuori da `ctx.machines/orders/shifts` in un campo enum-tipizzato — l'API rifiuterebbe l'output. Le richieste off-set sono incanalate per costruzione in `unresolved_target`. Il system prompt (`buildSystemPrompt`, `:213-268`) ribadisce la regola in linguaggio naturale (regola #4 "ANTI-ALLUCINAZIONE", `:226`), elenca lo "STATO DEL PIANO (CLOSED SET)" con gli id reali (`:229-232`), e ha un blocco anti-prompt-injection (`:234-237`) che mappa tentativi di injection a `intent_id="unknown"`.

La chiamata è `tool_choice: {type:'tool', name:'emit_constraint'}` (`:554`), `max_tokens: 400` (`:94`), modello `claude-haiku-4-5` (`:93`). Il system block ha `cache_control: {type:'ephemeral'}` (`:552`) e il prompt è deliberatamente verboso (>4096 token grazie al blocco temporale + esempi, vedi commento `:218-219`) così da superare il floor di cache di Haiku e riusare il blocco a costo ridotto.

Caso-limite enum vuoto: se una lista è vuota l'enum viene OMESSO (un enum JSON-schema vuoto è invalido, `:139-141`). In quel caso non c'è vincolo strutturale ma lo Strato 2 rifiuta comunque, perché un closed-set vuoto non risolve mai nulla.

#### Strato 2 — gate deterministico di ri-validazione (`interpretToolOutput` → `applyDeterministicGate`)
`interpretToolOutput` (`instruction-interpreter.ts:611-661`) è la mappatura pura post-LLM (esposta senza rete per i test). Sequenza:

1. **Tool input mancante/malformato** → `reject` immediato (`:616-618`).
2. **Confidence** normalizzata: qualunque valore non in `{high,medium,low}` collassa a `low` (`:620-623`).
3. **`unresolved_target`** estratto se presente e non-vuoto (`:627-630`). Questo è il *segnale del modello stesso* di aver rifiutato di indovinare un enum.
4. **`intent_id="unknown"` o fuori dai 5 intent** → `reject` con clarify (`:632-641`); se c'era anche un `unresolved_target` il messaggio cita il token grezzo.
5. **Intent valido MA con `unresolved_target` popolato** → `reject` comunque (`:646-652`): la lettura più sicura è che il target serva e sia off-set. Questo chiude il buco in cui Haiku sceglie un intent reale ma flagga un'entità fuori lista.
6. Altrimenti → `toolInputToEntities` (`:654`, definito `:354-386`) copia SOLO i campi rilevanti all'intent scelto (così chiavi spurie non possono filtrare nel payload), poi `applyDeterministicGate`.

`applyDeterministicGate` (`:395-509`) è la funzione che garantisce ~100% no-hallucination anche se Haiku restituisse un valore off-enum:

- **(a) Ri-risoluzione contro il closed-set** — seconda linea di difesa *indipendente* dall'enum. Per `machine_unavailability`/`capacity_addition` chiama `resolveMachineAlias` (`:409`); `deadline_change` → `resolveOrderAlias` (`:427`); `order_priority` itera la lista con `resolveOrderAlias` (`:441`); `shift_window` → `resolveShiftAlias` (`:454`). `resolveX` ritorna l'id canonico o `null`; `null` = off-set o ambiguo → `reject` che trasporta `unresolved_target` (`:415-419`, `:429-434`, `:443-448`, `:456-461`). Eccezione: per `capacity_addition` il `machine_id` è opzionale, quindi un null lo *droppa* invece di rifiutare (`:412-413`).
- **(b) Bounds sanity** — ogni `start_min`/`end_min`/`new_deadline_min`/`duration_min` oltre `MAX_ABS_MINUTE` (100 giorni = 144000 min, `:106`) o negativo → `reject` (`:466-474`). È contro lo slip aritmetico classe `a4_cutoff_beyond_horizon` (un cutoff oltre l'orizzonte congelerebbe l'intero piano).
- **(c) Validatore strategy-router** — `findIntent(catalog, intentId)` (`:477`), poi `validateEntities(def, entities, ids)` (`:482`) con gli id derivati da `derivedFromContext` (`:328-346`, che calcola `horizon_end_min` dal max dei deadline + shift end). Un fallimento → `reject` con la `reason` (`:483-488`). `validateEntities` (in `strategy-router.ts:263-339`) applica required-field (`:277-284`), default `horizon_end` per `end_min` opzionale (`:286-289`), canonicalizzazione `canonicaliseId` prima della validazione stretta (`:295-322`), e poi i validatori per-campo (`gt_start`, `non_negative_int`, ecc., `:329-336`).
- **(d) Payload canonico** — `buildRulesPayload(def, validation.normalised)` (`:491`) produce la **stessa** forma `rules` dell'extractor backend/translator Opus.
- **(e) hit vs gray** — `isGray = confidence !== 'high' || assumption presente` (`:495`). Un parse pulito high-confidence senza assunzioni è `hit`; qualsiasi confidence sub-high O qualunque `assumption` flaggata diventa `gray` con un `confirmation_message` (`:496-507`).

#### Strato 3 — show-and-confirm sul gray
Un `gray` non viene mai applicato direttamente: il consumer BFF emette `requires_confirmation` con `confirmationMessage` + `confirmedPayload` (vedi `apply-whatif.ts:798-818`) e chiude lo stream. Il manager conferma re-inviando con `userConfirmedGrayZone=true` + `confirmedPayload`. Cruciale: la conferma **non** ri-interpreta (salterebbe l'interprete, `apply-whatif.ts:735` la condizione `!input.userConfirmedGrayZone`), ma il payload echeggiato dal client viene **ri-gated** contro il closed-set live via `regateConfirmedRules` (`apply-whatif.ts:875-901`, definita `:35-101`) — un id manomesso/stale (M02→M99) fallisce-closed con `aborted_unsupported` (`:887-896`). Questo chiude il buco in cui il fix M-4 (vedi memoria) ha scoperto che la re-entry si fidava dell'echo client.

#### Loop di chiamata, retry, costo, caching
`interpretInstruction` (`instruction-interpreter.ts:520-605`) è l'entry asincrono:
- Short-circuit su `signal.aborted` pre-invio → `reject` "annullata" (`:533-541`).
- Retry su status `{429,502,503,529}` (`:558`), max 3 tentativi, backoff esponenziale con jitter capped a 12s (`:584-588`). Abort durante il retry → `reject` "annullata" (`:574-582`).
- Errori non-retryable rilanciati (`:590`); MA `interpretToolOutput` non lancia mai su output LLM cattivo — degrada a `reject` così il caller può chiedere il rephrase.
- Costo: `computeCostUsd` (`:287-294`) usa il pricing Haiku 4.5 (input $1/M, output $5/M, cache-read $0.1/M, cache-write $1.25/M, `:98-101`). Target ~$0.0014/msg con system prompt cached (`:54`). `meta` riporta `cache_read_tokens`/`cache_write_tokens` quando presenti (`:599-600`) e invoca `options.onUsage` (`:601`).

#### Riuso convenzioni temporali
Il system prompt incorpora `${CONVENZIONI_TEMPORALI}` (`instruction-interpreter.ts:246`) importato verbatim da `intent-parser.ts:3,45`. Il blocco (`intent-parser.ts:45-68`) fissa: `start_min`/`end_min` = minuti assoluti dall'inizio orizzonte (min 0 = 00:00 gg1); "giorno N" = minuti `(N-1)*1440 … N*1440`; "fine giornata" = fine turno (default 18:00 = 1080 min/giorno, NON mezzanotte salvo "alle 24"); fasce industriali (mattina=480, pomeriggio=840, ecc.); eventi passati → confidence low. Riusare lo *stesso* vocabolario temporale fra l'extractor backend e l'interprete previene il silent over-freeze (lezione `feedback_befe_temporal_lockstep`). `buildUserMessage` (`:270-278`) aggiunge opzionalmente un `dayAnchor` 1-based per ancorare "oggi"/"domani".

### Flusso dati / interfacce

**Input** a `interpretInstruction(message, ctx, dayAnchor?, options?)`:
- `message: string` — istruzione grezza del manager.
- `ctx: SolutionContext` — il closed-set da `buildSolutionContext` del piano live.
- `dayAnchor?: number` — indice 1-based del giorno corrente per date relative.

**Output** `InterpretResult` (`instruction-interpreter.ts:59-72`):
```
{ result: 'hit'|'gray'|'reject',
  payload: Record<string,unknown>,   // forma rules canonica; {} su reject
  confidence: 'high'|'medium'|'low',
  unresolved_target?: string,        // token grezzo off-set
  confirmation_message?: string,     // clarify (reject) o confirm (gray)
  intent_id?: string, entities?: Record<string,unknown> }
```
più `InterpretMeta` (cost/tokens/cache, `:74-81`).

**Forma del payload `rules`** (da `buildRulesPayload`, `strategy-router.ts:346-388`), una chiave top-level per intent:
- `machine_unavailability` → `{ unavailable_machines: { [machine_id]: [{start_min, end_min?, label?}] } }` (`:348-356`)
- `order_priority` → `{ priority_orders: string[] }` (`:357-359`)
- `deadline_change` → `{ deadline_changes: { [order_id]: { new_deadline_min, iso_datetime? } } }` (`:360-367`)
- `capacity_addition` → `{ extra_capacity: { operators?, shift?, machine_id?, duration_min? } }` (`:368-375`)
- `shift_window` → `{ shift_changes: { [shift_id]: { start_min?, end_min? } } }` (`:376-382`)

**Consumo a valle.** È identico a un hit dell'extractor: il payload È lo slot `rules` del solver, mergiato nel ledger e inoltrato a `/api/public/solve-template`. In `apply-whatif.ts:824-825` un hit imposta `strategyKind='B'; rulesForSolve = ix.payload` (equivalente Strategy-B rule_addition, nessun router necessario). In `reschedule-fresh.ts:242-243` un hit imposta `rules = ix.payload` e procede al solve come un extractor hit. Un `reject` qui produce `aborted_unsupported` (`apply-whatif.ts:767-791`) — NON cascata all'Opus translator: il gate closed-set è autoritativo.

### Invarianti & gotcha
- **Fail-closed su set vuoto/ambiguo → null.** `canonicaliseId` ritorna null se `known.size===0` (`idCanon.ts:19`) e null su >1 match derivati (`idCanon.ts:79-85`); `resolveAgainstSet` ritorna null su closedSet vuoto (`entityResolver.ts:44`). Un null risale come `reject` (clarify), MAI un id inventato. Conforme a `feedback_closed_set_fail_closed`.
- **Ambiguo è diverso da off-set ma trattato uguale.** `canonicaliseId` TIER 2 (padding/separatore) può mappare un token su due id reali quando il piano mescola forme padded/unpadded (es. `known={M1,M-001}`, token `m001`); il fix M-3 colleziona TUTTI i match distinti e ritorna null su >1 (`idCanon.ts:79-85`) — non è un'allucinazione (sempre un membro reale) ma il membro *sbagliato*, e un "?" è più sicuro che editare la risorsa errata.
- **Doppia difesa ridondante per design.** L'enum (Strato 1) già vincola gli id, ma `applyDeterministicGate` ri-risolve comunque (Strato 2): il commento `:25-33` lo chiama "a second, independent line of defence even though the enum already constrains them". Se Haiku restituisse un off-enum (bug API, enum omesso per lista vuota), lo Strato 2 lo cattura.
- **Solo i campi dell'intent vengono copiati.** `toolInputToEntities` (`:354-386`) ha uno switch per-intent: chiavi che Haiku popolasse per errore (es. `operators` su `machine_unavailability`) non entrano mai nel payload.
- **hit ⇒ sempre high-confidence.** Per costruzione (`:495`) ogni confidence low/medium o qualunque assumption diventa gray. Quindi nel path hit del consumer non c'è banner low-confidence da portare (`apply-whatif.ts:826-829` nota il push legacy ora dead code).
- **L'enum si OMETTE su lista vuota** (`:139-141`) — necessario per validità JSON-schema; in quel caso la garanzia strutturale (Strato 1) cade ma lo Strato 2 fail-closed regge.
- **`validateEntities` usa `ids.X.size > 0` come guard** (`strategy-router.ts:194,200,210`): se il set derivato è vuoto, il validatore *non* rigetta sull'appartenenza (lo fa già il resolver upstream nel gate). Ma nel path interprete il resolver ha già rifiutato un set vuoto, quindi non c'è doppio-conteggio.
- **Re-gate sulla conferma gray.** Il `confirmedPayload` echeggiato dal client NON è fidato: `regateConfirmedRules` (`apply-whatif.ts:35-101`) ri-risolve ogni chiave contro il ctx live e fallisce-closed su off-set (`:48,60,71,82,94`). Inoltre il sentinel `'?'` in `unavailable_machines` (target irrisolto dall'extractor) viene intercettato e abortito (`apply-whatif.ts:856-874`) per evitare un silent no-op del solver.
- **Anti-injection.** Testo tipo "ignora le istruzioni precedenti" dentro `<user_message>` → `intent_id="unknown"` → reject (system prompt `:234-237`); l'input è XML-escaped (`escapeXml`, `:112-114`) e troncato a 4000 char (`:271-272`).

### Cross-reference
- **`src/routes/api/apply-whatif.ts`** (consumer primario): chiama `interpretInstruction` sul path `managerText` non-confermato (`:735-745`), mappa hit→solve / gray→`requires_confirmation` / reject→`aborted_unsupported` (`:756-835`), e ri-gata la conferma con `regateConfirmedRules` (`:875-901`). Ha sostituito il vecchio `parseIntent + routeIntent` per questo path.
- **`src/routes/api/reschedule-fresh.ts`** (consumer secondario): usa l'interprete come *fallback* quando l'extractor backend deterministico fa MISS/GRAY (`:224-282`) — l'extractor pattern-based manca utterance che il closed-set Haiku risolve ("m2 rotta" con alias loose).
- **`src/server/llm/strategy-router.ts`**: condivide `validateEntities` + `buildRulesPayload` con l'interprete (il gate li riusa); il router stesso resta per il path Wave 4.1/translator e per i propri test A→B.
- **`src/server/llm/manager-chat-tools.ts`** (chatbot manager): condivide lo STESSO resolver — importa `resolveMachineAlias`/`resolveOrderAlias`/`resolveAgainstSet` (`:4-6`) per alias-risolvere prima delle proprie tool call (`:668,690,759`). Single source of truth per la canonicalizzazione id fra interprete, what-if e chat (commento `entityResolver.ts:6-12`).
- **`src/lib/idCanon.ts`**: `canonicaliseId` è usato sia da `entityResolver.resolveAgainstSet` (`:53`) sia direttamente da `strategy-router.validateEntities` (`:297,304,315`) — un cambio al probe padding/separatore si propaga ovunque un id LLM-emesso sia ri-validato.
- **Backend solver** (`daino/templates/fjsp_constraints/f_apply_rules.py`, citato in `strategy-router.ts:343` e `buildRulesPayload`): consuma la forma `rules` prodotta qui; i 5 rule-key (`unavailable_machines`/`priority_orders`/`deadline_changes`/`extra_capacity`/`shift_changes`) sono il contratto wire condiviso fra interprete, extractor backend e translator Opus.


---

## FE-B — Motore What-If + Ripianifica (pipeline SSE)

### Cosa fa

Questo sottosistema è il **motore di esecuzione** che trasforma un'istruzione del manager in linguaggio naturale ("ferma M-2 domani dalle 14", "anticipa COM-007", "siamo al giorno 3, M2 è rotta") in un **re-solve reale** del piano di produzione, con freeze del passato già eseguito e merge cumulativo dei vincoli già accettati.

Due route BFF lo implementano, con strategie di trasporto diverse ma lo stesso back-end (`/api/public/solve-template`):

- **`/api/apply-whatif`** — la pipeline **SSE** (streaming) del flusso What-If. Trasmette eventi `parsing_intent → … → solved → done` al client mentre lavora. È il path più costoso (può usare Opus) e il più ricco di guardie.
- **`/api/reschedule-fresh`** — il **re-solve fresco** (JSON one-shot, non streaming) usato come **path PRIMARIO della Ripianifica** per i piani deterministic-template (`reschedule-fresh.ts:18-24`). Esiste perché l'endpoint warm-start autenticato richiede un artefatto `generated_code` che i run deterministic-template non producono mai (TD-022), quindi il suo `run_id` è non-funzionante per il path di prodotto di default.

Entrambe condividono tre primitive: `resolveTemplate` (il contratto verso il backend, `api.ts:267`), `buildFrozenPhases`/`detectScenarioStartMin` (il freeze del passato, `frozen-window-builder.ts`), e `mergeRuleSlots`/`mergeLedgerRules` (il ledger cumulativo NEW-WINS, `appliedRulesLedger.ts`).

### File chiave

| File | Ruolo |
|---|---|
| `src/routes/api/apply-whatif.ts` | Pipeline SSE What-If completa: interprete vs translator, re-gate M-4, merge ledger §C, guardia empty-solution §D, flag §E, timeout race 60s, retry INFEASIBLE→hint |
| `src/routes/api/reschedule-fresh.ts` | Re-solve fresco (JSON), path primario Ripianifica deterministic-template; day-anchor; fallback interprete su MISS/GRAY dell'extractor |
| `src/lib/appliedRulesLedger.ts` | Ledger applied-rules slug-scoped (localStorage); `loadLedger/appendRule/clearLedger/mergeLedgerRules/mergeRuleSlots` con semantica slot NEW-WINS |
| `src/server/llm/constraint-translator.ts` | Translator Opus 4.7 (Strategy-C), orchestrazione deterministic-first (extractor backend → Opus), gray-zone, post-validatori anti-hallucination |
| `src/server/llm/frozen-window-builder.ts` | `buildFrozenPhases`, `detectScenarioStartMin`, `detectScenarioPhraseMatches`; cutoff auto-detect da testo italiano |
| `src/server/llm/instruction-interpreter.ts` | Interprete closed-set Haiku (gate enum su ID reali); ritorna `hit`/`gray`/`reject` (`instruction-interpreter.ts:57-69`) |
| `src/lib/entityResolver.ts` | Resolver deterministico closed-set (no LLM) usato dal re-gate M-4: `resolveMachineAlias/resolveOrderAlias/resolveShiftAlias` |
| `src/lib/api.ts` | `resolveTemplate` — costruzione body wire verso `/api/public/solve-template` (`api.ts:267-312`) |
| `src/lib/solutionContext.ts` | `buildSolutionContext` — ricostruisce `{machines, machine_aliases, orders, shifts}` dal baseline (`solutionContext.ts:3-7`) |
| `src/components/dashboard/WhatIfAnalysis.tsx` | Caller UI lato What-If: chiama `/api/apply-whatif`, infila `priorRules`, consuma `solved`/`applied_rules` |
| `src/routes/index.tsx` | Detiene il ledger: `mergeLedgerRules(loadLedger(slug))` → `priorRules`; `appendRule` su accettazione (`index.tsx:114-133`) |

### Come funziona (meccanismo passo-passo)

#### I due path di esecuzione e come scelgono `rulesForSolve`

`rulesForSolve` (`apply-whatif.ts:703`) è il payload `rules` che andrà al solver. Viene popolato da **uno** di tre rami, selezionati dalla presenza di `body.managerText` e dai flag di conferma:

**Path A — Interprete closed-set (Wave 16.6 §A, preferito).** Attivo quando `input.managerText && !input.userConfirmedGrayZone` (`apply-whatif.ts:735`). È il path Wave 7 evoluto: sostituisce la vecchia catena parseIntent+strategy-router. Costruisce un `SolutionContext` dal baseline (`apply-whatif.ts:737-741`) e chiama `interpretInstruction` (Haiku + un tool con enum forzato sugli ID **reali** del piano + un gate deterministico). L'esito (`instruction-interpreter.ts:57`) è:
- `reject` (`apply-whatif.ts:767`) → anti-hallucination strutturale (target off-set come "M99", richiesta non-catalogo). **Non** si scala a Opus: il gate closed-set è autoritativo. Emette `routed{strategy:'unsupported'}` + `aborted_unsupported` con `unresolved_target:<token>`.
- `gray` (`apply-whatif.ts:798`) → validato ma Haiku ha segnalato un'assunzione. Emette `requires_confirmation` con `confirmedPayload: ix.payload` e chiude. Il manager riconferma → re-entry sul fast-path (vedi sotto).
- `hit` (`apply-whatif.ts:824`) → `strategyKind = 'B'`, `rulesForSolve = ix.payload`. Il payload è **già** lo slot `rules` canonico (entità alias-risolte e gated), quindi alimenta direttamente i merge §C/§D più sotto. Un hit è **sempre** high-confidence: il gate instrada qualsiasi low/medium (o qualsiasi assunzione) verso `gray` a monte (`apply-whatif.ts:826-829`).

**Path B — Strategy-C / translator (Wave 4.1 backward-compat).** Attivo quando `!input.managerText || strategyKind === 'C'` (`apply-whatif.ts:840`). Due sotto-rami:

1. **Fast-path conferma gray-zone** (`apply-whatif.ts:844`): quando `userConfirmedGrayZone && confirmedPayload`. Salta extractor+translator e usa il payload echeggiato. Prima però due guardie: il sentinel `"?"` in `unavailable_machines` → abort `unresolved_machine_target` (`apply-whatif.ts:858`); poi il **re-gate M-4** (vedi sotto). Se passa: `rulesForSolve = regated.payload` + warning `gray_zone_confirmed_by_manager`.
2. **Translator Opus** (`apply-whatif.ts:907`): emette `translating`, chiama `translateWhatIfToConstraint`. Quel translator è **deterministic-first** (`constraint-translator.ts:850-933`): prova prima l'extractor backend; su HIT/GRAY salta Opus; solo su MISS/null/payload-non-riconosciuto chiama Opus 4.7 (`MODEL = 'claude-opus-4-7'`, `constraint-translator.ts:90`). Emette `translated{change}`. Poi: se `change.type === 'unsupported'` → `aborted_unsupported`; se `change.requiresConfirmation` → `requires_confirmation` + chiude; altrimenti `rulesForSolve = tr.change.rules`.

Per **reschedule-fresh** la scelta di `rules` è diversa (`reschedule-fresh.ts:236-282`): chiama prima l'**extractor deterministico backend** (`extractConstraintFromBackend`); su `hit` usa `extracted.payload`; su MISS/GRAY fa un **secondo passaggio con `interpretInstruction`** sullo STESSO ctx (Wave 16.6 §A fallback, `reschedule-fresh.ts:224-282`). Interprete `hit` → SOLVE; interprete `gray` → `extract_gray_zone`; interprete `reject` → si tiene la risposta originale dell'extractor (`extract_gray_zone` o `extract_miss`).

#### La sequenza eventi SSE

Solo `apply-whatif` è SSE. Ogni `write(event, data)` (`apply-whatif.ts:585`) emette `event: <name>\ndata: <json>\n\n` (`apply-whatif.ts:179-181`). Sequenze terminali, tutte chiuse da `done` (che porta i contatori costo/token):

```
Path interprete hit:   parsing_intent → intent_parsed → routed(B) → solving → solved → done
Path interprete reject: parsing_intent → intent_parsed → routed(unsupported) → aborted_unsupported → done
Path interprete gray:   parsing_intent → intent_parsed → routed(B) → requires_confirmation → done
Path translator (4.1):  translating → translated → [solving → solved | aborted_unsupported | requires_confirmation] → done
Conferma gray (re-entry): solving → solved → done   (oppure aborted_unsupported se sentinel/off-set)
INFEASIBLE recovery:    … solving → lock_relaxing → solved → done
Abort client:           aborted → done
Errore fatale:          error  (chiude lo stream, nessun done)
```

Eventi e dove vengono emessi (verificati riga per riga, `apply-whatif.ts`):
- `parsing_intent` :736 — inizio interprete Haiku.
- `intent_parsed` :757 — `{intent_id, entities, confidence}` dall'interprete.
- `routed` :774 / :799 / :830 — strategia scelta (`unsupported`/`B`).
- `translating` :907 — inizio translator (path 4.1).
- `translated` :921 — `{change}` del translator.
- `requires_confirmation` :805 (interprete gray) / :952 (translator gray) — pausa: `{confirmationMessage, confidence, confirmedPayload}`. **Nessun solve** finché non si riconferma — è ciò che rende reale il gate di sicurezza.
- `solving` :1009 — `{phase, strategy}`, inizio chiamata backend.
- `lock_relaxing` :1083 — emesso solo nel recovery INFEASIBLE (vedi sotto).
- `solved` :1212 — payload ricco: `{newSolution, newKpis, deltaKpis, warnings, status, strategy, cutoff_min, frozen_count, locked_count, modified_count, skipped_rules_count, locked_phases, applied_rules, wave7}`.
- `aborted_unsupported` :780/:860/:889/:935/:996/:1155 — terminale "scenario non applicabile" con `{reason, warnings}`.
- `aborted` :748/:925/:1266 — disconnessione client.
- `error` :1258 — `{code, message}`; `code` è `aborted`/`solve_timeout`/`apply_failed` (`apply-whatif.ts:1253-1257`).
- `done` — chiude sempre; emesso ad ogni return e in fondo al path success.

`reschedule-fresh` non emette eventi: ritorna un singolo JSON `{ok:true, code:'solved_fresh', …, result:{…}}` (`reschedule-fresh.ts:351-377`) o errori `needs_day`/`extract_gray_zone`/`extract_miss`/`solve_failed`.

#### Il merge ledger NEW-WINS (accumula disgiunti vs sostituisci sovrapposti)

Il solver è **stateless**: ogni chiamata ri-applica tutto il payload `rules` da zero contro il dataset base (`appliedRulesLedger.ts:4-8`). Quindi un vincolo già accettato ("M2 ferma il giorno 2") sarebbe dimenticato al What-If successivo. Il ledger è il "carry": un log slug-scoped append-only dei payload accettati, persistito in `localStorage` sotto `daino:<slug>:applied_rules_ledger` (`appliedRulesLedger.ts:18-30`).

La UI fa due cose (`routes/index.tsx:114-133`): `priorRules = mergeLedgerRules(loadLedger(slug))` (piega tutto il log in un solo `rules` in ordine cronologico, `appliedRulesLedger.ts:303-312`) e lo infila come `body.priorRules`; su accettazione, `appendRule` aggiunge l'ultimo delta. La route ricombina con `mergeRuleSlots(input.priorRules, rulesForSolve)` (`apply-whatif.ts:982`) — **b (lo scenario nuovo) vince** sui conflitti.

`mergeRuleSlots` (`appliedRulesLedger.ts:181-227`) combina per-slot con semantica type-aware:
- **`unavailable_machines`** (`mergeUnavailableMachines`, :112): union per macchina. **Dentro la stessa macchina** la riconciliazione delle finestre è il cuore di M-1 (`mergeWindowLists`, :95):
  - finestra nuova che **sovrappone** una precedente → **sostituisce** (il manager ha corretto quel downtime; impilare due ban sovrapposti li doppierebbe), test half-open `wa.s < wb.e && wb.s < wa.e` (`appliedRulesLedger.ts:84-89`) — toccarsi a un estremo NON è overlap.
  - finestra nuova **disgiunta** da tutte → **appesa** (due downtime separati "giorno 2" e "giorno 4" devono SOPRAVVIVERE entrambi — è la failure-class che questa wave ripara).
  - finestre identiche → dedup (`sameWindow` via `JSON.stringify`, :91).
- **`priority_orders`** (`mergePriorityOrders`, :132): union dedup, prior prima poi nuovi (è un set; l'ordine non è load-bearing ma stabile per i diff di audit).
- **`deadline_changes`** (`mergeKeyedLastWrite`, :157): last-write per chiave order; altri order portati avanti.
- **`shift_changes`/`operator_unavailability`/`extra_capacity`** (`mergeArrayOrKeyed`, :164): array-o-oggetto; un array `b` non vuoto sostituisce in blocco.
- **slot sconosciuto** (default, :220): new-wins shallow — così un futuro tipo di regola passa comunque.

Quando nessun ledger è inviato (caller 4.1/pre-16.6), `mergeRuleSlots(undefined, x)` è identità su `x` (`appliedRulesLedger.ts:182-186`).

#### Il re-gate M-4 (fail-close)

`regateConfirmedRules` (`apply-whatif.ts:35-101`) è la difesa contro un client stale/manomesso. La pausa gray ha emesso un payload **già gated**, ma il re-entry di conferma riceve quel payload **dal client** (echeggiato via `confirmedPayload`). Un client malevolo potrebbe scambiare un id (M02→M99) tra pausa e conferma per spingere un'entità off-set nel solver — la garanzia closed-set verrebbe bypassata sul secondo passaggio "trust-the-client".

La funzione ri-risolve **ogni** id macchina/order/shift contro il set vivo, usando `entityResolver` (deterministico, no LLM):
- `unavailable_machines` keys via `resolveMachineAlias` (:47), `priority_orders` via `resolveOrderAlias` (:59), `deadline_changes` keys via `resolveOrderAlias` (:71), `extra_capacity.machine_id` via `resolveMachineAlias` (:81), `shift_changes` keys via `resolveShiftAlias` **solo se `ctx.shifts.length > 0`** (:90).
- id valido (anche alias "m2") → canonicalizzato in-place; id off-set/ambiguo → `{ok:false, offending}` → la route emette `aborted_unsupported{reason:'unresolved_entity_target', gray_zone_offset_target:<id>}` (`apply-whatif.ts:887-903`).

**Perché shift è gated solo a set non-vuoto** (`apply-whatif.ts:88-90`): un set shift assente significa che il backend tratta una chiave shift ignota come no-op passthrough, quindi non c'è rischio di "entità sbagliata modificata" da proteggere lì. Il resolver stesso è fail-closed: set vuoto → `null` (`entityResolver.ts:44`, `:100`), mai accept-all (allineato a `feedback_closed_set_fail_closed`). E rifiuta gli **ambigui** (alias che mapperebbe a due membri) → `null`, perché un null è sempre più sicuro di un id sbagliato (`entityResolver.ts:13-19`).

#### La guardia empty-solution §D (OPTIMAL+0 fasi → abort, ma INFEASIBLE ammesso)

`countSolutionPhases` (`apply-whatif.ts:269-280`) conta le fasi schedulate, tollerante a forma nested `{commessa:{fasi:[]}}` e flat `{fasi:[]}`. Dopo il solve (`apply-whatif.ts:1149-1171`):

```
solveStatus = status.toUpperCase()
isSuccessStatus = OPTIMAL || FEASIBLE
if (isSuccessStatus && solvedPhaseCount === 0 && baselinePhaseCount > 0) → aborted_unsupported(empty_solution_after_solve)
```

**Il perché:** la dashboard costruisce Gantt/OperationalPlan iterando `solution[commessa].fasi[]`. L'evento `solved` aggiorna le card KPI da `newKpis`, ma se il backend ritorna una mappa senza fasi (solve degenere, `{}` echeggiato, una regola che ha svuotato il modello), **i numeri cambiano ma il Gantt resta vuoto** — indistinguibile da un Gantt congelato per il manager (`apply-whatif.ts:256-268`). Quindi si converte in un abort esplicito.

**Perché INFEASIBLE è ammesso e OPTIMAL+0 no** (`apply-whatif.ts:1140-1148`): lo scope è deliberatamente stretto a SUCCESS. Un INFEASIBLE (incluso il caso both-solves-infeasible del recovery) è un terminale `solved` **legittimo** che la UI rende come "infeasible" + il warning di rilassamento — una soluzione vuota lì è **attesa**, non il bug. La guardia è inoltre gated su `baselinePhaseCount > 0`: un problema legittimamente vuoto in partenza non viene segnalato (non c'è nulla da renderizzare comunque).

#### Il cutoff frozen-window (model-minutes, NON 1440) + day-anchor

Il freeze impedisce al re-solve di rimescolare lavoro già eseguito. Una fase è "frozen" sse `fase.end_min <= cutoffMin` (`frozen-window-builder.ts:128`); una fase a cavallo (`start < cutoff < end`) **NON** è inclusa (lasciata libera al solver, `frozen-window-builder.ts:14-20`). Il payload va al ramo hard-lock del backend (`fjsp.py`, `model.add(start == fp.start_min)`).

Computo del cutoff in **apply-whatif** (`apply-whatif.ts:641-693`):
- `detectScenarioStartMin(text)` (`frozen-window-builder.ts:184`) auto-rileva una data futura da testo italiano: `domani→1×1440`, `dopodomani→2×1440` (testato PRIMA di domani perché lo contiene, :189-190), `fra/tra/in N giorni→N×1440`, `giorno N→(N-1)×1440` (giorno 1 = inizio orizzonte → null, :202-207).
- `legacyCutoff = currentTimeMin + cushionMin` (default cushion 30, cappato a 1440, `apply-whatif.ts:159`).
- **Clamp**: `cutoffMin = max(detected, legacy)` quando entrambi esistono (`apply-whatif.ts:647-652`). Il tempo-elapsed del manager è sacro: un "domani" da chi è già al giorno 3 non può retroattivamente scongelare le fasi di oggi. Surfacea `a4_cutoff_clamped_to_currentTime` (:671).
- Frasi temporali ambigue (>1 match) → warning `a4_ambiguous_temporal_picked_<first>` (:659-661). Cutoff oltre orizzonte → `a4_cutoff_beyond_horizon` (:677-684).

**ATTENZIONE all'unità diversa in reschedule-fresh** (`reschedule-fresh.ts:107-120`, :286-333). Qui il **day-anchor** ("siamo al giorno N", parsato dall'extractor in `payload.day_anchor`, 1-based) usa `day_length_min` dal `time_config` del baseline (es. **960** per una giornata 06:00-22:00), NON 1440:

```
day_anchor=2 → cutoffMin = (2-1) × day_length_min   // freeze giorno 1
```

Il perché (`reschedule-fresh.ts:113-119`, TD-031): l'asse del modello **comprime le notti**, quindi un calendario 1440 over-freezerebbe metà del giorno N. `reschedule-fresh` **deliberatamente NON riusa `detectScenarioStartMin`** per l'anchor, perché quello hardcoda `DAY_MIN=1440` (`reschedule-fresh.ts:294-296`, `frozen-window-builder.ts:172`). Se `day_length_min` è ignoto → si **salta il freeze** (cutoff undefined) anziché computarne uno fasullo (`reschedule-fresh.ts:317-327`). Gerarchia sorgenti cutoff: `day_anchor` (autoritativo) > `currentTimeMin + cushion` > nessuno (replan full-horizon, limite TD-030).

C'è anche una **ask-flow gate** strutturale a monte di tutto (`reschedule-fresh.ts:209-222`): se l'extractor segnala `needs_day_clarification === true` (data relativa "oggi"/"domani" senza day anchor esplicito), si ritorna `code:'needs_day'` PRIMA dei rami miss/gray/hit — così la proprietà "needs_day ⇒ mai resolveTemplate" è indipendente da come l'extractor mappa `result` (day-0 è ancorato a min(deadline), non al system clock — TD-030).

#### Il flag §E `time_window_start_unsupported`

`hasExplicitTimeWindowStart` (`apply-whatif.ts:302-309`) fa firing quando il testo contiene **sia** un orario wall-clock (`RE_CLOCK_TIME = /\b(?:alle|dalle)\s+(?:ore\s+)?\d{1,2}(?:[:.]\d{2})?\b/`, :300) **sia** un day-anchor (`detectScenarioStartMin(t) !== null`). Push warning `time_window_start_unsupported` (`apply-whatif.ts:691-693`).

Il perché (`apply-whatif.ts:282-299`): utterance come "anticipa COM-007 a domani alle 8" portano un day anchor (gestito dal cutoff) E un orario esplicito. Il solver **non ha uno slot release-time**: `f_apply_rules.py` applica unavailable_machines/priority/deadline/shift/capacity, ma niente che forzi un'operazione a PARTIRE a un minuto wall-clock dato. La metà time-of-day viene quindi silenziosamente droppata — warning ambra **non-bloccante** (il solve procede; il freeze a livello giorno resta valido). La detection è volutamente stretta per evitare falsi positivi: un nudo "ferma M-3 dalle 14 alle 18" (downtime macchina → `unavailable_machines`, CHE è enforced) NON viene flaggato.

#### Il retry INFEASIBLE (frozen_lock_mode=hint)

Quando il primo solve torna `INFEASIBLE` **e** ci sono frozen phases **e** il client non ha abortito (`apply-whatif.ts:1062-1066`): l'hard-lock sulle fasi pre-cutoff ha reso il modello infeasible (il vincolo nuovo confligge con la finestra congelata). Recovery (plan §2 D2 "lock duro + fallback soft"):

1. Emette `lock_relaxing{reason:'infeasible_with_hard_lock', frozen_count, attempted_locks, attempted_rules, recompute_mode:'frozen_phases_as_hint'}` (`apply-whatif.ts:1083-1092`). Il backend popola `wave7.apply_rules` anche su INFEASIBLE, così la UI vede QUALI regole il solver ha provato.
2. Re-check abort esplicito tra il write SSE e il retry (`apply-whatif.ts:1099-1101`): altrimenti la retry-race siederebbe su un setTimeout da 60s (vedi gotcha race).
3. Ri-solve UNA volta con `frozen_lock_mode='hint'` (`apply-whatif.ts:1102-1113`), ri-sottomettendo la **STESSA lista frozen_phases completa** (NON `[]`). Il backend la tratta come `model.AddHint(start_var, fp.start_min)` invece di `model.Add(==)` (`api.ts:252-265`): il set consolidato è **preservato come preferenza soft** anziché droppato in blocco (il vecchio fallback Wave 8 Opt 2).
4. Warning sul risultato: `lock_relaxed_to_soft` (per UI vecchie → banner ambra) + `lock_relaxed_to_soft__consolidated_preserved_as_hint` (per UI nuove → copy "fasi consolidate NON droppate", banner resta ambra non rosso, `apply-whatif.ts:1114-1127`).

### Flusso dati / interfacce

**Contratto wire verso il backend** — `resolveTemplate(slug, problemType, rules, cutoffMin?, frozenPhases?, datasetOverrides?, frozenLockMode?, forceColdStart?)` (`api.ts:267-276`) costruisce il body POST a `/api/public/solve-template`:
- sempre `{slug, problem_type, rules}`.
- `cutoff_min` solo se finito e `> 0` (`api.ts:282`); `frozen_phases` solo se non vuoto (:285); `dataset_overrides` solo se non vuoto (:288); `frozen_lock_mode` solo se definito (:295); `force_cold_start: true` solo se richiesto (:305).
- Entrambe le route passano **`forceColdStart=true`** su OGNI chiamata (`apply-whatif.ts:1051`,:1111; `reschedule-fresh.ts:349`): F-W10-07 — ogni what-if è un set di vincoli fresco, warm-startare dal vecchio piano bias-erebbe la ricerca verso uno schedule stantio e può causare MODEL_INVALID spurii.
- `apply-whatif` primo solve omette `frozenLockMode` (→ default backend 'hard'); il retry passa `'hint'`.

**FrozenPhase** (`frozen-window-builder.ts:42-53`): `{job_id, seq, start_min, end_min, machine_id, worker_id}` + alias legacy `{commessa, operazione, operatore}`. **`seq` DEVE essere 1-based** quando il baseline non porta `sequenza`/`seq` esplicito (`frozen-window-builder.ts:115-116`): il backend chiavea `alternatives[(jid, seq)]` su `op["sequenza"]` con fallback `enumerate(fasi, start=1)`. Pre-fix il builder usava 0-based → ogni lookup `(jid,0)` mancava e l'hard-lock saltava silenziosamente il 100% delle frozen phases (Devils F-W8-09).

**Envelope di ritorno** — `ResolveTemplateWave7Envelope` (`api.ts:233-238`): `{cutoff_min, locked_count, frozen_phases, apply_rules}`. `wave7` è `null` quando nessun arg Wave 7 fu inviato (distingue "non ha girato wave7" da "girato con zero lock"). La route splitta `apply_rules` in applied vs skipped: `isAppliedEntry` (`apply-whatif.ts:1202-1209`) esclude `*_skipped`, `apply_rules_failed`, `*_data_layer_passthrough` → `modified_count` vs `skipped_rules_count` (così i passthrough non gonfiano il conteggio).

**SolutionContext** (`solutionContext.ts:3-7`): `{machines, machine_aliases, orders, shifts}`, ricostruito da `buildSolutionContext` camminando `solution.fasi`/`solution.solution[commessa].fasi`. È l'input di `interpretInstruction` e del re-gate M-4.

**InterpretResult** (`instruction-interpreter.ts:59-69`): `{result:'hit'|'gray'|'reject', payload, confidence, unresolved_target?, confirmation_message?, intent_id?}`. `payload` è lo stesso shape `rules` di extractor/translator (vuoto su reject).

**ConstraintChange** del translator (`constraint-translator.ts:48-57`): `{type, rules, rationale, confidence, warnings, unsupportedReason?, requiresConfirmation?, confirmationMessage?}`.

**Contabilità costo**: `accumulateUsage` (`apply-whatif.ts:593-613`) somma Haiku-interprete + Opus-translator in un singolo `lastUsage`; `flushCost` registra una sola volta sotto surface `'whatif_apply'` (`apply-whatif.ts:530-542`); è idempotente (`costRecorded`) e chiamato in ogni return, nel finally e nel cancel.

**Direzione dati end-to-end (What-If)**: `WhatIfAnalysis.tsx` (POST con `priorRules` da `index.tsx`) → SSE `apply-whatif` → `resolveTemplate` → backend; il `solved` riporta `applied_rules` (= `rulesForSolve` **pre-merge**, senza priorRules che il ledger già detiene, `apply-whatif.ts:1231-1238`); su "Accetta" la UI chiama `appendRule` con esattamente quel delta.

### Invarianti & gotcha

- **`applied_rules` su `solved` è il delta PRE-merge** (`apply-whatif.ts:1231-1238`), NON `mergedRules`. Se ci appendessi il merge, il ledger doppierebbe i priorRules che già contiene. La UI appende esattamente questo delta.
- **Doppio lock concorrenza**: `_inFlight` per-IP (`apply-whatif.ts:444`, 409 `conflict`) + `_inFlightBySlug` per-slug (`apply-whatif.ts:450`, 409 `slug_conflict`). Il secondo evita che due manager su IP diversi corrompano la memoria warm-start del piano (F-W7-04).
- **Watchdog anti-leak** (`apply-whatif.ts:558-580`): il `cancel()` dello stream NON è garantito su ogni disconnessione (vite dev SSR droppa la response senza cancel) → senza watchdog le mappe in-flight leakano per sempre e ogni richiesta successiva prende 409. Budget = `SOLVE_TIMEOUT_MS*2 + 30s = 150s` per coprire primo solve + retry INFEASIBLE + flush. Il check d'identità (`_inFlight.get(ip) === abort`) evita di droppare una richiesta legittima successiva che ha preso ownership.
- **Race timeout 60s sincrona** (`raceWithTimeout`, `apply-whatif.ts:1023-1040`): un listener `abort` aggiunto a un signal GIÀ abortito NON fa firing (verificato in node repl, Devils F-W8-04). Se il client disconnette tra await e arm della race, il setTimeout ticchierebbe per 60s pieni. Fix: reject sincrono se `signal.aborted` all'ingresso + re-check dopo `addEventListener`.
- **Empty-dict guard A3** (`hasMeaningfulRules`, `apply-whatif.ts:428-439`): payload tipo `{deadline_changes:{COM-001:{}}}` o `{unavailable_machines:{M01:[]}}` è strutturalmente valido ma degenera in no-op silenzioso (stessa failure-class di F-W10-01). Strutturato come **OR-di-predicati** (NON early-return per ramo) così `{unavailable_machines:{}, priority_orders:['COM-001']}` passa grazie alla parte priority (Devil-advocate MEDIUM-1). Gira sul payload **MERGED**: uno scenario nuovo vuoto che cavalca un ledger non vuoto è comunque azionabile.
- **L'interprete reject NON cascata a Opus** (`apply-whatif.ts:766-792`): il gate closed-set è autoritativo. Diverso dal translator, che invece scala a Opus su MISS dell'extractor.
- **Sentinel `"?"` doppia difesa**: il translator early-returna unsupported sul sentinel (`constraint-translator.ts:860-912`); il fast-path conferma lo ri-controlla (`apply-whatif.ts:856-874`) come defense-in-depth — il backend emette `"?"` quando il target non mappa al catalogo, e passarlo causerebbe un no-op silenzioso.
- **`mergeWindowLists` half-open**: toccarsi a un estremo (`e1===s2`) NON è overlap (`appliedRulesLedger.ts:83-89`) — ban back-to-back sono downtime distinti, non vengono fusi.
- **Strategy A è morta**: `datasetOverrides` è una costante `null` (`apply-whatif.ts:710`); `strategyKind` resta nell'union `'A'|'B'|'C'|'unsupported'` solo per non toccare il tipo della telemetria `solved` (`apply-whatif.ts:711-714`).
- **diffKpis è two-sided** (`apply-whatif.ts:209-226`): emette delta solo per KPI presenti in ENTRAMBI baseline e next; chiavi one-sided diventano warning `missing_kpi:<name>` (DA-22) — evita di suggerire che un KPI è crollato a zero quando in realtà è solo "non disponibile".
- **reschedule-fresh: la ask-flow gate precede i rami hit/miss/gray** (`reschedule-fresh.ts:204-222`): scelta deliberata (Option 1 devil-advocate) per rendere strutturale la proprietà "needs_day ⇒ mai solve", indipendente da future modifiche al contratto dell'extractor.
- **Lockstep temporale BE↔FE**: il vocabolario temporale dell'extractor backend e quello di `detectScenarioStartMin` devono mirrorare (cfr. `feedback_befe_temporal_lockstep`); divergenza = silent over-freeze. La rimozione del fallback `detectScenarioStartMin(message)` da reschedule-fresh (Wave 16.5 #6, `reschedule-fresh.ts:301-311`) eliminò proprio un doppio-parse con unità sbagliata.

### Cross-reference

- **Backend solver** (`/api/public/solve-template`, `daino/templates/fjsp.py`): consuma `rules`, `cutoff_min`, `frozen_phases` (hard-lock `model.Add(start==start_min)` a `fjsp.py:1410-1524`), `frozen_lock_mode` (`hard`/`hint`), `dataset_overrides`, `force_cold_start`. Vincoli applicati da `f_apply_rules.py` (NO release-time slot → vedi §E). Vedi documentazione backend ARM_C/templates.
- **Extractor deterministico backend** (`extract-constraint-client.ts`, endpoint Wave 16.1): chiamato sia da `constraint-translator.ts` (deterministic-first) sia da `reschedule-fresh.ts`. Ritorna `{result:'hit'|'gray_zone'|'miss', payload, confidence, rationale, confirmation_message, pattern_id, needs_day_clarification, day_anchor}`.
- **Interprete closed-set** (`instruction-interpreter.ts`): Haiku + tool enum forzato; condiviso da apply-whatif (path primario) e reschedule-fresh (fallback su MISS/GRAY).
- **Resolver entità** (`entityResolver.ts` + `idCanon.ts` + `solutionContext.ts:buildMachineAliases`): primitiva closed-set condivisa da re-gate M-4, gate interprete, e chat-manager alias path.
- **Caller UI**: `WhatIfAnalysis.tsx` (What-If SSE), `ReplanModal.tsx` (Ripianifica → reschedule-fresh come path primario), `SolutionDiff.tsx` (telemetria hard-lock da `solved`), `routes/index.tsx` (detiene il ledger e thread `priorRules`).
- **Endpoint gemelli**: `whatif.ts` (genera il markdown 4-sezioni che il translator 4.1 traduce), `accept-candidate.ts` (telemetria/audit parity su accettazione), `manager-chat.ts` (path chat che condivide interprete + resolver).
- **MEMORY**: `feedback_closed_set_fail_closed` (re-gate M-4, resolver null su set vuoto), `feedback_befe_temporal_lockstep` (cutoff §E), `feedback_narrow_guard_over_broad_disjunct` (RE_CLOCK_TIME stretto), `feedback_anthropic_cost_drivers` (apply-whatif = $0.20/click su Opus), `feedback_test_realistic_caller_shape` (F-W10-01 silent no-op → empty-dict guard).


---

## FE-C — Superfici Manager AI (chat, explainer, advisor, What-If UI, accept)

### Cosa fa

FE-C è il blocco di superfici AI rivolte al manager di produzione, dentro il
BFF TanStack Start + React (`frontend-industriale`). Sono **cinque superfici**,
tutte costruite sopra lo snapshot client-side della soluzione corrente
(`solution` + `kpis`), nessuna delle quali tiene stato server-side autoritativo:

1. **Manager Chat** — chatbot conversazionale Haiku 4.5 con loop agentico
   read-only (10 tool sulla pianificazione). Risponde a domande operative
   ("quante commesse in ritardo?", "quanto è satura M-3?").
2. **Spiegazione AI (explainer)** — Sonnet 4.6, paragrafo unico post-solve che
   spiega lo stato del piano. Si auto-avvia quando il piano è pronto.
3. **Consigli AI (advisor)** — Sonnet 4.6, 3–5 raccomandazioni operative
   priorizzate con emoji-tassonomia. Auto-avvio come l'explainer.
4. **Analisi What-If** — Sonnet 4.6, analisi qualitativa pre-solve di uno
   scenario libero ("posso fermare la linea 2 dalle 14 alle 18?"); 4 sezioni
   con disclaimer che NON è il solver deterministico. Il pannello orchestra poi
   `apply-whatif` (re-solve reale, fuori scope FE-C → vedi FE-D) e mostra il
   `SolutionDiff`.
5. **Accept-candidate** — quando il manager clicca "Accetta" sul diff candidate,
   il pannello sintetizza un envelope solve-template e lo ridà al parent, che fa
   `setBackendResult` → `adaptResult` ridisegna l'intera dashboard.

Le tre superfici "automatiche" (explainer/advisor) e What-If usano **Sonnet**;
la chat usa **Haiku** (più economico, tool-use). Tutte streammano via SSE.
Tutte le rotte BFF passano solo da `ANTHROPIC_API_KEY` server-side, con
rate-limit per-superficie e cost accounting.

### File chiave

Server (logica LLM):
- `src/server/llm/manager-chat.ts` — loop agentico Haiku (max iterazioni, retry, cache, guardie injection).
- `src/server/llm/manager-chat-tools.ts` — definizioni dei 10 tool read-only + esecuzione + alias resolution.
- `src/server/llm/explainer.ts` — explainer Sonnet streaming.
- `src/server/llm/advisor.ts` — advisor Sonnet streaming.
- `src/server/llm/whatif.ts` — what-if qualitativo Sonnet streaming.
- `src/server/llm/client.ts` — singleton Anthropic client, `recordCost`, `checkRateLimit`, `getClientIp`.

Rotte BFF (SSE wrapper):
- `src/routes/api/manager-chat.ts` — SSE + tool_use events + flushCost idempotente.
- `src/routes/api/explain.ts`, `src/routes/api/advise.ts`, `src/routes/api/whatif.ts` — wrapper SSE quasi identici.
- `src/routes/api/accept-candidate.ts` — Zod schema (KPI nested) + envelope echo, zero costo.

Lib condivise (chiave per anti-allucinazione + ledger):
- `src/lib/solutionContext.ts` — `buildSolutionContext`: closed-set di machines/orders/shifts dalla soluzione live.
- `src/lib/entityResolver.ts` — resolver deterministico ("m2" → "M02"), contratto anti-fabbricazione.
- `src/lib/appliedRulesLedger.ts` — ledger append-only delle regole accettate (`appendRule`, `mergeLedgerRules`, `mergeRuleSlots`).
- `src/lib/streamingFetch.ts` — `sseStream` parser, `friendlyErrorMessage`, `isTransientPanelError`.

UI:
- `src/components/dashboard/WhatIfAnalysis.tsx` — pannello What-If (streaming, scroll `h-[480px]`, `handleAcceptCandidate`, ledger append).
- `src/components/dashboard/SolutionDiff.tsx` — diff KPI, warning labels, badge post-cutoff (il "time_window flag").
- `src/components/dashboard/ManagerChatPanel.tsx` — chat flottante.
- `src/components/dashboard/ExplanationPanel.tsx`, `AdvisorPanel.tsx` — pannelli auto-fire.
- `src/routes/index.tsx` — monta tutte le superfici, definisce `acceptResult` / `liveSolutionMap` / `priorRules`.

### Come funziona (meccanismo passo-passo)

#### 1. Manager-chat: il loop agentico Haiku

`runManagerChat` (`manager-chat.ts:422`) è un loop a round limitati. Costanti
chiave a `manager-chat.ts:71-78`:
- `MODEL = 'claude-haiku-4-5-20251001'` (`:71`)
- `MAX_ITERATIONS = 5` (`:73`) — conta i **round** (chiamate al modello), NON i tool.
- `MAX_TOOL_CALLS = 12` (`:74`) — cap separato sul totale di tool eseguiti nel turn.
- `TIMEOUT_MS = 10_000` (`:75`), `MAX_TOTAL_BYTES = 600_000` (`:76`) — cap cumulativo sul payload messages.

**Fallback senza LLM**: prima di chiamare l'API, `hasActivePlan`
(`manager-chat.ts:401`) verifica che ci sia un piano. Se `norm.fasi` è vuoto MA
lo status è OPTIMAL/FEASIBLE o esiste almeno un KPI finito, lo considera attivo
(hotfix F-W11-LIVE-03, `:404-416`). Se non c'è piano → emette
`FALLBACK_NO_PLAN_TEXT` (`:419`, "Non ho una pianificazione attiva…") e ritorna
senza spendere un token (`:473-476`).

**Il loop** (`manager-chat.ts:535-713`):
- A ogni iterazione, guard-checks in testa: abort (`:538`), timeout (`:542`),
  tool budget (`:546`), payload size (`:550`). Failure-mode #10 (abort check a
  ogni iter).
- Chiama `client.messages.create` (non-streaming) con retry su 429/502/503/529
  e backoff esponenziale jitterato fino a 8s (`:561-608`).
- `stopReason === 'tool_use'` → `wantsTools = true` (`:618-619`).
- L'assistant message con **tutti** i content block (testo + tool_use) viene
  appeso a `messages` (`:623`), così i tool_use_id viaggiano nel round dopo.
- **Streaming condizionato**: il testo viene emesso al client (`onChunk`) SOLO
  nel round terminale (`!wantsTools`, `:628-642`). Nei round intermedi il testo
  del modello è ragionamento pre-tool e NON deve apparire come risposta.
- Tool execution (`:647-700`): per ogni `tool_use` block, allow-list check
  (`:668`, defense-in-depth anche se l'API emette solo i tool dichiarati),
  poi `executeManagerTool`. Il risultato è serializzato con
  `serializeToolResult` (`:390`) che encoda `{}` mai `''` (failure-mode #8) e
  marca `is_error` se il risultato ha una chiave `error` (`:689`).
- I `tool_result` (multipli, parallel tool use supportato) vengono appesi come
  un singolo user message (`:708`).

**Schemi tool** (`manager-chat-tools.ts:427-572`): 10 tool, tutti read-only su
`solution`+`kpis` in memoria, zero network. Input validati come alfanumerici
`/^[A-Za-z0-9_-]{1,64}$/` (`ID_PATTERN`, `:60`). I tool: `get_kpi_summary`,
`list_orders`, `get_machine_status`, `get_operator_assignments`,
`get_next_deadlines`, `get_late_orders`, `get_bottleneck_machines`,
`query_phase`, `get_cost_breakdown`, `get_status_diagnosis`.

**Prompt caching** (`manager-chat.ts:570-584`): due blocchi system con
`cache_control: ephemeral` — il `SYSTEM_PROMPT` statico (gigantesco, ~280 righe
di few-shot e regole, `:108-286`) e lo `specBlock` (consultation + data schema
azienda). I tool hanno un cache breakpoint sull'**ultimo** elemento dell'array
(`withToolsCacheBreakpoint`, `:93-99`): marcare un solo blocco con cache_control
cacha tutto il prefisso fino a quello incluso, quindi cacha l'intero tools array
riusato a ogni iterazione (~3 KB × 5 round).

#### 2. SolutionContext + alias resolution: come si previene `found:false`

Problema storico (documentato nel test `manager-chat-alias.test.ts:14`): la chat
era "troppo deterministica" — chiedere "m2" tornava `found:false` perché il tool
faceva exact-match contro il canonico "M02".

La catena di fix:
- `runManagerChat` costruisce un `SolutionContext` dalla soluzione live
  (`manager-chat.ts:484-489` → `buildSolutionContext`). Questo è il closed-set
  di `machines`/`orders`/`shifts` realmente presenti nel piano
  (`solutionContext.ts:213`).
- Gli id reali vengono **inlinati nelle descrizioni dei tool** quando noti
  (`manager-chat.ts:509-521` → `buildManagerTools`, `manager-chat-tools.ts:593`):
  `enumHint` (`:576`) appende "Macchine disponibili nel piano corrente: M01, M02…"
  alla description di `get_machine_status`/`query_phase`/`get_operator_assignments`,
  così Haiku si auto-corregge verso id validi.
- Il `toolContext` porta il `solutionContext` (`manager-chat.ts:491-495`).
  Dentro i tool, dopo `sanitizeId` (guardia injection), `resolveId`
  (`manager-chat-tools.ts:82`) canonicalizza l'id loose via il resolver
  condiviso: `get_machine_status` chiama `resolveMachineAlias`
  (`:667-668`), `query_phase` chiama `resolveOrderAlias` (`:759`),
  `get_operator_assignments` usa `resolveAgainstSet` sugli operatori derivati
  dalle fasi (`:689-691`, gli operatori non sono nel SolutionContext).

**Ordine critico — sanitize PRIMA, resolve DOPO**: il resolver è uno strato di
ergonomia, NON una guardia injection (`manager-chat-tools.ts:71-81`,
`entityResolver.ts:17-25`). Si chiama sempre col valore già passato da
`sanitizeId`.

**Contratto anti-allucinazione del resolver** (`entityResolver.ts:38-67`,
`resolveAgainstSet`): risoluzione a 3 stadi — (1) membership esatta, (2)
`canonicaliseId` padding/separator (m2/M-2/M02 → M02, `idCanon.ts:18`), (3) alias
map collision-safe. Ritorna SEMPRE un membro del closed-set o `null`. Token
off-set ("M99") → null. Token ambiguo → null (rifiuta invece di indovinare). Su
closed-set VUOTO → null (fail-closed, `:44`). Se il resolver fallisce, `resolveId`
ritorna il sanitized id immutato (`:90`), così il filtro a valle si comporta
esattamente come prima e produce `found:false` solo su un genuino miss.

Le alias machine (`buildMachineAliases`, `solutionContext.ts:52`) sono anch'esse
collision-safe: se due macchine reclamano lo stesso alias, l'alias viene
**droppato** (`:60-69`) — un alias ambiguo è peggio di un "?" (il manager
riformula). Genera forme compatte ("m1", "m01", "m-1", "m 1") e NL ("linea N",
"macchina N").

#### 3. Explainer / Advisor / What-If: prompt building e caching

Tutti e tre sono **Sonnet 4.6** (`explainer.ts:36`, `advisor.ts:36`,
`whatif.ts:59`). What-If era Opus 4.7 ma è stato declassato a Sonnet nella Wave
14 per costo (~$0.10 → ~$0.04/call, `whatif.ts:54-58`).

Struttura prompt comune:
- **Blocco system 1 = prompt statico** con `cache_control: ephemeral`.
  - Explainer `BASE_SYSTEM` (`explainer.ts:138`), reso > 1024 token apposta così
    è sempre cacheable anche senza spec azienda (`:205-208`). Output: 1 paragrafo
    max 6 frasi, verdict + 1-2 attenzioni; regola inderogabile "usa SOLO numeri
    nei KPI/solution" (`:144`).
  - Advisor `SYSTEM_PROMPT` (`advisor.ts:45`): 3–5 raccomandazioni con tassonomia
    emoji (⚠️/🟡/✅/📋), ordine obbligatorio critiche→opportunità→conferme→verifiche
    (`:62-63`).
  - What-If `SYSTEM_PROMPT` (`whatif.ts:69`): 4 sezioni markdown `##`
    (Interpretazione, Impatti, Trade-off, Raccomandazione) + **disclaimer
    finale** "questa è analisi qualitativa basata su KPI snapshot. Il solver
    deterministico potrebbe trovare trade-off diverso" (`:140`).
- **Blocco system 2 = spec azienda** (consultation_md + data_schema_md), anch'esso
  con cache_control (explainer `:217-223`, advisor `:198-200`, whatif `:172-173`).
  È il blocco che giustifica il caching: senza, ogni call ri-fatturerebbe il
  system prompt completo.
- **User message variabile** (`buildUserMessage`): slug, status normalizzato,
  KPI ("USA SOLO QUESTI NUMERI"), e la solution JSON troncata (explainer 120k
  char `:47`, advisor 40k `:138`, whatif 100k `:61`).

**Anti-injection** (whatif): lo scenario utente è wrappato in `<user_scenario>`
tag (`whatif.ts:204`, escape XML `:159`), il system prompt istruisce a trattarlo
come dati (`:95`). Explainer/advisor istruiscono a ignorare istruzioni nei dati
input (`explainer.ts:146`, `advisor.ts:76`).

**Differenza streaming**: explainer e whatif usano `client.messages.stream` con
loop `for await` su `message_start`/`content_block_delta`/`message_delta` per
accumulare usage e emettere chunk (`explainer.ts:349-365`, `whatif.ts:268-279`).
Advisor usa lo stream ma legge l'usage finale da `stream.finalMessage()`
(`advisor.ts:259`). What-if ha retry sull'inizializzazione dello stream
(`whatif.ts:261-316`), explainer/advisor no.

#### 4. Streaming UX (UI)

- **Explainer/Advisor** (`ExplanationPanel.tsx`, `AdvisorPanel.tsx`): auto-fire
  in un `useEffect` keyed su `makeSig(slug, solution, kpis)` — una firma stabile
  (slug + size della solution + KPI hash) per evitare di rilanciare a ogni render
  (`ExplanationPanel.tsx:37-44`, `:62`). Retry client-side fino a 2 tentativi con
  backoff (`MAX_RETRIES = 2`, `:14-21`) ma SOLO su errori transitori classificati
  da `isTransientPanelError` (`streamingFetch.ts:28`). Scroll automatico solo se
  l'utente è già near-bottom (`ExplanationPanel.tsx:188-195`). L'advisor splitta
  l'output in paragrafi e solleva l'emoji iniziale in uno `<span>` separato
  (`splitParagraphs`, `AdvisorPanel.tsx:45-58`).
- **Manager Chat** (`ManagerChatPanel.tsx`): pannello flottante (FAB →
  `motion.div` dialog, `:360-384`). History persistita in localStorage
  slug-scoped (`STORAGE_KEY`, `:31`, `loadStored` `:53`). `trimHistoryForApi`
  (`:67`) droppa il welcome (timestamp=0) e manda gli ultimi 10 turni. Durante lo
  stream consuma `chunk`/`tool_use`/`done`/`aborted`/`error`: i tool usati live
  appaiono in una `StreamingBubble` ("DAINO sta cerc", `:523`), il testo
  accumulato in `draftAssistant` (`:237`). Focus-trap Tab + Esc-to-close
  (`:156-185`).
- **What-If** (`WhatIfAnalysis.tsx`): textarea con autosize (`:236-241`),
  `sseStream('/api/whatif', …)` accumula i chunk in `response` (`:300-303`). Lo
  **scroll fix è la `ScrollArea` con `h-[480px]`** (`:936`) che incapsula il
  testo `whitespace-pre-wrap break-words`; senza altezza fissa il pannello
  crescerebbe illimitato durante lo streaming. Cursore `▋` animato durante lo
  stream (soppresso con `reducedMotion`, `:939-941`).

#### 5. Apply-whatif → SolutionDiff → accept-candidate (il flusso completo)

Dopo l'analisi qualitativa, `canApply` (`WhatIfAnalysis.tsx:234`) abilita il CTA
"Esegui ottimizzazione". `runApplyWhatIfWithFlags` (`:369`) fa SSE su
`/api/apply-whatif` (logica server in FE-D) e consuma una macchina a stati ricca:
`parsing_intent`/`intent_parsed`/`routed`/`translating`/`translated`/
`solving`/`lock_relaxing`/`solved`/`requires_confirmation`/`done`
(`:442-569`). Punto critico Wave 16.6 §C: re-solva da `liveSolutionMap ?? solution`
(`:420`) — la RAW solution map (`{COM-001:{fasi:[]}}`), NON l'envelope aiInputs,
perché solver e frozen-window builder keyano su commessa→fasi.

Su `solved` (`:534-557`) popola `candidateSolution`/`candidateKpis`/
`candidateWarnings`/`appliedRules` + telemetria Wave 7 (locked/modified/skipped/
frozen counts, strategy, cutoff). Quando `applying === 'done'` e candidate non
nullo → `showCandidateDiff` (`:749`) monta `<SolutionDiff>`.

**SolutionDiff — estrazione KPI** (`SolutionDiff.tsx`):
- `buildRows` (`:229`) normalizza ENTRAMBI i lati con `normalizeKpis` (`:165`).
  Necessario perché baseline (dashboard, da resultAdapter) usa camelCase + ore +
  `costoTotale`, mentre candidate (dal solver) usa snake_case + minuti +
  `costo_totale_operatori` + `carico_macchine` come dict (`:145-151`). Senza
  normalizzazione la maggior parte delle righe mostrerebbe "—" in una colonna.
- Disambiguazione makespan ore/minuti: usa l'alias `makespan_min` se presente,
  altrimenti inferisce dalla magnitudine (≥ 200 → minuti, `:182-189`).
- `carico_macchine` (dict mid→minuti dal FJSP) viene ridotto a util max/avg %
  contro `makespan_min` (`:207-224`).
- `coerceKpi` (`:70`) tratta chiave mancante/null/non-finita come "no data".
- Direzione: `KPI_LOWER_IS_BETTER`/`KPI_HIGHER_IS_BETTER` (`:20-50`) →
  `improves` per colorare il delta (verde/rosso/grigio, `:1087-1100`). Ordina
  peggioramenti prima (`:255-260`).

**SolutionDiff — warning surfacing** (`sanitizeWarnings`, `:337`): splitta
l'array `candidate.warnings` in categorie:
- `missing_kpi:<name>` → `missingKpis` (info neutra "metrica non confrontabile",
  render separato `:1128-1141`).
- `lock_relaxed_to_soft` e le sue varianti upgrade
  (`__plan_recomputed_from_scratch` → banner ROSSO `:269`; `__consolidated_preserved_as_hint`
  → banner ambra `:278`) → flag dedicati con banner prominenti
  (`:703-800`).
- `low_confidence_classification` → banner giallo informativo (`:285`, `:802-825`).
- I marker di routing-detail BFF (`data_modifier_no_implementation:`,
  `data_modifier_rejected:`, ecc.) vengono **droppati** dalla lista utente
  (`isBffRoutingDetail`, `:310`) — restano nell'SSE per log/test ma non
  confondono il manager (F-W11-LIVE-05). Il resto (max 5) va in "Avvertenze"
  passato per `humanizeWarning` (`:1143-1165`).

**Il "time_window flag" rendering** (`SolutionDiff.tsx:859-891`): per l'intent
`machine_unavailability`, `machineExclusionStatus` (`:653`) verifica che la
candidate NON assegni `targetMachineId` a fasi con `start_min >= cutoffMin`.
È il truth-check operativo che il vincolo finestra-temporale (la macchina
indisponibile post-cutoff) sia stato davvero rispettato. Render: badge verde
"{M} esclusa post-cutoff" se count 0, badge rosso "{M}: vincolo NON applicato
(N fasi post-cutoff)" altrimenti, con `title` diagnostico che cita lo skip rule
se `skippedRulesCount > 0`. Parallelamente le fasi consolidate pre-cutoff
spostate (`movedConsolidatedPhases`, `:608`) vengono listate nel banner rosso
"ricalcolato da zero" con `formatRelMin` (`:499`, formato "ggD HH:MM").

**Accept-candidate — l'envelope merge** (`handleAcceptCandidate`,
`WhatIfAnalysis.tsx:632`): questo è il punto load-bearing.
- Guardia §D: rifiuta candidate phase-less (`countPhases === 0`, `:654-668`)
  per non far blankare il Gantt.
- **Merge** (`:670-682`): parte da `base = originalBackendResult` (l'envelope
  backend COMPLETO: status, solution, kpis, **time_config, maintenance,
  operator_config**…) e fa spread `{ ...base, status:'OPTIMAL', solution:
  candidateSolution, kpis: candidateKpis, warnings: candidateWarnings }`.
  **Perché DEVE portare machines/operators/orders/time_config**: il `solved`
  event di apply-whatif ritorna SOLO solution+kpis, ma `adaptResult`
  (`resultAdapter.ts:21-27` legge `machines`, `operators`, `maintenanceWindows`,
  `kpis` dal **root** del result) e usa `time_config` per le label wall-clock,
  `maintenance` per lo shading dei down-day, `operator_config` per i turni. Se si
  ridesse solo solution+kpis (bug Wave 16.4 A7), il Gantt/KPI/OperationalPlan
  renderizzerebbero degradati. Spreddando `base` e sovrascrivendo solo i 4 campi,
  il risultato è una shape che `adaptResult` consuma intera.
- `onAcceptResult?.(merged, appliedRules)` (`:688`) ridà il piano al parent
  PRIMA dell'audit echo (così la dashboard si aggiorna anche se l'echo fallisce).
- Audit echo fire-and-forget a `/api/accept-candidate` (`:694-709`), errore
  swallowed.

**accept-candidate route** (`accept-candidate.ts`): zero costo (no Opus/Sonnet,
no backend hop, idempotente — commento `:21-23`). Zod schema (`:25-41`):
`candidateKpis` accetta `z.union([z.number(), z.record(z.string(), z.number())])`
(`:34-37`) perché il solver FJSP emette KPI nested (es. `carico_macchine:
{M01: 703}`) e un KPI nested non deve 400-are l'accept. Costruisce un envelope
`result.method = 'deterministic-template'` (`:96`) che matcha il path live solve,
e lo echo-a indietro (`:105-108`).

#### 6. Il ledger (perché What-If ricorda i vincoli accettati)

`acceptResult` nel parent (`index.tsx:124-138`): `setBackendResult(result)` +
`appendRule(companySlug, {source, rules})` se ci sono regole, poi
`setLedgerVersion(v+1)`. Le regole vengono da `acceptedRules` (passato esplicito
da What-If) o da `result.rules_used` (chat reschedule).

Il ledger (`appliedRulesLedger.ts`) è slug-scoped, append-only, in localStorage
(`:28-30`). Esiste perché il solver è **stateless**: ogni solve ri-applica
l'intero `rules` payload da zero contro il dataset base, quindi un vincolo già
accettato sarebbe dimenticato al What-If successivo senza carry esplicito
(`:5-15`). `mergeLedgerRules` (`:303`) folda tutto il log in un singolo `rules`
con `mergeRuleSlots` (`:181`, semantica NEW-WINS per slot:
`unavailable_machines` riconcilia finestre overlapping/disjoint `:112`,
`priority_orders` dedup-union, deadline_changes last-write-per-key). Il fold è
threaded a What-If come `priorRules` (`index.tsx:114-118`, `WhatIfAnalysis.tsx:245`
→ apply-whatif `:433`). Su reset dashboard → `clearLedger` (`index.tsx:190`).

### Flusso dati / interfacce

**Input comune a tutte le superfici** (da `index.tsx`): `aiInputs.solution` +
`aiInputs.kpis` (da `extractAiInputs(backendResult)`, `index.tsx:92`). Nota:
`aiInputs.solution` è la shape normalizzata `{status, fasi[], commesse}`, mentre
`liveSolutionMap` (`index.tsx:102-106`) è la RAW `backendResult.solution`
(`{COM-001:{fasi}}`) — sono shape diverse, usate per scopi diversi.

**SSE event vocabulary** (parser `streamingFetch.ts:104`):
- explain/advise/whatif: `chunk` → `done` → (`error` | `aborted`).
- manager-chat: aggiunge `tool_use` ({name, iteration}).
- apply-whatif: macchina a stati ricca (vedi §5 sopra).

**Rotte BFF — pattern comune** (esemplificato in `manager-chat.ts:52-211`):
1. `getClientIp` (`client.ts:94`, legge cf-connecting-ip / x-forwarded-for).
2. `checkRateLimit(\`${ip}:${surface}\`)` (`client.ts:75`) — bucket per-superficie
   composito; default 10/h (`DAINO_BFF_RATE_LIMIT_PER_HOUR`, `client.ts:40`).
   Bypass SOLO se `NODE_ENV` è esplicitamente 'development'/'test'
   (`shouldBypassRateLimit`, `client.ts:49-68`, fix Wave 16.3 HIGH-1: undefined →
   limiter ON, così i deploy Cloudflare Workers non disabilitano silenziosamente
   il cap).
3. Cap body (manager-chat/explain/advise/whatif 256 KB; accept-candidate 1 MB).
4. Zod `safeParse` → 400 strutturato.
5. `ReadableStream` SSE con `flushCost` idempotente (`recordCost` una sola volta,
   anche su abort/error/cancel, `manager-chat.ts:119-132`).

**Output accept-candidate → dashboard**: `handleAcceptCandidate` →
`onAcceptResult(merged, appliedRules)` → `acceptResult` → `setBackendResult` +
`appendRule` → `dashboardData = adaptResult(backendResult)` (`index.tsx:83-90`)
ridisegna KPISummary/Gantt/OperationalPlan/OrdersTable via `DashboardContext`.

### Invarianti & gotcha

- **MAX_ITERATIONS conta i round, non i tool** (`manager-chat.ts:73`,
  DESIGN-W3-3). C'è un cap separato `MAX_TOOL_CALLS=12` sui tool totali. Confondere
  i due porta a loop infiniti o truncation precoce.
- **Streaming solo nel round terminale** (`manager-chat.ts:628`): il testo dei
  round intermedi è ragionamento pre-tool e non va mostrato come risposta. Se in
  futuro si volesse streammare il "thinking", va cambiato qui.
- **sanitizeId PRIMA, resolveId DOPO** (`manager-chat-tools.ts:66`→`:82`). Il
  resolver NON è una guardia injection. Invertire l'ordine espone a id non
  validati nel resolver.
- **Closed-set vuoto → fail-closed** (`entityResolver.ts:44`): su set vuoto il
  resolver ritorna null (mai accept-all). Vedi memoria
  `feedback_closed_set_fail_closed`. `buildSolutionContext` deve popolare il set
  per OGNI shape (flat envelope, nested, raw backend) — vedi fix Wave 16.6 in
  `solutionContext.ts:27-50` e `:116-132`: pre-fix le shape nested davano
  machines/orders=[] e ogni istruzione macchina falliva silenziosamente il gate.
- **Alias ambiguo → drop, non last-write** (`solutionContext.ts:60-69`,
  `entityResolver.ts:13-25`): un alias che due id reclamano viene scartato. Un
  "?" è più sicuro di una risoluzione sbagliata che edita la macchina sbagliata.
- **L'envelope accept DEVE spreddare `originalBackendResult`** e sovrascrivere
  solo solution/kpis/warnings/status (`WhatIfAnalysis.tsx:670-682`). Se ridai
  solo solution+kpis, `adaptResult` perde time_config/maintenance/operator_config
  e la dashboard renderizza degradata (regressione Wave 16.4 A7). Questa è la
  ragione d'essere di `originalBackendResult` prop.
- **candidateKpis accetta KPI nested** (`accept-candidate.ts:34-37`): il solver
  FJSP emette dict (carico_macchine); uno schema flat-only 400-erebbe l'accept.
- **What-If re-solva da `liveSolutionMap`, non da `solution`**
  (`WhatIfAnalysis.tsx:420`): la solution normalizzata è la shape sbagliata per
  il baseline del solver. Passare `solution` qui era il bug core Wave 16.6 (ogni
  What-If re-solvava uno snapshot mis-shaped e perdeva piano + ledger).
- **ScrollArea `h-[480px]` su What-If** (`:936`) e `h-[360px]` su
  explainer/advisor: altezza fissa obbligatoria, senza la quale lo streaming fa
  crescere il pannello illimitatamente.
- **Il ledger è localStorage, non reattivo** (`index.tsx:111-118`): serve il
  `ledgerVersion` counter per forzare il ricalcolo di `priorRules` dopo un
  append. Dimenticarlo → il What-If successivo non vede la regola appena
  accettata.
- **flushCost idempotente** (tutte le rotte): `recordCost` può essere chiamato
  da `start`/`catch`/`finally`/`cancel`, ma il flag `costRecorded` garantisce una
  sola registrazione. Doppio conteggio del costo altrimenti.
- **friendlyErrorMessage nasconde leak tecnici** (`streamingFetch.ts:69`):
  `ANTHROPIC_API_KEY not set` non deve mai arrivare al manager (penserebbe di
  dover settare lui una chiave). I codici `*_failed` → messaggio generico.
- **isTransientPanelError è conservativo** (`streamingFetch.ts:28`): retry SOLO
  su 502/503/504/529 e codici `*_failed`. MAI su rate_limit/invalid_body/payload
  (non migliorano e bruciano il budget rate-limit).
- **Cost drivers** (vedi memoria `feedback_anthropic_cost_drivers`): solo gli
  endpoint BFF chiamano `ANTHROPIC_API_KEY`. Explainer + advisor si auto-firano a
  ogni piano pronto (2 call Sonnet automatiche); What-If apply è il driver più
  caro.

### Cross-reference

- **FE-D — apply-whatif / strategy-router / intent-parser**: tutta la logica
  server di `/api/apply-whatif` (intent parsing Haiku, strategy A/B/C, frozen-window
  builder, data-modifier, constraint-translator) consumata da `WhatIfAnalysis.tsx`
  via SSE. FE-C mostra solo il diff e gestisce l'accept.
- **Backend solver (daino-backend-cp / arm_c)**: produce la shape
  `{status, solution:{COM-NNN:{fasi}}, kpis, time_config, maintenance,
  operator_config}` che `extractAiInputs`/`liveSolutionMap`/`adaptResult` consumano.
- **resultAdapter (`src/data/resultAdapter.ts`)**: `adaptResult` — consumatore
  finale dell'envelope accept; spiega perché il merge deve portare i campi root.
- **`src/lib/idCanon.ts`**: `canonicaliseId` (stadio 2 del resolver).
- **`src/lib/storage.ts`**: `getSlugScoped`/`setSlugScoped`/`removeSlugScoped` —
  namespace `daino:<slug>:` condiviso da chat history + ledger (reset li azzera
  tutti).
- **docs/wave3-adversary-report.md**: mandato delle difese anti-injection del
  manager-chat (DESIGN-W3-1/1.6/3/6, failure-mode #1/#8/#10).
- Memorie rilevanti: `feedback_closed_set_fail_closed`,
  `feedback_befe_temporal_lockstep` (BE extractor e FE frozen-window devono
  mirrorare la stessa vocabulary), `feedback_anthropic_cost_drivers`.


---

## FE-D — Infrastruttura BFF + flusso dati dashboard

> Repo: `frontend-industriale` (TanStack Start su Cloudflare Workers + React 19).
> Tutti i path sono relativi a `frontend-industriale/` salvo diversa indicazione.

### Cosa fa

Questo sottosistema copre **tre cose distinte** che insieme formano lo strato
"plumbing" della dashboard manager:

1. **BFF (Backend-For-Frontend)** — un set di route server-side TanStack Start
   (`src/routes/api/*.ts`) che girano nel runtime del Worker. Sono gli **unici**
   punti che toccano `ANTHROPIC_API_KEY`: il browser non parla mai con Anthropic
   direttamente. Il BFF aggiunge rate-limit per-IP, cost accounting, validazione
   Zod del body e streaming SSE.
2. **Client HTTP verso il backend solver** (`src/lib/api.ts`) — chiama
   `daino-backend-definitivo` su `:8001` (`VITE_API_BASE_URL`). Questo è codice
   che gira *sia* nel client (es. `solveTemplate` chiamato da `OptimizationLoader`)
   *sia* nel BFF (es. `resolveTemplate` chiamato da `apply-whatif.ts`).
3. **Flusso dati dashboard** — come la risposta grezza del solver
   (`{ solution: { COM-001: { fasi: [...] } }, kpis, ... }`) viene trasformata
   nel modello `DashboardData` che alimenta Gantt/KPI/OperationalPlan
   (`src/data/resultAdapter.ts`), come questo modello viene reso disponibile via
   React Context, persistito slug-scoped in localStorage, e snapshot-ato per la
   stampa PDF.

La regola architetturale di fondo: **il segreto non entra MAI nel bundle del
browser**. Tutto ciò che è `VITE_*` finisce nel client; tutto ciò che è
server-only (la API key, il rate-limit, l'internal secret) vive solo nel runtime
del Worker, letto via `process.env`.

### File chiave

| File | Ruolo |
|------|-------|
| `src/server/llm/client.ts` | Getter singleton del client Anthropic + guard `ANTHROPIC_API_KEY`; rate-limit (`checkRateLimit`/`getClientIp`/`shouldBypassRateLimit`); cost accounting in-memory (`recordCost`/`getCosts`). |
| `src/server/llm/explainer.ts` | Esempio rappresentativo di "surface" LLM: costruisce prompt+cache_control, chiama `getAnthropicClient().messages.stream`, calcola `cost_usd` dal usage, emette chunk e usage via callback. |
| `src/server/llm/extract-constraint-client.ts` | Chiamata BFF→backend autenticata con `DAINO_INTERNAL_SECRET` (header `X-Internal-Secret`); fail-soft a Opus se secret/URL mancanti. |
| `src/routes/api/explain.ts` | Route BFF minimale (un solo surface) — pattern canonico: rate-limit → cap body → Zod → AbortController → ReadableStream SSE → `recordCost`. |
| `src/routes/api/apply-whatif.ts` | Route BFF più complessa: doppio lock in-flight (per-IP + per-slug), watchdog, retry INFEASIBLE, chiama `resolveTemplate` per ri-risolvere. |
| `src/lib/api.ts` | Client HTTP backend: `apiFetch`, `solveTemplate`, `resolveTemplate`, pipeline/auth, `chatReschedule`, `uploadData`. `VITE_API_BASE_URL`. |
| `src/data/resultAdapter.ts` | `adaptResult(raw, method)` → `DashboardData`. Tre adapter: `adaptFJSP`, `adaptLLMOnly`, `adaptPipeline`. Definisce `DashboardData` e `TimeConfig`. |
| `src/lib/aiInputs.ts` | `extractAiInputs`/`extractSolverStatus`: normalizza la risposta grezza nell'envelope `{ status, fasi[], commesse, ... }` che le surface AI consumano. |
| `src/routes/index.tsx` | Pagina dashboard: macchina a stati (`setup`→`optimizing`→`dashboard`), `dashboardData` useMemo, `DashboardContext.Provider`, ledger applied-rules. |
| `src/data/DashboardContext.tsx` | React Context che porta `DashboardData` ai componenti; fallback a `mockData`. |
| `src/components/onboarding/OptimizationLoader.tsx` | Driver del solve: chiama `solveTemplate`, persiste `session_id`/`run_id` slug-scoped, chiama `onComplete(result)`. |
| `src/lib/storage.ts` | localStorage slug-scoped: `setSlugScoped`/`getSlugScoped`/`removeSlugScoped`/`clearSlugScoped` + `migrateLegacyKeys`. |
| `src/lib/printSchedule.ts` | Data layer puro per la stampa: `buildPrintSchedule(data, companyName)` + `formatPrintDateTime` + `PRINT_SNAPSHOT_KEY`. |
| `src/routes/print/$slug.tsx` | Route print-only: legge lo snapshot, costruisce il modello, auto-`window.print()`. |
| `src/components/dashboard/DashboardHeader.tsx` | Bottone "Esporta PDF" — `handleExportPdf` con `window.open` sincrono. |
| `package.json` / `wrangler.jsonc` / `.dev.vars` / `.env.local` | Env handling, script `dev` vs `dev:bff`, `NODE_ENV="production"` sul Worker. |

### Come funziona (meccanismo passo-passo)

#### A) client → BFF route → Anthropic (es. Spiegazione AI)

1. **Client** (componente `ExplanationPanel`, montato da `index.tsx:204`) fa
   `fetch('/api/explain', { method: 'POST', body: {...} })`. Il body contiene
   `slug`, `solution` (l'envelope `aiInputs.solution`), `kpis`,
   `consultationMd?`, `dataSchemaMd?`.
2. **Route handler** `src/routes/api/explain.ts:32` (`POST`) gira **server-side
   nel Worker**. Pipeline fissa:
   - **Rate-limit**: `getClientIp(request)` (`client.ts:94`) → `checkRateLimit(\`${ip}:explainer\`)`
     (`explain.ts:33-34`). Se `!rl.ok` → `429 rate_limited` (`explain.ts:35-41`).
     Nota la **chiave composita** `${ip}:explainer`: ogni surface ha il suo
     bucket, quindi il rate-limit è per-IP-per-surface, non globale.
   - **Cap body**: `content-length > 256_000` → `413` (`explain.ts:43-46`). Difesa
     contro payload abusivi *prima* di leggere/parsare.
   - **Parse + Zod**: `request.json()` in try/catch → `400 invalid_json`
     (`explain.ts:48-53`); poi `BodySchema.safeParse` → `400 invalid_body` con
     messaggi per-campo (`explain.ts:10-16`, `55-62`).
   - **Abort wiring**: crea un `AbortController` locale e lo aggancia a
     `request.signal` (`explain.ts:65-74`) — se il client chiude la connessione,
     lo stream verso Anthropic viene abortito.
3. **Stream SSE**: `explain.ts:99` apre una `ReadableStream<Uint8Array>`. Dentro
   `start(controller)` chiama `runExplainer(input, onChunk, { signal, onUsage })`
   (`explain.ts:109`). `sseEvent(event, data)` (`explain.ts:18`) formatta ogni
   messaggio come `event: <name>\ndata: <json>\n\n`. Gli eventi emessi: `chunk`
   (testo incrementale), poi `done` (o `aborted`, o `error`).
4. **Chiamata Anthropic** in `src/server/llm/explainer.ts:294` (`runExplainer`):
   - `getAnthropicClient()` (`explainer.ts:314` → `client.ts:5`) restituisce il
     singleton; **qui** avviene il guard sulla key (vedi sotto).
   - Costruisce `system` come array di blocchi con `cache_control: { type:
     'ephemeral' }` (`explainer.ts:206-207`) — prompt caching del system prompt.
   - `client.messages.stream(params)` con `stream: true` (`explainer.ts:324`).
   - Itera gli eventi SDK (`explainer.ts:349-365`): su `message_start` legge
     `usage.input_tokens`/`cache_*`; su `content_block_delta` → `onChunk(text)`
     (che diventa l'evento SSE `chunk`); su `message_delta` aggiorna
     `output_tokens`.
   - `computeCostUsd(usage)` (`explainer.ts:268`) calcola il costo in USD dai
     prezzi Sonnet 4.6 (`explainer.ts:40-43`): input/output/cache-read/cache-write
     a tariffe diverse. Emette `onUsage` (`explainer.ts:326-334`).
5. **Cost accounting**: la route accumula l'ultimo usage (`explain.ts:76-96`,
   `flushCost`) e chiama `recordCost({ ts, surface: 'explainer', cost_usd,
   tokens_in/out, cache_* })` (`client.ts:30`). `flushCost` è **idempotente**
   (guard `costRecorded`) ed è chiamato in tutti i path terminali (success,
   error, `cancel()` su disconnect — `explain.ts:128/139/144/152`) così il costo
   è registrato **anche se il client si disconnette a metà stream** (il token già
   speso non si perde).
6. **Response**: `explain.ts:157` ritorna la `Response(stream, { headers })` con
   `content-type: text/event-stream`, `cache-control: no-cache, no-transform`,
   `x-rate-limit-remaining`.

#### B) client → BFF → backend solver (es. apply-whatif / re-solve)

Questo è il path dove il BFF non solo chiama Anthropic ma **poi ri-risolve sul
backend**. Vedi `src/routes/api/apply-whatif.ts:461` (`POST`):

1. Stesso preambolo di A: rate-limit (ma con cap **5/h** — `APPLY_WHATIF_LIMIT_PER_HOUR`
   `apply-whatif.ts:456`, `463`, perché ogni call costa Opus + un re-solve CPU,
   vedi memoria `feedback_anthropic_cost_drivers`), cap body, Zod (`BodySchema`
   `apply-whatif.ts:142-175`).
2. **Doppio lock in-flight** (`apply-whatif.ts:494-507`): `_inFlight` (per-IP →
   `409 conflict`) e `_inFlightBySlug` (per-slug → `409 slug_conflict`). Il lock
   per-slug evita che due manager su IP diversi corrompano la warm-start memory
   dello stesso tenant (F-W7-04, `apply-whatif.ts:446-450`).
3. **Watchdog** (`apply-whatif.ts:558-580`): `cancel()` dello stream non è
   garantito su ogni disconnect (vite dev SSR a volte lo droppa), quindi un timer
   `SOLVE_TIMEOUT_MS*2 + 30s = 150s` rilascia i lock e aborta. C'è un **identity
   check** (`_inFlight.get(ip) === abort`) così un watchdog stale non droppa un
   lock preso da una richiesta successiva legittima.
4. **Fase LLM** (interpreter/translator): chiama `interpretInstruction` (Haiku +
   enum-tool sui veri id del piano) o `translateWhatIfToConstraint` (Opus 4.7).
   Emette eventi SSE `parsing_intent`/`intent_parsed`/`routed` oppure
   `translating`/`translated`. Esiti possibili: `reject` (off-set,
   anti-hallucination), `gray` (`requires_confirmation`), `hit` (rules pronte).
5. **Fase solve**: chiama `resolveTemplate(...)` (`apply-whatif.ts:1042` →
   `src/lib/api.ts:267`) — **stesso client HTTP usato dal browser**, ma qui gira
   nel Worker. Wrappato in `raceWithTimeout` (60s, `apply-whatif.ts:1023-1040`)
   che reject sincrono se il signal è già aborted (fix F-W8-04: aggiungere un
   listener `abort` a un signal *già* aborted non fa scattare il listener).
6. **Retry INFEASIBLE** (`apply-whatif.ts:1062-1128`): se il hard-lock delle fasi
   pre-cutoff rende il modello infeasible, ri-risolve **una volta** con
   `frozenLockMode='hint'` (soft preference) invece di `'hard'`. Emette
   `lock_relaxing` e marca i warning `lock_relaxed_to_soft__consolidated_preserved_as_hint`.
7. **Guard empty-solution** (`apply-whatif.ts:1149-1171`): se status è
   OPTIMAL/FEASIBLE ma `countSolutionPhases(solution) === 0` mentre la baseline
   aveva fasi, emette `aborted_unsupported(empty_solution_after_solve)` invece di
   un `solved` ingannevole (i KPI cambierebbero ma il Gantt resterebbe vuoto —
   "Gantt-not-updating" Wave 16.6 §D).
8. **Evento `solved`** (`apply-whatif.ts:1212`): porta `newSolution`, `newKpis`,
   `deltaKpis`, `applied_rules` (il delta del nuovo scenario, pre-merge col
   ledger), `locked_phases`, ecc. Il client su "Accetta" chiama `acceptResult`
   (`index.tsx:124`) che fa `setBackendResult(result)` → ricalcola `dashboardData`
   → la dashboard si aggiorna.
9. Cost accounting identico ad A ma `surface: 'whatif_apply'` (`apply-whatif.ts:535`),
   con `accumulateUsage` (`apply-whatif.ts:593-613`) che **somma** il costo del
   parser Haiku + l'eventuale translator Opus in un singolo record.

#### C) Il solve iniziale (OptimizationLoader → solveTemplate)

1. `index.tsx:55` monta `Index()`. Fase iniziale `setup`. Su `onOptimize`
   (`index.tsx:146`) salva `setupData` e va a `optimizing` (Wave 12: niente più
   step di scelta metodo, sempre `deterministic-json` — `index.tsx:24`).
2. `OptimizationLoader` (`index.tsx:158` → `OptimizationLoader.tsx:107`) ha un
   `useEffect` con guard `calledRef` (`OptimizationLoader.tsx:149-151`) per non
   chiamare due volte in StrictMode. Per `deterministic-json` chiama
   `solveTemplate(companySlug)` (`OptimizationLoader.tsx:255` → `src/lib/api.ts:179`).
   **Questa è una chiamata client→backend diretta** (non passa dal BFF — il solve
   non usa LLM, quindi non serve la API key).
3. Su OPTIMAL/FEASIBLE persiste `session_id`/`run_id` slug-scoped (vedi
   persistenza sotto) e chiama `onComplete(result)` (`OptimizationLoader.tsx:281`).
4. `onComplete` (`index.tsx:162-165`) fa `setBackendResult(result)` e va a
   `dashboard`.

#### D) Da backendResult a DashboardData (adaptResult)

`index.tsx:83-90`:

```ts
const dashboardData = useMemo(() => {
  if (!backendResult || !solverMethod) return null;
  try { return adaptResult(backendResult, solverMethod); }
  catch { return null; }   // adapter robusto: errore → null, non crash
}, [backendResult, solverMethod]);
```

`adaptResult(raw, method)` (`resultAdapter.ts:426`) fa switch su `method`:
- `'deterministic-json'` (e default) → `adaptFJSP` (`resultAdapter.ts:91`).
- `'llm-only'` → `adaptLLMOnly` (`resultAdapter.ts:273`).
- `'codegen-pipeline'` → `adaptPipeline` (`resultAdapter.ts:397`, che sniffa la
  forma e delega a `adaptFJSP` o `adaptLLMOnly`).

**`adaptFJSP` — il path vivo** (Wave 12 usa sempre questo):
- Itera `raw.solution` come mappa `{ jobId: { fasi: [...], scadenza_min,
  ritardo_min, priorita } }` (`resultAdapter.ts:113`).
- Per ogni job costruisce un `Order` (`resultAdapter.ts:121`): deadline/ritardo
  → `status: 'in-ritardo' | 'in-tempo'`; priorità int (1/2/5) → `Priority`
  (`normalizePriority` `resultAdapter.ts:56`, anchored su `_PRIORITY_MAP` del
  backend).
- Per ogni `fase` costruisce un `Operation` (`resultAdapter.ts:161`) e
  **deduplica** macchine/operatori in `Map` (`resultAdapter.ts:107-108`,
  `141-159`). Traccia `qualifiedMachines` per operatore. `operatore === 'NONE'`
  → operatorId vuoto.
- **TimeConfig** (`resultAdapter.ts:100`): il backend emette il tempo come
  "model minutes" relativi all'apertura azienda (06:00, giornata 960 min = 16h,
  *non* 1440). `formatModelMinute` (`resultAdapter.ts:76`) converte minuti→stringa
  wall-clock usando `day_length_min`/`company_start_hour`/`start_weekday`.
- **Maintenance** (`resultAdapter.ts:194-213`): il backend dà `{ machineId:
  [weekday_int] }`; l'adapter materializza una `MaintenanceWindow` per occorrenza
  nell'orizzonte.
- **KPI** (`resultAdapter.ts:247-263`): makespan (da maxEnd/60), tardiness,
  utilizzo macchine peak/avg, `highPriorityOnTime` (con semantica NaN→0 su set
  vuoto, `resultAdapter.ts:234-238`), e i KPI di costo in € (`costoOperatori`/
  `costoSetup`/`costoTotale`).
- Output: `DashboardData` (`resultAdapter.ts:20`).

**Doppia normalizzazione — punto sottile**: `index.tsx` calcola DUE
trasformazioni dal *medesimo* `backendResult`:
- `dashboardData = adaptResult(...)` (`index.tsx:83`) → forma ricca per
  Gantt/KPI/tabelle (via Context).
- `aiInputs = extractAiInputs(backendResult)` (`index.tsx:92` → `aiInputs.ts:40`)
  → envelope `{ status, fasi[], commesse, ... }` che le **surface AI** consumano
  (Explainer/Advisor/Chat). Questa esiste perché le surface leggono
  `solution.status` + un `fasi[]` flat con `commessa` su ogni fase; senza
  normalizzazione vedevano `status=UNKNOWN`/`fasi=[]` (F-W11-LIVE-03,
  `aiInputs.ts:6-14`).
- `liveSolutionMap` (`index.tsx:102-106`) è invece la **mappa grezza**
  `{ COM-001: { fasi } }` passata a What-If: il solver/frozen-window builder
  chiavano su `commessa→fasi`, quindi What-If deve ri-risolvere da QUESTA, non
  dall'envelope `aiInputs` (Wave 16.6 §C — passare `aiInputs.solution` era il bug
  che faceva ri-risolvere uno snapshot mis-shaped).

#### E) DashboardData → componenti (Context)

`index.tsx:171` avvolge la dashboard in `<DashboardContext.Provider value={dashboardData}>`.
I componenti leggono via `useDashboard()` (`DashboardContext.tsx:23`). Il Context
ha un **fallback su mockData** (`DashboardContext.tsx:7-21`) così un componente
montato fuori dal Provider (test/storybook) renderizza dati finti invece di
crashare.

#### F) Persistenza slug-scoped

`src/lib/storage.ts`: tutte le chiavi sono prefissate `daino:<slug>:<key>`
(`storage.ts:8-9`). Questo **isola i dati per azienda** — cambiare slug non
mostra il piano di un'altra azienda.
- `OptimizationLoader.tsx:236-238/276-278` persiste `daino_last_session_id` e
  `daino_last_run_id` slug-scoped, così `ReplanModal` può chiamare
  `/api/analysis/{sid}/reschedule`.
- `clearSlugScoped(slug)` (`storage.ts:36`) itera all'indietro e rimuove **solo**
  le chiavi con quel prefisso (usato dal reset, `DashboardHeader.tsx:92` +
  `index.tsx:190`).
- `migrateLegacyKeys` (`storage.ts:49`) rimuove le 3 vecchie chiavi non-scoped
  (`storage.ts:2-6`), chiamato una volta al mount (`index.tsx:76-78`).
- Tutte le funzioni sono **try/catch silenziose** (`storage.ts:13-18`): quota
  piena / localStorage non disponibile (SSR, private mode) non rompono il flusso.

#### G) Esporta PDF — snapshot + popup sincrono + route print

1. **DashboardHeader** `handleExportPdf` (`DashboardHeader.tsx:57`):
   - Serializza `{ data: dashboard, companyName }` e lo scrive con
     `setSlugScoped(PRINT_SNAPSHOT_KEY, slug, snapshot)` (`DashboardHeader.tsx:60-64`).
     Fallback slug `'current'` se nessuno slug (`DashboardHeader.tsx:58`).
   - **`window.open(url, '_blank')` SINCRONO** dentro il click handler
     (`DashboardHeader.tsx:78`). **Perché**: la write dello snapshot è sincrona e
     la nuova tab la legge solo su un tick successivo, quindi non c'è race da
     deferire. Deferire `window.open` via `setTimeout` (il vecchio approccio Wave
     16.4) **perde il contesto di user-gesture** → il popup-blocker uccide la
     finestra → falso toast "il browser ha bloccato la nuova finestra"
     (`DashboardHeader.tsx:70-77`). Tenerlo sincrono lo rende un'azione utente
     fidata.
   - **`win.opener = null` a mano** (`DashboardHeader.tsx:79-85`) per la sicurezza
     (reverse-tabnabbing) invece del feature `noopener`: quel feature fa tornare
     `window.open` → `null` *anche in caso di successo*, che farebbe scattare il
     falso "popup blocked" del check sotto.
   - Se `win` è `null` (vero blocco) → rimuove lo snapshot e mostra il toast
     d'errore (`DashboardHeader.tsx:86-89`).
2. **Route print** `src/routes/print/$slug.tsx:49` (`PrintPage`):
   - `readSnapshot(slug)` (`$slug.tsx:36`) legge via `getSlugScoped`, fa
     `JSON.parse`, valida che `parsed.data.machines` sia un array.
   - `useEffect` (`$slug.tsx:54-61`): legge lo snapshot e **lo rimuove subito**
     (`removeSlugScoped` `$slug.tsx:58`) — consumo one-shot, così un refresh non
     ri-stampa dati stantii.
   - `buildPrintSchedule(snapshot.data, companyName)` (`$slug.tsx:65` →
     `printSchedule.ts:129`): raggruppa le operazioni per macchina, ordina per
     `startMinute`, risolve operatorId→nome, omette macchine senza operazioni
     (`printSchedule.ts:144`), calcola header (makespan, on-time rate).
   - **Auto-print** (`$slug.tsx:71-81`): `setTimeout(window.print, 350)` — il
     delay lascia al browser il tempo di dipingere la pagina prima del dialog
     nativo (niente flash bianco).
   - Render: layout A4 inline-styled (`PrintStyles` `$slug.tsx:186`), `@page` +
     `page-break-inside: avoid`. NON renderizza Gantt/AI/What-If/KPI cards — solo
     lo schedule operativo + KPI di testa (`$slug.tsx:12-15`).

### Flusso dati / interfacce

#### Forma sul filo

```
SOLVE INIZIALE (no LLM):
  Browser ──POST /api/public/solve-template──> backend:8001
  (src/lib/api.ts:179 solveTemplate; chiamato da OptimizationLoader)
    ← { status, solution:{COM-001:{fasi[]}}, kpis, objective_value,
        warnings[], cost_usd, session_id?, run_id? }

SURFACE AI (LLM, streaming):
  Browser ──POST /api/explain (SSE)──> Worker BFF ──messages.stream──> Anthropic
  (explain.ts → explainer.ts; eventi SSE: chunk* → done|aborted|error)

APPLY WHAT-IF (LLM + re-solve):
  Browser ──POST /api/apply-whatif (SSE)──> Worker BFF
                                              ├─ Haiku/Opus (interpret/translate)
                                              └─ ──resolveTemplate──> backend:8001
  (eventi: parsing_intent|translating → … → solving → solved|aborted_unsupported|error)
```

#### Tipi chiave

- **`DashboardData`** (`resultAdapter.ts:20`): `{ machines, operators,
  operations, orders, maintenanceWindows, keyDecisions, kpis, narrative, method,
  costUsd, timeConfig? }`. È il contratto del Context e dello snapshot di stampa.
- **`TimeConfig`** (`resultAdapter.ts:11`): `{ company_start_hour,
  company_end_hour, day_length_min, start_date, start_weekday, machine_windows? }`.
  Ancora per convertire model-minutes→wall-clock ovunque (adapter, print).
- **`ResolveTemplateResponse`** (`api.ts:240`): output del re-solve; campo
  opzionale `wave7` (`api.ts:233`) — `null` distingue "non ho fatto wave7" da
  "ho fatto wave7 con 0 lock".
- **`CostRecord`** (`client.ts:17`): `{ ts, surface, cost_usd, tokens_in/out,
  cache_read/write_tokens? }`. `surface` è un enum `LlmSurface` (`client.ts:15`).
- **`AiInputs`** (`aiInputs.ts:35`): `{ solution: envelope, kpis }` per le surface.

#### Firma `resolveTemplate` (il punto di contatto BFF→backend più importante)

`api.ts:267-312`. Oltre a `slug`/`problemType`/`rules`, accetta argomenti
opzionali Wave 7+ aggiunti additivamente sul *medesimo* body
`/api/public/solve-template`:
- `cutoffMin` — fasi pre-cutoff hard-locked (`api.ts:282`).
- `frozenPhases` — lista esplicita di fasi da bloccare (`api.ts:285`).
- `datasetOverrides` — merge nei `data` prima del solve (`api.ts:288`).
- `frozenLockMode: 'hard'|'hint'` (`api.ts:295`) — hard = `model.Add(==)`,
  hint = `model.AddHint` (usato dal retry INFEASIBLE).
- `forceColdStart` (`api.ts:305`) — bypassa il warm-start L2; apply-whatif lo
  mette **sempre** a `true` perché ogni what-if è un constraint set fresco e
  warm-startare dal vecchio piano biasa la ricerca (F-W10-07).
Ogni campo è omesso dal body quando `undefined`, così un backend legacy riceve
la forma Wave 4.1 invariata.

#### `apiFetch` — error contract

`api.ts:9-19`: `fetch` con `Content-Type: application/json`; su `!res.ok` legge
`err.detail` (o `res.statusText`) e fa `throw new Error(detail)`. Tutti i caller
si aspettano un throw, non un campo `error` nel body (eccezione: `chatReschedule`
`api.ts:511-526` che cattura il throw e mappa 501 → messaggio UX).

### Invarianti & gotcha

1. **La API key non entra MAI nel client bundle.** Meccanismo: la key è letta
   solo via `process.env.ANTHROPIC_API_KEY` dentro `getAnthropicClient`
   (`client.ts:7`), che è importato **solo** da moduli `src/server/llm/*` usati
   **solo** da route `src/routes/api/*.ts` (server handler). Niente prefisso
   `VITE_`, quindi Vite non la inietta nel bundle. Verifica fatta in Wave 2
   (`docs/wave-2-report.md:200-227`): le uniche occorrenze di `ANTHROPIC_API_KEY`
   nel `dist/server` sono i `process.env` reads dell'SDK; `dist/server/.dev.vars`
   viene strippato dal `postbuild` (`package.json:10`).

2. **Guard fail-loud sulla key**: se `ANTHROPIC_API_KEY` manca,
   `getAnthropicClient` fa `throw new Error('ANTHROPIC_API_KEY not set
   (server-only env var)')` (`client.ts:8-10`). Non c'è fallback silenzioso — una
   surface senza key fallisce subito (la route lo cattura e emette SSE `error`).

3. **GOTCHA dev-env (F-W11-LIVE-01): `npm run dev` NON carica la key per il BFF.**
   - `npm run dev` = `dotenv -e .env.local -- vite dev` (`package.json:7`).
   - `npm run dev:bff` = `set -a && . ./.dev.vars; set +a; vite dev`
     (`package.json:8`).
   Il `cloudflare` plugin è "build-only" (`vite.config.ts:3`): in dev il server
   SSR/BFF gira nel processo Node di Vite, quindi le surface LLM leggono
   `process.env`. **Il problema**: il contratto operativo del progetto è che i
   segreti BFF (`ANTHROPIC_API_KEY`, `DAINO_INTERNAL_SECRET`,
   `DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL`) vivono in `.dev.vars`, che è il file
   convenzione Cloudflare (anche `.gitignore:.dev.vars`). `npm run dev` carica
   `.env.local` ma **non** `.dev.vars`; se i segreti BFF stanno in `.dev.vars`,
   le route `/api/*` partono senza key e ogni surface AI fallisce con
   "ANTHROPIC_API_KEY not set". **Per testare il BFF in locale usa sempre
   `npm run dev:bff`.** (Nota: in questo checkout sia `.dev.vars` sia `.env.local`
   contengono la key, quindi entrambi gli script funzionano qui — ma il path
   "canonico"/Worker-aligned è `dev:bff`; il README documenta solo `npm run dev`
   ed è la fonte tipica della confusione.)

4. **Rate-limit: il default fail-safe è ON in produzione.** `shouldBypassRateLimit`
   (`client.ts:49-68`) bypassa SOLO se `NODE_ENV` è *esplicitamente* `'development'`
   o `'test'`. `undefined`/`'production'`/`'staging'` → limiter attivo. **Perché
   conta**: Cloudflare Workers non setta `NODE_ENV`; sotto la logica pre-16.3
   (`!== 'production'`) il limiter sarebbe stato disattivato silenziosamente sul
   Worker deployato, esponendo il billing Anthropic a client runaway (Wave 16.3
   HIGH-1). Mitigazione: `wrangler.jsonc:12-14` setta `NODE_ENV="production"`
   esplicitamente. Il bypass dev si forza OFF con
   `DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL=0` (`client.ts:52`).

5. **`limitOverride` solo restringe, mai allarga**: `checkRateLimit(ip,
   limitOverride)` fa `Math.min(limitOverride, LIMIT)` (`client.ts:76-79`) — una
   surface mal-configurata non può superare il ceiling globale `LIMIT`
   (`client.ts:40`, default 10/h). apply-whatif usa override 5/h
   (`apply-whatif.ts:456`).

6. **Cost accounting è in-memory e per-istanza.** `_costs` è un array module-level
   con `COST_HISTORY_LIMIT = 1000` (ring tramite `shift`, `client.ts:27-33`).
   `_hits` (rate-limit) è una `Map` module-level (`client.ts:39`). **Conseguenza**:
   su Cloudflare Workers (isolate effimeri/multipli) questi stati NON sono
   condivisi tra isolate né persistenti — il rate-limit è best-effort per-isolate,
   il cost è osservabilità locale, non billing autoritativo. Va bene per il MVP
   ma è un limite noto se serve un limite globale duro.

7. **`recordCost` parte anche su disconnect.** `flushCost` (idempotente) è chiamato
   nel `finally` E nel `cancel()` dello stream (`explain.ts:142-154`,
   `apply-whatif.ts:1259-1269`). Un token speso verso Anthropic è registrato anche
   se l'utente chiude la tab a metà streaming — evita di sotto-contare il costo.

8. **Adapter robusto ma silenzioso**: `adaptResult` è avvolto in try/catch in
   `index.tsx:87` → errore di parsing ⇒ `dashboardData = null` ⇒ la dashboard
   semplicemente non renderizza (la guard `phase === 'dashboard' && dashboardData`
   a `index.tsx:170`). Non crasha, ma un risultato malformato sparisce senza
   messaggio. Tenerlo a mente in debug.

9. **`day_length_min = 960`, non 1440.** Tutta la conversione tempo assume
   giornata-azienda di 16h da `company_start_hour` (`resultAdapter.ts:8-10`,
   `81-86`). Usare 1440 (giorno solare) sballa giorno+ora. `formatModelMinute` e
   `formatPrintDateTime` (`printSchedule.ts:64`) condividono questa logica e
   preferiscono sempre l'ISO `start_datetime`/`end_datetime` quando il backend lo
   fornisce, cadendo su model-minute+TimeConfig solo come fallback.

10. **Snapshot di stampa è uno snapshot point-in-time consumato una volta.** Lo
    snapshot scritto da `handleExportPdf` (`DashboardHeader.tsx:64`) e rimosso
    alla lettura (`$slug.tsx:58`). Se la dashboard viene chiusa prima di esportare,
    o si fa refresh della tab di stampa, lo snapshot non c'è più → la route mostra
    "Nessun piano disponibile" (`$slug.tsx:87-98`). È by-design: niente dati
    stantii sul PDF.

11. **`win.opener = null` NON è `noopener`.** Vedi punto G — usare il feature
    `noopener` farebbe tornare `window.open` → `null` anche su successo,
    triggerando il falso "popup bloccato". L'azzeramento manuale di `opener`
    preserva sia la sicurezza sia un valore di ritorno usabile
    (`DashboardHeader.tsx:79-85`).

12. **`extract-constraint-client` fail-soft con guardia produzione**: senza
    `DAINO_INTERNAL_SECRET` o `VITE_API_BASE_URL` ritorna `null` → fallback a Opus
    (`extract-constraint-client.ts:25-39`); in produzione logga un warning perché
    fallback-a-Opus su ECONNREFUSED prosciugherebbe costo silenziosamente
    (`extract-constraint-client.ts:33`). Il secret va sul header `X-Internal-Secret`
    (`extract-constraint-client.ts:46`) e DEVE combaciare col valore lato backend.

### Cross-reference

- **FE-A/B/C (surface AI)** — `explain.ts` qui documentato è il template; le altre
  surface (`advise`, `manager-chat`, `whatif`, `split`, `accept-candidate`,
  `reschedule-fresh`) seguono lo stesso pattern rate-limit→Zod→SSE→recordCost e
  importano tutte da `src/server/llm/client.ts`. La logica di prompt/translator
  (`constraint-translator`, `instruction-interpreter`, `frozen-window-builder`,
  `solutionContext`, `entityResolver`, `appliedRulesLedger`) è dominio di chi
  documenta What-If/Chat.
- **Backend solver (`daino-backend-definitivo`)** — il contratto
  `/api/public/solve-template` e `/api/analysis/{sid}/reschedule` vive lato
  backend; qui ne consumiamo solo la forma (vedi `api.ts` types). Il problem-type
  è sniffato da `## Tipo problema:` nel `consultation_md` (`api.ts:121-134`,
  duplicato in `apply-whatif.ts:196-202`). Lo strato `arm_c`/`template_solve` del
  backend produce `solution`/`kpis`/`time_config`/`maintenance`/`operator_config`
  che `adaptFJSP` consuma.
- **Memoria progetto rilevante**: `feedback_anthropic_cost_drivers` (solo i BFF
  endpoint usano `ANTHROPIC_API_KEY`; apply-whatif è il driver di costo principale
  ~$0.20/click), `project_daino_hr_architecture` (chatbot locale + warm start),
  `feedback_closed_set_fail_closed` (regating fail-closed in `apply-whatif.ts`
  `regateConfirmedRules`), `feedback_befe_temporal_lockstep` (BE extractor e FE
  frozen-window devono mirrorare la stessa vocabulary temporale).
- **Docs interni**: `README.md` §"Environment variables"/"Rate limit BFF in dev",
  `.env.example` (contratto var, distinzione VITE_* vs server-only),
  `docs/wave-2-report.md` (verifica key-non-nel-bundle), `HOW-IT-WORKS.md`
  (architettura d'insieme), `docs/come-funziona-il-frontend.md` (§2-4 flow vivo
  Wave 12).


---

