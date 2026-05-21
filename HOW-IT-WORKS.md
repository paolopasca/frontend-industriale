# Frontend Industriale DAINO — Come funziona, cosa fa, come si testa

**Stato**: Wave 1 chiusa (2026-05-21). Frontend collegato al backend definitivo, 4 bottoni placeholder sistemati, e2e + stress passati. Wave 2+ (LLM explainer, manager chat, what-if, sottocommesse, ingestion ERP) **non ancora implementati** — quel layer è la roadmap.

---

## 1. Cosa è questo frontend

Una **SPA React** (Vite + TanStack Start) che fa da pannello di controllo per un manager di produzione industriale. Permette di:
1. Caricare un'azienda manifatturiera (oggi `demo-commesse` o le altre 34 demo).
2. Scegliere un metodo di ottimizzazione (`llm-only`, `codegen-pipeline`, `deterministic-json`).
3. Avviare il **solver di scheduling** (`daino-backend-definitivo`, OR-Tools CP-SAT).
4. Visualizzare i risultati: KPI, Gantt macchine, Gantt operatori, tabella ordini, analisi what-if (placeholder), piano operativo.
5. **Ripianificare** dopo eventi imprevisti (chat warm-start: "macchina X è giù dalle 14 alle 18").
6. Caricare nuovi dati via CSV / Excel / drag-drop e re-ottimizzare.
7. Esportare la pianificazione in PDF (browser print).

## 2. Collegamento al backend definitivo

| Aspetto | Stato | Dettaglio |
|---------|-------|-----------|
| Backend usato | `daino-backend-definitivo/` v0.4.0 (sector-agnostic, gelatino-free) | Lo trovi a `/Users/paolopascarelli/Desktop/DAINO/daino-backend-definitivo/` |
| Endpoint base | `VITE_API_BASE_URL` (env-driven) | default `http://localhost:8001` |
| Auth | JWT bearer su endpoint `/api/...` non-public | `autoLogin('<slug>')` chiama `/api/auth/login` con `demo/demo` (vedi caveat MED-1) |
| Public endpoint (no auth) | `companies`, `company/{slug}`, `solve-template`, `health` | Per onboarding rapido |
| Backend **non modificato** | ✅ verificato | `git diff main` su `daino-backend-definitivo/` ritorna vuoto. Plugin pattern preservato: il backend resta riutilizzabile per altri frontend (DAINO_HR, daino-help, daino-operator, futuri) senza forking. |

**Mappa endpoint** completa in [`wave0-compatibility.md`](./wave0-compatibility.md). I 2 endpoint rotti scoperti in Wave 0 (`/api/public/solve-llm` rimosso, `/api/public/chat-reschedule` non più public) sono stati risolti **lato client**:

- `solveLLMOnly()` ora chiama `solveTemplate()` con un adapter che mantiene la legacy `LLMOnlyResult` shape (vedi `src/lib/api.ts:111-155`).
- `chatReschedule()` ora usa il path autenticato `/api/analysis/{session_id}/reschedule` (vedi `src/lib/api.ts:240-`). Gestisce graziosamente il **501** (compose-path: nessun `solver.py` salvato) con messaggio UX dignitoso al posto di un crash.

## 3. Cosa funziona OGGI (Wave 1 fatto)

### Flow completo verificato end-to-end
- Setup → seleziona azienda da autocomplete → preview consultation + data files.
- Selezione metodo (3 opzioni).
- Ottimizzazione: loading animato + progress bar + factory game easter-egg.
- Dashboard: KPI summary, Gantt macchine, Gantt operatori, tabella ordini, what-if (4 scenari hard-coded — saranno rimpiazzati in Wave 4), bottleneck chart, piano operativo.
- ReplanModal: chat warm-start per disruption (sciopero, guasto, urgenza). Risposta del backend tradotta in: nuova soluzione, query dati, o messaggio "non disponibile" in caso di errore.

