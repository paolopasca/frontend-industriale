# PRD — Manager AI Layer (Wave 2 discovery)

**Owner**: team-lead (Wave 2 discovery, autonomous mode)
**Date**: 2026-05-21
**Status**: v1 — basis per i prompt LLM di Wave 2; iterabile su feedback reale.

## 1. Chi è "il manager"

Manager di produzione industriale in PMI manifatturiera italiana. Profilo tipico:
- 35-60 anni, esperienza pratica sul reparto, non background data-science.
- Decide su scala oraria/giornaliera: assegnazione macchine, urgenze, manutenzioni, straordinari.
- KPI che gli interessano: rispetto delle consegne (on-time), saturazione macchine, costo straordinari, ribilanciamento operatori.
- Lingua: italiano professionale, frasi corte, no gergo accademico.
- Lavora con interruzioni: chiamate dei clienti, guasti, urgenze. Vuole risposte rapide.

## 2. Cosa NON è il Manager AI

- Non è una chat generica ("ChatGPT con dati").
- Non è un descrittore tecnico ("il solver ha eseguito 1247 propagazioni in 18.3s con makespan 47:30") — quello sta nei log per il developer.
- Non sostituisce il giudizio del manager — propone, non decide.
- Non inventa numeri: SEMPRE basato sulla soluzione del solver passata in input.

## 3. Le 2 surfaces di Wave 2

### 3.1 Explainer (`/api/explain/solution`) — POST-SOLVE narrative

**Quando si attiva**: automaticamente quando il solver chiude e la dashboard si apre. Streaming via Server-Sent Events.

**Cosa fa**: legge la soluzione del solver (KPI, schedule, ordini, costo, vincoli attivi) e produce un paragrafo (≤6 frasi) in italiano per il manager:

```
✅ La produzione è stata pianificata per coprire 21 commesse su 13 macchine in
4 giorni. Il rispetto delle consegne è del 95% (1 commessa COM-007 in ritardo di
2 ore). La macchina M-3 è saturata al 92% (collo di bottiglia: 3 commesse in
coda). Il costo totale stimato è di €4.380, di cui €410 setup. Tutti i 5
operatori sono assegnati nelle finestre disponibili senza straordinari.
```

**Stile**:
- Apertura con verdict di sintesi (1 frase, emoji opzionale ✅/⚠️).
- Numeri concreti, non aggettivi vaghi.
- Identifica 1-2 punti di attenzione (collo di bottiglia, commesse in ritardo, costi sopra soglia).
- Chiude con una frase neutra ("Tutti i vincoli sono rispettati" o "Le 2 anomalie sono dettagliate sotto").

### 3.2 Advisor (`/api/advise/solution`) — POST-SOLVE actionable suggestions

**Quando si attiva**: appena Explainer è finito, automaticamente (panel side-by-side).

**Cosa fa**: legge la soluzione + i KPI deviati e produce **3-5 raccomandazioni operative** in formato bullet, priorizzate. Ogni raccomandazione:
- Inizia con un verbo all'imperativo ("Anticipa", "Riassegna", "Verifica").
- Cita il dato concreto che la motiva ("M-3 saturata al 92%").
- Suggerisce un'azione specifica ("considera turno serale su M-3 mercoledì").
- Indica l'impatto stimato qualitativo ("riduce ritardo COM-007 di ~3h").

```
1. ⚠️ Anticipa il setup di M-3 mercoledì. La macchina è saturata al 92% e 3
   commesse aspettano. Un turno serale da 4h libererebbe il piano del giovedì.
2. 🟡 Riassegna COM-007 alla macchina M-7 (oggi al 45%). Eviterebbe il ritardo
   di 2 ore. Verifica con il responsabile setup se le tolleranze coincidono.
3. ✅ Mantieni l'assegnazione operatori — distribuzione bilanciata, no extra.
4. 📋 Verifica con cliente di COM-012 se la deadline è negoziabile (3 giorni
   dopo): liberebbe slot per le urgenze.
```

**Stile**:
- Massimo 5 raccomandazioni, minimo 3.
- Ordine: critiche (⚠️) → opportunità (🟡) → conferme (✅) → verifiche manuali (📋).
- Mai consigli vaghi tipo "valuta se ottimizzare X".

## 4. Edge case espliciti

