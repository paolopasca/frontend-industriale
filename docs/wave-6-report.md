# Wave 6 — Data ingestion architecture (ADR)

**Branch**: `feat/wave6-data-ingestion-adr`
**Verdict**: **Documentazione consegnata.** Niente codice prod scritto in Wave 6 — è la chiusura documentale del piano 6-wave.

## 1. Output

| File | Purpose |
|------|---------|
| `docs/adr-data-ingestion-architecture.md` | ADR formale: contesto, decisione (Ingestion Fabric), alternative scartate (estendere il backend / partner adapter / ETL tradizionale / connessione diretta DB), rationale, consequences pos/neg/risks, migration path 4 fasi, connector matrix con priorità P0-P4. |
| `docs/integration-strategy.md` | Roadmap operativa Fase 1: pre-requisiti tecnici, 3 clienti target Fase 1 con effort stimato, sprint 1-4 (8 settimane), KPI di successo, anti-pattern, punti aperti per discussione. |

## 2. Decisione architetturale chiave

**Ingestion Fabric** = nuovo layer fuori dal backend definitivo, che converte sorgenti cliente (ERP / DB / file / API / real-time) in un payload canonico che il solver consuma senza modifiche. Mantiene il backend "sealed" come da pattern plugin (ADR-097).

## 3. Coerenza con Wave 0-5

- Backend definitivo: **untouched**, plugin pattern preservato.
- Frontend industriale: continua a parlare con il backend via endpoint canonici. Il Fabric vive dietro le quinte (cron / webhook → POST upload-data).
- Pattern Sonnet (Wave 2 explainer) → riusato come LLM mapping helper (consultation_md → schema JSON).
- Pattern Opus (Wave 4 what-if + Wave 5 split) → riusato per il "schema diagnosis" quando un cliente porta dati irregolari.

## 4. Roadmap suggerita (sintesi)

| Sprint | Settimane | Output |
|--------|-----------|--------|
| 1 | 1-2 | Skeleton + Cliente A (CSV/Excel + REST) |
| 2 | 3-4 | Cliente B (SAP B1 Service Layer + SMB) |
| 3 | 5-6 | Cliente C (MSSQL on-prem) |
| 4 | 7 | Stabilizzazione + retrospective + GO/NO-GO Fase 2 |

## 5. Verdict

Wave 6 chiude il piano. Tutte e 6 le wave (più Wave 1.1 cleanup) hanno landed. Le decisioni architetturali sono documentate per il prossimo livello di scalata (10+ clienti, Fase 2-3).

**Pipeline complessiva**: ✅ Wave 0 + 1 + 1.1 + 2 + 3 + 4 + 5 + 6 → ALL SHIPPED.