### Bottoni che ora funzionano davvero (Wave 1 fix)
| Bottone | File | Azione reale |
|---------|------|--------------|
| **Esporta PDF** | `DashboardHeader.tsx` | `window.print()` con CSS print-friendly (`styles.css`). Funziona su Chrome/Firefox/Safari. ⚠️ Gantt con >100 ops può rendering inconsistente fra browser (Wave 4 fix). |
| **Importa CSV** (Setup) | `SetupPage.tsx` | `<input type=file>` → `POST /api/upload-data` con JWT, toast feedback. |
| **Importa CSV** (Modal) | `DataInputModal.tsx` (tab Ordini) | idem |
| **Drag-drop Vincoli** | `DataInputModal.tsx` (tab Vincoli) | `onDrop` → stesso uploader |
| **Ottimizza con AI** (footer modal) | `DataInputModal.tsx` | `pipelineStart(slug, description, 'compose')` → chiude modal → loader parte |

### Test infrastruttura
- **Playwright** (`tests/e2e/`): 8 test, ~3 min wall-clock, 8/8 PASS.
- **Stress scripts** (`scripts/stress-wave1.ts`): fast-lane (20 cicli solve, 0% errori, latenza media 18.5s — il solver è ~17-18s di baseline) + slow-lane (10 scenari edge: payload 5MB, double-fire concorrenti, abort+retry, multilingua, 4xx handling, burst load 4 concorrenti).

## 4. Cosa NON c'è ancora (roadmap Wave 2+)

| Wave | Feature | Stato |
|------|---------|-------|
| 1.1 (cleanup) | 11 MED del [`docs/wave1-adversary-report.md`](./docs/wave1-adversary-report.md): `demo/demo` hardcoded, localStorage cross-tenant leak, helper duplicato | TODO |
| 2 | **BFF** (TanStack Start server functions) + **LLM Explainer** (Sonnet 4.6) post-solve: spiegazione narrativa decisione al manager, consigli operativi automatici, segnalazione anomalie | non iniziata |
| 3 | **Manager Chat** con Haiku 4.5: Q&A veloce su stato linee ("quante macchine sto usando?", "qual è la prossima scadenza?"), tool-use sul backend | non iniziata |
| 4 | **What-If strategici** con Opus 4.7: campo libero in cui il manager scrive scenari ("posso fermare linea 2 dalle 14 alle 18, conviene?") → analisi + bottone "esegui ottimizzazione con questo vincolo" | non iniziata (oggi What-If ha 4 scenari hard-coded) |
| 5 | **Sottocommesse**: split LLM-guidato di commesse troppo grosse → ricalcolo | non iniziata |
| 6 | **Disegno ingestione dati**: ADR + diagrammi per ERP (SAP, Oracle, Dynamics), DB (Postgres, MySQL), webhook real-time | non iniziata |

Piano completo: `~/.claude/plans/voglio-vedere-se-ilbackend-glimmering-petal.md`.

## 5. Come si fa partire tutto in locale

### Prerequisiti
- Node ≥ 20 (consigliato 22) + npm
- Python 3.11+ con `uv` (o virtualenv)
- macOS/Linux (Windows via WSL)
- `ANTHROPIC_API_KEY` (serve al backend per `solve-llm` e per le LLM calls)

### Backend definitivo (porta 8001)
```bash
cd /Users/paolopascarelli/Desktop/DAINO/daino-backend-definitivo

# Solo prima volta:
uv venv .venv && source .venv/bin/activate
uv pip install -e ".[dev]"
cp .env.example .env  # se non esiste

# Carica env e avvia
set -a && source .env && set +a
.venv/bin/uvicorn daino.api.app:app --host 127.0.0.1 --port 8001 --reload
```

Verifica:
```bash
curl http://127.0.0.1:8001/api/health
# {"status":"ok","timestamp":...}

curl http://127.0.0.1:8001/api/public/companies | jq '.[].slug' | head -5
# "apex-real-2026-04-28"
# "apex-tesi-toy"
# ...
```