| Scenario | Comportamento atteso |
|----------|----------------------|
| Solver ha trovato OPTIMAL senza warning | Explainer celebra brevemente; Advisor focalizza su mantenimento e segnali deboli ("M-3 al 92%, monitora la prossima settimana") |
| Solver ha trovato FEASIBLE con warning | Explainer indica esplicitamente che è una soluzione fattibile ma non ottima; Advisor priorizza la causa principale del gap |
| Solver è andato in INFEASIBLE | Explainer dice "Pianificazione non possibile con i vincoli attuali. La causa principale è X." e elenca i vincoli più stringenti; Advisor propone quali vincoli rilassare |
| Soluzione vuota (0 commesse) | Explainer: "Nessuna commessa pianificabile nella finestra temporale. Verifica i dati di ingresso."; Advisor: "Controlla che le scadenze siano nel futuro, che le macchine abbiano disponibilità, e che gli operatori abbiano turni assegnati." |
| Backend payload mal-formato (KPI mancanti) | Server-side: rispondi con `{ error: "kpi_missing", retry_after: 30 }` invece di una hallucinated explanation; client mostra "Generazione in corso..." con retry |

## 5. Constraint tecnici

- **Modello**: Claude Sonnet 4.6 (`claude-sonnet-4-6`) per entrambi explainer e advisor.
- **Streaming**: SSE / chunk per esperienza progressiva. Time-to-first-token target < 1.5s.
- **Prompt caching**: la "company spec" (consultation_md + data_schema_md + KPI definitions) è cached per session (TTL 5 min). La soluzione e i KPI variabili NO.
- **Max input tokens**: 50k (solution + spec + KPI). Se più grande, troncare il pian alla soluzione, KPI summary first.
- **Max output**: 600 tokens (Explainer), 1000 tokens (Advisor). Hard cap nel `max_tokens` Anthropic.
- **Cost target**: < $0.02 / coppia Explainer+Advisor su demo-commesse.
- **Lingua output**: italiano. Forza via system prompt.
- **Sicurezza**: prompt injection esposto via input utente bloccato (la soluzione è generata server-side, non c'è input utente in Wave 2 — Wave 3+).

## 6. Quello che NON è in scope di Wave 2

- Manager Chat conversazionale (Wave 3).
- What-if free-text input (Wave 4).
- Sub-order decomposition (Wave 5).
- Apprendimento dalle preferenze del manager (post-MVP).
- Personalizzazione per stabilimento (post-MVP).
- Sentiment / multilingua oltre italiano (post-MVP).

## 7. Test plan (Wave 2)

1. **Demo dataset**: `demo-commesse` deve produrre un Explainer e un Advisor riconoscibili.
2. **Edge cases (mock LLM)**: 5 fixture di soluzione (OPTIMAL pulita, FEASIBLE con warning, INFEASIBLE, empty, mal-formed) — l'Explainer deve gestire ognuna senza crash e con il template appropriato.
3. **Stress**: 50 spiegazioni back-to-back con prompt caching attivo. Costo medio < $0.02. Tempo-first-token < 1.5s. Tempo full < 8s.
4. **No hallucination**: in 20 spiegazioni casuali, verificare che TUTTI i numeri citati nell'output esistano nei KPI di input (test deterministico: regex match numeri + cross-check con `solution.kpis`).

## 8. UX nel frontend

- 2 nuovi pannelli in dashboard, side-by-side sotto il KPI summary e sopra il Gantt:
  - **Spiegazione AI** (a sinistra, ~60% width): testo flowing, streaming-friendly, scrollable se overflow.
  - **Consigli AI** (a destra, ~40% width): bullet list, scrollable.
- Bottone "Rigenera" su ciascun pannello (forza re-fetch).
- Bottone "Copia" che copia testo in clipboard.
- Loading state: skeleton + "🤖 DAINO AI sta analizzando…".
- Error state: messaggio chiaro + retry. Mai stack trace al manager.

## 9. Metrica di accettazione (Wave 2 GO criteria)

- [ ] Explainer produce paragrafo italiano coerente per `demo-commesse` (verifica manuale).
- [ ] Advisor produce 3-5 raccomandazioni con verbi imperativi e numeri concreti.
- [ ] No-hallucination test passa (20/20 numeri sono nei KPI input).
- [ ] Edge case test passa (5/5 fixture gestite senza crash).
- [ ] Stress: 50 chiamate, costo medio < $0.02, p99 < 8s, error rate < 5%.
- [ ] BFF deploy-pronto su Cloudflare Workers (`wrangler dev` funziona).
- [ ] ANTHROPIC_API_KEY mai esposta nel bundle client (verifica via `npm run build` + grep).
- [ ] Devils-advocate review chiude tutti gli HIGH in-cycle.

---

**Note d'uso per i teammate Wave 2**: questo PRD è il riferimento. Quando il prompt dell'LLM è ambiguo (es. tone, struttura output), prima si guarda QUESTO documento. Se il PRD non lo copre, il fallback è "concreto + italiano professionale + max 6 frasi". Le iterazioni successive (post-demo Paolo) raffineranno questo PRD.
