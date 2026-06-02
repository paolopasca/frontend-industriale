# DAINO — Codebase Guide (indice master)

> **Punto d'ingresso unico** alla documentazione tecnica "come funziona il codice, ogni cosa".
> Il progetto DAINO vive in **due repo** (frontend + backend); questo indice li tiene insieme. Ne esiste una copia in ciascun repo (questa è quella del frontend); la copia canonica/cross-progetto sta nell'hub-doc backend (`daino-backend-cp/docs/CODEBASE_GUIDE.md`, dove vivono anche ADR/RESEARCH_LOG + ARCHITECTURE).
> Ogni guida spiega *meccanismo per meccanismo* con riferimenti `file:riga` reali, e segue lo stesso schema per sezione (*Cosa fa · File chiave · Come funziona · Flusso dati · Invarianti & gotcha · Cross-reference*).
> Generate il 2026-05-30 (Wave 16.6) con un *dynamic workflow*: 7 subagent paralleli (uno per sottosistema), validati e poi integrati.

---

## 🖥️ Frontend — repo [`paolopasca/frontend-industriale`](https://github.com/paolopasca/frontend-industriale) (questo repo)
Guida: [`FRONTEND_ENGINEERING_GUIDE.md`](FRONTEND_ENGINEERING_GUIDE.md) (stessa cartella).

TanStack Start BFF (Cloudflare Workers) + React 19. È qui che vive tutto il layer LLM "manager AI".

- **FE-A — Core AI conversazionale + gate anti-allucinazione (3 strati)** → l'interprete Haiku a insieme chiuso: enum chiuso degli id reali + gate deterministico + show-and-confirm. *La risposta a "come fa a non allucinare mai".* (vedi anche ADR-107)
- **FE-B — Motore What-If + Ripianifica (pipeline SSE)** → scenario → re-solve reale; ledger vincoli cumulativi (NEW-WINS); re-gate M-4; guardia solution-vuota; cutoff/day-anchor; retry INFEASIBLE.
- **FE-C — Superfici Manager AI (chat, explainer, advisor, What-If UI, accept)** → loop agentico Haiku con alias; explainer/advisor Sonnet; merge envelope su "Accetta" (Gantt+KPI+produzione).
- **FE-D — Infrastruttura BFF + flusso dati dashboard** → Anthropic client (chiave server-only), rate-limit/costi, `adaptResult`, storage slug-scoped, PDF, env in dev.

## ⚙️ Backend — repo [`paolopasca/daino-backend-cp`](https://github.com/paolopasca/daino-backend-cp) (working copy locale: `daino-backend-definitivo`)
Guida: [`BACKEND_ENGINEERING_GUIDE.md`](https://github.com/paolopasca/daino-backend-cp/blob/main/docs/BACKEND_ENGINEERING_GUIDE.md) (altro repo). In locale: `../../daino-backend-definitivo/docs/BACKEND_ENGINEERING_GUIDE.md`.

FastAPI + OR-Tools CP-SAT. Solver FJSP *sector-agnostic*: un plugin che serve N frontend e **non va modificato per singolo frontend**.

- **BE-A — Solver CP-SAT + template FJSP + consumer delle regole** → richiesta → modello CP-SAT → schedule; asse model-minuti; i 6 consumer di `f_apply_rules.py`; frozen-window.
- **BE-B — Estrattore di vincoli deterministico (`arm_c`)** → istruzione italiana → intent + entità + confidence (HIT/GRAY/MISS) senza LLM; day-anchor; ask-flow; regex ReDoS-safe.
- **BE-C — API pubblica + persistenza + ingestione dati** → `create_app()`, endpoint pubblici, warm-start, split DB, ingestione, design plugin.

---

## Come leggerla
- Vuoi capire **l'anti-allucinazione** (la feature chiave)? → FE-A (deep, in questo repo) + ADR-107 in [`RESEARCH_LOG.md`](https://github.com/paolopasca/daino-backend-cp/blob/main/docs/RESEARCH_LOG.md) (la decisione + alternative).
- Vuoi seguire **cosa succede quando il manager scrive una frase**? → FE-A (interpreta) → FE-B (applica e risolve) → BE-A (il solver gira) → torna a FE-D (`adaptResult` ridisegna la dashboard).
- Vuoi il **contratto wire** fra i layer? → la forma `rules` è documentata in FE-A (*Flusso dati*) ed è la stessa che BE-A/BE-B consumano.

## Altri documenti di riferimento (repo backend)
- **Decisioni architetturali (ADR)**: [`RESEARCH_LOG.md`](https://github.com/paolopasca/daino-backend-cp/blob/main/docs/RESEARCH_LOG.md) — log accademico append-only (ADR-107 = interprete + anti-allucinazione, ADR-106 = reschedule day-anchored).
- **Architettura + changelog per wave**: [`ARCHITECTURE.md`](https://github.com/paolopasca/daino-backend-cp/blob/main/docs/ARCHITECTURE.md).
- **Overview feature-level (commerciale)**: [`BACKEND_FEATURES.md`](https://github.com/paolopasca/daino-backend-cp/blob/main/docs/BACKEND_FEATURES.md).
- **Backlog di prodotto**: [`PRODUCT_BACKLOG.md`](https://github.com/paolopasca/daino-backend-cp/blob/main/docs/PRODUCT_BACKLOG.md).

## Manutenzione
Questo trittico (indice + 2 guide) **non si aggiorna da solo**. Quando una wave cambia un sottosistema in modo sostanziale, rigenera la sezione interessata (anche con `/effort ultracode` su Claude Code ≥ 2.1.154, che orchestra il workflow da solo) e ri-appendila alla guida del repo giusto. Tieni allineate le due copie dell'indice (questa nel frontend + quella nell'hub-doc backend).
