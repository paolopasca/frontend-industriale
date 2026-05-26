# Wave 15 — Live-test bug-fix bundle + cost reduction

> **Origine**: sessione live-test 2026-05-26 (master task #14, F-W14-LIVE-MASTER). Lanciato BE+FE, testato ogni bottone via Chrome MCP, audit costi LLM. Wave 15 raccoglie 9 problemi tracciati come task #15-23 + 1 risolto inline (constraint-translator Opus → Sonnet/Haiku) → riduzione costo manager-session **-51% minimo, fino a -85% se translator passa a Haiku**.
>
> **Stato gating**: pronta da avviare. Tutti i bug sono riproducibili in locale, nessuno richiede top-up Anthropic (anzi: riduce i costi).
>
> **Durata stimata**: 1.5 giornate-uomo se eseguito serialmente, ~6h con agent team a 3 teammate (vedi sez. "Esecuzione consigliata").

---

## Punch list — 9 problemi (in ordine di priorità)

### 🚫 WONTFIX (decisione Paolo 2026-05-26)

#### W15-01 · `constraint-translator.ts` resta Opus 4.7 (task #21 → WONTFIX)
- **File**: `src/server/llm/constraint-translator.ts:36`
- **Sintomo**: ogni click "Esegui ottimizzazione con questo vincolo" costa $0.45.
- **Decisione Paolo**: *"il traslator constraint va bene che è opus, se sbaglia sono cazzi"*. Accuracy del payload JSON è critica — un translator che sbaglia produce un piano di produzione sbagliato, downside catastrofico. Costo $0.45/click accettabile come premium di safety.
- **Status**: NO CHANGE. Lasciato Opus 4.7 esplicitamente. Task #21 da marcare wontfix.
- **Nota**: la copy obsoleta "Opus 4.7" su What-If e Sotto-commesse va comunque corretta (W15-05) — quei pannelli usano Sonnet (whatif.ts + split.ts), NON il translator.

---

### 🟠 ALTA — DX permanente

#### W15-02 · Auto-source `.env.local` in `npm run dev` (task #18)
- **File**: `package.json` (script `dev`)
- **Sintomo**: `npm run dev` non espone `ANTHROPIC_API_KEY` a `process.env` in SSR → tutte le surface AI (explain/advise/whatif/split/manager-chat/apply) falliscono con SSE error `"ANTHROPIC_API_KEY not set"`. Workaround corrente: `set -a && source .env.local && set +a && npm run dev` (fragile, ogni nuovo dev deve ricordarsi).
- **Root cause**: Vite documenta che `.env.local` viene caricato per SSR ma in pratica con TanStack Start su Node non viene popolato in `process.env` finché non si fa export esplicito.
- **Fix**: aggiungere `dotenv-cli` come devDep e cambiare lo script:
  ```json
  "dev": "dotenv -e .env.local -- vite dev"
  ```
- **Verifica**: dopo fix, `npm run dev` deve far funzionare AI panels al primo colpo senza intervento manuale.

---

### 🟠 ALTA — UX core post-solve

#### W15-03 · Esporta PDF stampa l'intera dashboard invece del piano operativo (task #23)
- **File**: `src/components/dashboard/DashboardHeader.tsx:50-51`
- **Sintomo**: `handleExportPdf` chiama `window.print()` → PDF di tutto il viewport (KPI cards + AI panels + Gantt + What-If + ordini). Il manager industriale vuole solo l'ordine di produzione ottima con orari (macchine + commesse assegnate per fascia oraria).
- **Specifica del PDF "produzione-ready"**:
  1. **Header**: nome azienda + data generazione + makespan totale + on-time rate
  2. **Per ogni macchina** (M01..M05) una sezione con tabella ordinata per `start_min`:
     ```
     | # | Ordine | Operatore | Setup | Lavorazione | Inizio | Fine |
     ```
  3. (Opzionale) Lista ordini con stato/scadenza
  4. **NIENTE**: Gantt chart, AI panels, What-If, KPI cards estese
- **Fix proposto** (3 opzioni, raccomandata B):
  - **A** — Raffinare `@media print` CSS aggiungendo `.no-print` a tutto tranne `PianoOperativoDettagliato`. Cheap (1-2h) ma fragile (CSS lascivo, layout ereditato).
  - **B** ✅ **RACCOMANDATA** — Rotta dedicata `/print/$slug` con layout minimale. Pulito, supporta query params (`?orientation=landscape` per Gantt opzionale). Il bottone Esporta PDF apre `/print/$slug` in nuova tab e triggera `window.print()`. ~4h.
  - **C** — Endpoint server-side `/api/export-pdf` con jsPDF/pdfme. Massimo controllo, supporta watermark/branding. ~1 giornata. Overkill per MVP.

---

#### W15-04 · OptimizationLoader: cost mislabel + step icons grigi (task #17 + #19)
- **File**: `src/components/OptimizationLoader.tsx`
- **Sintomi cumulativi**:
  1. BACKEND LOG mostra "Template deterministico — 0 LLM calls" + "Costo: $0.01348" sulla stessa schermata. Il costo è BFF (explainer+advisor auto-fire post-solve), non backend. Label confondente.
  2. Quando il progress arriva al 100% e mostra "Ottimizzazione Completata!", solo lo step 1 (Caricamento regole JSON) ha la spunta verde. Step 2/3/4 restano grigi.
- **Fix combinato**:
  - Separare visivamente in due blocchi: `BACKEND LOG` (template_solve, status, objective) e `BFF LLM COST` (explainer+advisor cumulativi). Etichettare i blocchi esplicitamente.
  - Aggiornare lo stato `completed` di tutti gli step quando `progress === 100`. Probabilmente è uno setState mancante alla fine.

---

### 🟡 MEDIA — Copy cleanup

#### W15-05 · Copy obsoleta "Opus 4.7" su What-If + Sotto-commesse (task #20)
- **File**: `src/components/dashboard/WhatIfAnalysis.tsx` + `src/components/dashboard/SplitSuggestion.tsx`
- **Sintomo**: l'hint dice "Opus 4.7 analizza impatti, trade-off..." e "Opus 4.7 propone una decomposizione...". Dopo Wave 14 il modello è Sonnet 4.6.
- **Fix**: replace stringa, opzionalmente generalizzare a "il sistema AI" così non dobbiamo aggiornare ad ogni model swap. Verificare anche stringhe interne tipo "🧠Opus sta analizzando..." nei loader.

---

### 🟢 BASSA — Pulizia dev environment

#### W15-06 · Warning Vite su test files in `src/routes/api/__tests__/*` (task #22)
- **Sintomo**: 6 warning ad ogni `npm run dev`: "Route file '...test.ts' does not export a Route. This file will not be included in the route tree". Inoltre esiste directory duplicata `__tests__ 2/` accanto a `__tests__/` (artefatto Finder copy/paste).
- **Fix**:
  - Spostare i test fuori da `src/routes/api/` → `tests/api/` o `src/server/api/__tests__/`. La convention TanStack Start è che `src/routes/` contiene SOLO file che esportano una Route.
  - Cancellare la directory duplicata `__tests__ 2/`.

---

### ✅ Già risolti durante la sessione live (no work needed in Wave 15)

#### W15-✓01 · ANTHROPIC_API_KEY non caricata da TanStack Start dev server (task #15)
- Era sintomo della config DX issue → vedi W15-02 per fix permanente. Lo workaround manuale è documentato nel task #18.

#### W15-✓02 · Riprova spiegazione resta in error nonostante /api/explain 200 (task #16)
- Era sintomo di W15-✓01. Dopo fix env, entrambi auto-fire e Riprova funzionano correttamente (verificato live: 4 chunks streamed, $0.0668 Sonnet).

#### W15-✓03 · What-If click reset all'inizio (pre-ottimizzazione) (task #13)
- Non riprodotto via test live (Analizza/Esegui/Scarta/Accetta tutti senza reset). Probabilmente era anch'esso sintomo di W15-✓01. Chiuso, riapri se ricapita post-fix.

---

## Cost summary post-Wave 15

Con W15-01 wontfix (Opus translator mantenuto per safety), il costo per sessione manager **non cambia** rispetto a pre-Wave 15:

| Surface | Pre-W15 | Post-W15 |
|---|---|---|
| 1× solve + auto explainer + advisor | $0.014 | $0.014 |
| 3× chat questions (Haiku) | $0.015 | $0.015 |
| 2× what-if analyze (Sonnet) | $0.17 | $0.17 |
| 1× what-if apply (Opus translator) | $0.45 | $0.45 |
| 1× split suggest (Sonnet) | $0.04 | $0.04 |
| **Totale per sessione manager** | **$0.69** | **$0.69** |

Wave 15 sposta valore su **DX (W15-02) + UX (W15-03/04/05) + dev cleanup (W15-06)**. Cost reduction futura va cercata altrove: prompt caching su explainer/advisor (potenziale -50% input tokens dopo la prima call della stessa azienda), oppure decision Paolo se Sonnet basta su qualche surface non-critica (es. split suggest).

---

## Esecuzione consigliata

### Opzione A — Sessione singola serial (~1.5 giornate)
Lavora dal task più impattante (W15-01) al più cosmetico (W15-06). PR singola "Wave 15 — Live-test bug-fix bundle".

### Opzione B (SCELTA) — Agent team 3 teammate parallelo (~5-6h)
- **teammate-pdf-architect** (owner: nuova rotta `src/routes/print/$slug.tsx` + tweak `src/components/dashboard/DashboardHeader.tsx` per redirect) → W15-03 (PDF /print/$slug dedicato)
- **teammate-ux-polish** (owner: `src/components/OptimizationLoader.tsx`, `src/components/dashboard/WhatIfAnalysis.tsx`, `src/components/dashboard/SplitSuggestion.tsx` o equivalenti) → W15-04 + W15-05
- **teammate-dev-cleaner** (owner: `package.json`, `src/routes/api/__tests__/` directory, file system) → W15-02 + W15-06

Branch: `fix/wave-15-bugs`. Ogni teammate scrive test per il proprio fix (feedback_test_each_task) e fa commit con messaggio convenzionale. NO auto-merge su main (feedback_no_auto_merge_main).

Vedi skill `agent-teams` per dimensionamento (3 teammate è sweet spot per 5 task con ownership disgiunte).

---

## Gate Wave 15 done

- [ ] Tutti i 6 task implementati e committati su feature branch `fix/wave-15-bugs`
- [ ] PR aperta con before/after costo apply-whatif documentato (screenshot Confronto Soluzioni)
- [ ] Test live a fine wave (replay del flow di sessione 2026-05-26): setup → solve → spiegazione → consigli → chat → what-if → apply → scarta → split → esporta PDF → verificare che il PDF contenga SOLO il piano operativo
- [ ] Doc `wave-15-report.md` con misurazioni cost reali (10 cicli apply-whatif)
- [ ] Task #15-23 marcati `completed`

---

## Decisioni Paolo 2026-05-26

1. ✅ **Translator constraint**: resta Opus 4.7. *"se sbaglia sono cazzi"* — accuracy > cost qui. W15-01 → WONTFIX.
2. ✅ **PDF Esporta**: rotta `/print/$slug` dedicata (opzione B).
3. ✅ **Esecuzione**: agent team 3 teammate parallel.