### Frontend industriale (porta 8080)
```bash
cd /Users/paolopascarelli/Desktop/DAINO/frontend-industriale

# Solo prima volta:
npm install
cp .env.example .env.local
# .env.local contiene VITE_API_BASE_URL=http://localhost:8001 (default)

npm run dev
# VITE ready su http://localhost:8080
```

Apri `http://localhost:8080`, scegli `Demo Commesse`, premi `Ottimizza Produzione`, attendi ~18s.

## 6. Come si testa

### E2E (Playwright, ~3 min)
```bash
cd /Users/paolopascarelli/Desktop/DAINO/frontend-industriale
npm install               # solo prima volta
npx playwright install chromium  # solo prima volta
npm run test:e2e
```
Output atteso: 8 passed.

### Stress fast lane (~6 min)
```bash
npm run stress:wave1:fast
```
20 cicli sequenziali di `POST /api/public/solve-template` su `demo-commesse`. Misura p50/p95/p99 + error rate.

### Stress slow lane (~5 min)
```bash
npm run stress:wave1:slow
```
10 scenari edge (4xx, payload 5MB, timeout race, multilingua replan, double-fire, abort+retry, burst 4 concorrenti, ecc.).

### Entrambi
```bash
npm run stress:wave1 -- all
```

### Test rapido manuale (browser)
1. Apri `http://localhost:8080`.
2. Autocomplete → seleziona `Demo Commesse`.
3. Premi "Ottimizza Produzione".
4. Seleziona metodo `Deterministic JSON`.
5. Aspetta ~18s.
6. Verifica dashboard: KPI visibili, Gantt renderizza, ordini in tabella.
7. Clicca ogni bottone dell'header: Inserisci Dati / Ripianifica / Nuova Ottimizzazione / Esporta PDF.
8. Apri "Ripianifica" → scrivi "Macchina X1 in manutenzione domani 14-18" → verifica risposta (può essere errore graceful se la run è compose-path; basta che non crashi).

### Backend tests (Python, ~5 min, opzionale)
```bash
cd /Users/paolopascarelli/Desktop/DAINO/daino-backend-definitivo
.venv/bin/pytest -m "not slow and not benchmark" -x  # ~730 test
```

## 7. Architettura (a colpo d'occhio)

```
┌─────────────────────────────────┐
│  Browser (manager industriale)   │
│  http://localhost:8080           │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  Frontend Industriale (Vite SPA) │
│  React 19 + TanStack + shadcn    │
│  src/lib/api.ts ←  client API    │
└──────────────┬──────────────────┘
               │ VITE_API_BASE_URL
               │ (default http://localhost:8001)
               ▼
┌─────────────────────────────────┐
│  Backend Definitivo (FastAPI)    │
│  daino-backend-definitivo v0.4.0 │
│  OR-Tools CP-SAT + Anthropic SDK │
│  PLUGIN: usato anche da          │
│    - DAINO_HR                    │
│    - daino-help                  │
│    - daino-operator              │
│    - (futuri frontend)           │
└─────────────────────────────────┘
```

**Plugin pattern**: il backend non è modificato per il frontend industriale. Gestisce CORS via `DAINO_CORS_ORIGINS` env (oggi accetta `localhost:8080`, `:5173`, `:3000`, `:8081`). I frontend nuovi si aggiungono via env, niente fork.

Wave 2 introdurrà un **BFF** (backend-for-frontend) dentro questo stesso repo via TanStack Start server functions. Sarà l'unico nuovo runtime, e vivrà fianco a fianco col solver senza toccarlo:

```
Browser ──→ Vite SPA ──→ TanStack server fn (BFF) ──→ Anthropic API
                                  │
                                  └──→ Backend Definitivo (solver)
```

## 8. File chiave (riferimento veloce)

