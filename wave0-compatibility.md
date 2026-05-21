# Wave 0 — Mappa di Compatibilità Frontend Industriale ↔ Backend Definitivo

**Data**: 2026-05-21  
**Backend definitivo**: `daino-backend-definitivo/` su `main @ 94bad69` (v0.4.0, sector-agnostic, gelatino rimosso 2026-05-18)  
**Frontend industriale**: `frontend-industriale/` su `feat/warm-start-chat`  
**API base**: `VITE_API_BASE_URL` env-driven, default `http://localhost:8001` (era hardcoded, fixato in [src/lib/api.ts:6](src/lib/api.ts:6))  
**Servers running**:
- Backend uvicorn → `http://127.0.0.1:8001` ✅ (`/api/health` → 200)
- Frontend vite dev → `http://localhost:8080` ✅ (HTTP 200)

## Tabella compatibilità

| # | Frontend caller | Endpoint backend | Stato definitivo | Note |
|---|-----------------|------------------|------------------|------|
| 1 | `login()` (api.ts:87) | `POST /api/auth/login` | ✅ Esiste ([routes_crud.py:102](../daino-backend-definitivo/daino/api/routes_crud.py:102)) | Compatibile |
| 2 | `listCompanies()` (api.ts:103) | `GET /api/public/companies` | ✅ Esiste ([routes_optimize.py:1819](../daino-backend-definitivo/daino/api/routes_optimize.py:1819)) | Testato live → 35 companies incl. `demo-commesse` |
| 3 | `getCompany()` (api.ts:107) | `GET /api/public/company/{slug}` | ✅ Esiste ([routes_optimize.py:1853](../daino-backend-definitivo/daino/api/routes_optimize.py:1853)) | Compatibile |
| 4 | `solveLLMOnly()` (api.ts:111) | `POST /api/public/solve-llm` | ❌ **RIMOSSO 2026-05-18** | 404 Not Found. **FIX Wave 1**: sostituire con `solveTemplate(slug, 'fjsp', {})` per il metodo `llm-only` (oppure rimuovere il metodo `llm-only` dal selettore se non più supportato). |
| 5 | `solveTemplate()` (api.ts:118) | `POST /api/public/solve-template` | ✅ Esiste ([routes_optimize.py:1883](../daino-backend-definitivo/daino/api/routes_optimize.py:1883)) | Compatibile |
| 6 | `pipelineStart()` (api.ts:139) | `POST /api/analysis/start` | ✅ Esiste ([routes_optimize.py:1273](../daino-backend-definitivo/daino/api/routes_optimize.py:1273)) | Verificare param `solver_method` accettato (era cp dal frontend) |
| 7 | `pipelineAdvance()` (api.ts:157) | `POST /api/analysis/{sid}/advance` | ✅ Esiste ([routes_optimize.py:1417](../daino-backend-definitivo/daino/api/routes_optimize.py:1417)) | Compatibile |
| 8 | `pipelineRespond()` (api.ts:164) | `POST /api/analysis/{sid}/respond` | ✅ Esiste ([routes_optimize.py:1486](../daino-backend-definitivo/daino/api/routes_optimize.py:1486)) | Compatibile |
| 9 | `pipelineResults()` (api.ts:172) | `GET /api/analysis/{sid}/results` | ✅ Esiste ([routes_optimize.py:1556](../daino-backend-definitivo/daino/api/routes_optimize.py:1556)) | Compatibile |
| 10 | `optimizeShifts()` (api.ts:180) | `POST /api/optimize-shifts` | ✅ Esiste ([routes_optimize.py:1035](../daino-backend-definitivo/daino/api/routes_optimize.py:1035)) | Compatibile, richiede auth |
| 11 | `getRun()` (api.ts:188) | `GET /api/runs/{id}` | ✅ Esiste ([routes_crud.py:202](../daino-backend-definitivo/daino/api/routes_crud.py:202)) | Compatibile |
| 12 | `autoLogin()` (api.ts:192) | `POST /api/auth/login` (su `demo-commesse`) | ✅ Esiste | Compatibile |
| 13 | `chatReschedule()` (api.ts:223) | `POST /api/public/chat-reschedule` | ❌ **NON ESISTE** in definitivo | 404. **FIX Wave 1**: passare a `POST /api/analysis/{session_id}/reschedule` ([routes_optimize.py:1682](../daino-backend-definitivo/daino/api/routes_optimize.py:1682)), che però richiede JWT + un `session_id` o `run_id` valido. ⚠️ Inoltre **ritorna 501** se la run è compose-path (caso più comune oggi!) perché non c'è `generated_code` salvato. Il frontend dovrà gestire il 501 con messaggio "reschedule non disponibile per questa strategia" oppure attendere il fix backend `template_warm_reschedule` (gap noto, tracciato in `daino-backend-definitivo/docs/to_do/`). |
| 14 | `healthCheck()` (api.ts:232) | `GET /api/health` | ✅ Esiste | Compatibile, testato live |

