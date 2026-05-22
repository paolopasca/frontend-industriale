# DAINO — Integration Strategy (Fase 1)

**Status**: piano operativo per i primi 3 clienti B2B.
**Date**: 2026-05-22

Questo documento operativizza l'ADR `adr-data-ingestion-architecture.md`: per ognuno dei 3 primi clienti, indica connector da implementare, effort stimato, ordine.

## 1. Pre-requisiti tecnici

Prima del primo cliente reale dobbiamo avere:

- [ ] **Ingestion Fabric skeleton**: nuova repo `daino-ingestion-fabric/` con scheletro TypeScript + adapter interface comune.
- [ ] **Canonical payload schema** (Zod): copia di quanto `solve-template` accetta nel backend definitivo, esportato come `@daino/contracts`.
- [ ] **Secrets manager**: scelta vault (Cloudflare Secrets per Fase 1 → HashiCorp Vault o AWS Secrets per Fase 2+).
- [ ] **Health-check endpoint** per Fabric: `/health` + `/canonical-test` (consuma un sample dati cliente, ritorna mapped payload). Per debug onboarding.
- [ ] **CI/CD**: pipeline che testa Fabric → solver round-trip con fixture per cliente.

## 2. Cliente target Fase 1 (priorità)

> Sostituire con i nomi reali dei primi 3 clienti DAINO quando confermati.

| # | Cliente | Settore | Sorgente dati primaria | Connector prioritario | Effort dev |
|---|---------|---------|------------------------|------------------------|------------|
| 1 | _Cliente A (gelateria pilot — The Gelatist)_ | Food / artigianale | Excel via Google Drive | CSV/Excel + REST (Drive API) | 3-5 giorni |
| 2 | _Cliente B (metalmeccanico)_ | Manifatturiero | SAP B1 + file CSV settimanale | SAP B1 Service Layer + CSV SMB | 10-12 giorni |
| 3 | _Cliente C (tessile)_ | Tessile | MS SQL Server (gestionale custom) | MSSQL adapter | 5-7 giorni |

## 3. Roadmap operativa

### Sprint 1 (settimane 1-2) — Skeleton + Cliente A

- Setup repo `daino-ingestion-fabric/`.
- Schema canonical Zod export.
- Connector CSV (lettura file XLSX/CSV via SMB or local-fs).
- Connector REST generic (autenticazione API key).
- Cliente A wiring: CSV ricevuto via webhook Drive → mapping → POST `/api/public/solve-template` → return solution.
- Demo end-to-end interno.

### Sprint 2 (settimane 3-4) — Cliente B SAP

- Connector SAP B1 Service Layer (REST OData).
- Schema mapping interactive con Sonnet: legge `consultation_md` del cliente + sample data → propone JSON mapping → manager valida.
- Connector SMB per il file CSV settimanale.
- Cliente B onboarding: 1 settimana di test con sample dati anonimizzati, poi go-live.

### Sprint 3 (settimane 5-6) — Cliente C MSSQL

- Connector MSSQL (driver `mssql` Node).
- Gestione certificati on-prem.
- Schema mapping LLM-assisted (riuso pattern Cliente B).
- Cliente C onboarding.

### Sprint 4 (settimana 7) — Stabilizzazione

- Bugfix da 3 onboarding.
- Documentazione operativa per future onboarding (template consultation_md, checklist).
- Retrospective: quale connector è stato più costoso? Quale schema mapping LLM ha funzionato meglio?
- Decisione GO/NO-GO per Fase 2 (10+ clienti).

## 4. KPI di successo Fase 1

- Onboarding cliente **< 10 giorni dev effort** (target: 5-7).
- Costo LLM mapping per cliente **< $30** (target: < $15 con caching).
- Uptime Fabric **> 99%** (Cloudflare Worker tipicamente 99.9+).
- Latenza ingestion → solution **< 60s** per dataset tipico (target 30s).
- 0 incident di security legati a credenziali cliente.

## 5. Anti-pattern da evitare in Fase 1

- ❌ **Fork del backend definitivo** per gestire un caso edge cliente. Sempre fixare nel Fabric.
- ❌ **Hardcode credenziali nel codice**. Sempre via vault.
- ❌ **Trust cieco del cliente sul schema**. Sempre validare con Zod prima di passare al solver.
- ❌ **Mapping LLM senza validation manager**. Il primo round è sempre confermato da occhi umani.
- ❌ **Polling DB cliente ad alta frequenza**. Default è batch giornaliero/orario; real-time è Fase 2+.

## 6. Apertura punti per discussione

- **Where does Fabric run?** Cloudflare Workers (edge) vs container on-prem cliente (per air-gapped). Decisione per cliente in Fase 1, policy condivisa in Fase 2.
- **Secret rotation**: ogni 90 giorni? Manualmente o auto?
- **Audit log**: ogni read/write contro DB cliente loggato e mostrato al cliente? GDPR-aware.
- **SLA**: cosa promettiamo al cliente in Fase 1? 24h response per incident? 99.5% uptime?

## 7. Allineamento con Wave 0-5 (frontend industriale)

- `SetupPage.tsx` continuerà a supportare upload manuale Excel/CSV/PDF (Fase 0). Resta come fallback per onboarding e per i clienti senza ERP.
- Nuovi connector NON modificano il frontend industriale: la UI parla sempre con il backend definitivo via endpoint canonici. È il Fabric che, dietro le quinte, pesca dati dalle sorgenti e popola il backend (es. via cron + POST upload-data).
- LLM mapping helper (Sonnet) condivide pattern con il BFF Wave 2 (prompt caching su consultation_md), riusando `client.ts` se Fabric è co-locato.