| File | Cosa fa |
|------|---------|
| `src/lib/api.ts` | Client HTTP verso backend definitivo. 14 funzioni esportate. |
| `src/components/onboarding/SetupPage.tsx` | Wizard di onboarding (4 step). |
| `src/components/onboarding/OptimizationLoader.tsx` | Loading animato durante solve, gestisce le 3 strategie. |
| `src/components/dashboard/*` | Dashboard post-solve (KPI, Gantt, ordini, what-if, ecc.). |
| `src/components/dashboard/ReplanModal.tsx` | Chat warm-start per disruption (Wave 1: graceful 501). |
| `src/data/resultAdapter.ts` | Adapter da backend response → shape interno (FJSP → LLMOnlyResult, ecc.). |
| `src/routes/index.tsx` | Router TanStack: solo `/`, 4 fasi via state machine. |
| `src/styles.css` | Tailwind 4 + CSS print custom per Export PDF. |
| `playwright.config.ts` | Config e2e. |
| `tests/e2e/wave1-*.spec.ts` | Test e2e Wave 1. |
| `scripts/stress-wave1.ts` | Fast/slow lane stress. |
| `docs/wave-1-report.md` | Report finale Wave 1 (GO for Wave 2). |
| `docs/wave1-adversary-report.md` | Report avversariale Wave 1 (3 HIGH risolti, 11 MED tracked). |
| `wave0-compatibility.md` | Mappa endpoint frontend ↔ backend definitivo. |
| `.env.example` | Template env (`VITE_API_BASE_URL`). |

## 9. Limiti noti (onesti)

Cose che oggi non funzionano o sono parzialmente coperte:

1. **Replan su run compose-path** (la strategia di default) ritorna 501: il backend non salva `generated_code` per quelle. Il frontend gestisce con messaggio UX dignitoso. Fix proprio nel backend è tracciato come gap (template_warm_reschedule), non lo stiamo fixando qui.
2. **`demo/demo` hardcoded** nell'uploader file (MED-1 del devils-advocate): si rompe sul primo cliente B2B reale. Fix in Wave 1.1.
3. **localStorage non isolato per tenant** (MED-3/4 del devils-advocate): switch da `apex-toy` a `demo-commesse` riporta il modale replan in stato confuso (session id del tenant vecchio). Fix obbligatorio prima di Wave 3 (la manager chat erediterebbe lo stesso bug).
4. **What-If** (4 scenari hard-coded): non chiama né il solver né LLM. Sostituito in Wave 4 con Opus + traduzione a `/api/modify-rules`.
5. **Soglia stress 8s del piano**: irrealistica per il solver attuale (baseline 18s). Da ricalibrare in Wave 2.
6. **Companies test vuote** (`demo-commesse-test-300` / `-test-60`): listate dall'API ma senza data files. Da seedare o nascondere.

## 10. Domande frequenti

**Il backend definitivo è davvero un plugin?**
Sì. `git diff main` su `daino-backend-definitivo/` è vuoto dopo Wave 1. Tutto il lavoro è nel frontend. Il backend continua a essere il solver per DAINO_HR, daino-help, daino-operator e ogni futuro frontend.

**Come faccio a usare un backend remoto invece di localhost?**
Cambia `VITE_API_BASE_URL` in `.env.local` con l'URL pubblico. Esempio per uno deploy Cloudflare/Railway:
```
VITE_API_BASE_URL=https://api.daino.example.com
```
Verifica solo che il backend abbia `DAINO_CORS_ORIGINS` che include `https://industriale.daino.example.com`.

**Posso testare contro un backend "mock" senza far girare uvicorn?**
Non ancora. Wave 1 non include MSW (mock service worker). I test e2e attuali richiedono il backend up. È un possibile miglioramento per la pipeline CI.

**Quanto costa una sessione LLM-only?**
Oggi `solve-llm` è stato rimosso dal backend. Il fallback `solve-template` (deterministic CP-SAT) costa $0. Le call LLM costose arriveranno in Wave 2+ (Sonnet) e 4+ (Opus); ognuna stimata a $0.005–$0.05 a seconda del modello.

**Posso committare le mie modifiche?**
Le 8 modifiche di Wave 1 sono nel branch `feat/wave1-backend-definitivo-link`. Non sono ancora committate. Per chiudere Wave 1: review del diff, `git add`, commit, push. Decisione di Paolo, non automatica.