## Endpoint backend disponibili ma NON ancora chiamati dal frontend (utili per Wave 1+)

| Endpoint backend | File:linea | Utile per |
|------------------|------------|-----------|
| `POST /api/upload-data` | [routes_crud.py:850](../daino-backend-definitivo/daino/api/routes_crud.py:850) | Bottone "Importa CSV" (Wave 1) e "Upload File Dati" in DataInputModal |
| `POST /api/modify-rules` | [routes_optimize.py:518](../daino-backend-definitivo/daino/api/routes_optimize.py:518) | Delta-resolve dopo cambio regola (utile per What-If Wave 4) |
| `POST /api/cascade-solve` | [routes_optimize.py:798](../daino-backend-definitivo/daino/api/routes_optimize.py:798) | Cascading staff→FJSP (multi-store gelaterie / scenari avanzati) |
| `POST /api/analysis/{sid}/reset` | [routes_optimize.py:1637](../daino-backend-definitivo/daino/api/routes_optimize.py:1637) | Bottone "Reset" pulito sessione lato server |
| `GET /api/kpi` | [routes_crud.py:657](../daino-backend-definitivo/daino/api/routes_crud.py:657) | KPI live per Manager Chat (Wave 3) |
| `GET /api/runs` | [routes_crud.py:178](../daino-backend-definitivo/daino/api/routes_crud.py:178) | Storico per analytics |
| `GET /api/staff`, `/api/shifts`, `/api/stores` | routes_crud.py | Tool-use per Manager Chat (Wave 3) |

## Gate Wave 0 — Esito

| Criterio | Esito |
|----------|-------|
| `curl :8001/api/health` → 200 | ✅ `{"status":"ok","timestamp":1779354002.481728}` |
| Backend lista `demo-commesse` su `/api/public/companies` | ✅ presente nella lista |
| Frontend dev su :8080 risponde 200 | ✅ |
| `VITE_API_BASE_URL` env-driven introdotto | ✅ `.env.example` + `.env.local` creati, [src/lib/api.ts:6](src/lib/api.ts:6) usa `import.meta.env.VITE_API_BASE_URL` |
| `wave0-compatibility.md` esiste con fix proposti | ✅ (questo file) |

## Take-aways per Wave 1

**Critici da fixare subito**:
1. `solveLLMOnly()` rotto → o sostituire con `solveTemplate()`, o rimuovere il metodo `llm-only` dal selettore in [SolverMethodSelect.tsx](src/components/SolverMethodSelect.tsx). Decisione raccomandata: **sostituire** così non si rompe l'UI esistente.
2. `chatReschedule()` rotto → migrare a `/api/analysis/{sid}/reschedule` autenticato, accettare il fallimento 501 con messaggio UX dignitoso ("reschedule non disponibile per questa strategia").

**Opportunità collegate**:
- Bottoni "Importa CSV" e "Upload File Dati" possono finalmente diventare reali grazie a `/api/upload-data`.
- `pipelineStart()` accetta `solver_method`: verificare in Wave 1 che il parametro venga propagato correttamente quando l'utente sceglie un metodo nel SolverMethodSelect.

**Gap del backend (NON FIXIAMO — sono noti)**:
- `template_warm_reschedule` non implementato: reschedule per compose-path → 501. Il frontend industriale dovrà gestirlo. Tracciato nel registro `to_do/` del backend definitivo.
- `/api/public/solve-llm` removal lasciato senza migration path lato client: questa wave 0 lo documenta.
