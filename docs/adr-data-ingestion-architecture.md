# ADR — Architettura di ingestione dati DAINO

**Date**: 2026-05-22
**Status**: Proposed (per validazione post-MVP)
**Category**: Architecture / Data
**Scope**: come DAINO acquisisce i dati dei clienti B2B oggi e nei prossimi 12-18 mesi.

## 1. Context

Oggi (Wave 0-5) il caricamento dati nel backend definitivo è limitato a:
- **Excel** (`.xlsx`, `.xls`) via Unger frontend di Setup (`/api/upload-data`).
- **CSV** (`.csv`) per dataset benchmark.
- **PDF** (`.pdf`) via "hybrid LLM ingestion" (ADR-006 nel backend).
- **Fixture** statiche (`companies/<slug>/data.xlsx`).

L'utente target di Wave 6+ (manager di PMI manifatturiera, primi 3 clienti B2B) NON gestirà Excel manualmente. I dati vivono in:
- **ERP**: SAP B1, Dynamics 365 Business Central, Odoo, Infor LN, Sage X3, AS400 legacy.
- **MES / SCADA**: Wonderware, Ignition, ProManage, custom on-prem.
- **Database operativi**: PostgreSQL, MySQL, MS SQL Server, MongoDB.
- **File system**: SMB share con CSV/Excel aggiornati notturnamente.
- **API REST custom**: portali partner, e-commerce dropshipping.
- **Real-time**: Kafka / MQTT (IoT linee).

Senza un'architettura di ingestione strutturata, ogni cliente diventa un fork del solver — esattamente l'anti-pattern che il backend definitivo evita per design.

## 2. Decision

Introduciamo un **livello di adapter** ("Ingestion Fabric") che vive **fuori dal backend definitivo** e converte le rappresentazioni client-side in un payload canonico (`solve-template` body) che il solver consuma senza modifiche.

```
┌───────────────────────────────────────────────────┐
│  Sorgenti dati cliente                            │
│   - ERP (SAP, D365, Odoo, ...)                    │
│   - MES / SCADA                                   │
│   - DB operativi (Postgres, MySQL, MSSQL, ...)    │
│   - File share (SMB / FTP)                        │
│   - API REST custom                               │
│   - Real-time (Kafka, MQTT)                       │
└────────────────┬──────────────────────────────────┘
                 │
                 ▼ "raw extract"
┌───────────────────────────────────────────────────┐
│  Ingestion Fabric (NEW)                           │
│   ┌──────────────────────────────────────────┐    │
│   │  Connector layer (per source type)        │   │
│   │  - sap-b1.ts, d365.ts, odoo.ts            │   │
│   │  - postgres.ts, mysql.ts, mssql.ts        │   │
│   │  - smb.ts, ftp.ts, rest.ts                │   │
│   │  - kafka.ts, mqtt.ts                      │   │
│   └──────────────────────────────────────────┘    │
│   ┌──────────────────────────────────────────┐    │
│   │  Schema mapping (Zod + LLM fallback)      │   │
│   │  - Custom-field → DAINO canonical-field   │   │
│   │  - Type coercion + validation             │   │
│   └──────────────────────────────────────────┘    │
│   ┌──────────────────────────────────────────┐    │
│   │  Canonical payload builder                │   │
│   │  - Schema = backend definitivo contract   │   │
│   │  - { commesse[], macchine[], operatori[], │   │
│   │      vincoli[], tempi[], windows[] }      │   │
│   └──────────────────────────────────────────┘    │
└────────────────┬──────────────────────────────────┘
                 │
                 ▼ "canonical payload"
┌───────────────────────────────────────────────────┐
│  Backend Definitivo (daino-backend-definitivo)    │
│   - POST /api/public/solve-template               │
│   - POST /api/optimize-shifts                     │
│   - POST /api/modify-rules                        │
│   - (unchanged, sealed plugin)                    │
└───────────────────────────────────────────────────┘
```

## 3. Alternatives considered

### 3.1 Estendere il backend definitivo con connettori built-in

**Rifiutato**. Ogni nuovo connettore (SAP, Odoo, Kafka, ...) richiederebbe un rilascio del solver, vincolando la cadenza di shipping del business al ciclo di rilascio del modello matematico. Inoltre il backend si caricherebbe di dipendenze pesanti (driver DB, SDK ERP) che lo rendono difficile da mantenere come "sealed plugin".

### 3.2 Far scrivere ai clienti gli adapter (open source / partner)

**Rifiutato per MVP**. I clienti B2B target non hanno team IT in-house, e l'iniziale ci aspetta nei primi 12 mesi. Un partner-driven ecosystem ha senso a partire da 20+ clienti.

### 3.3 ETL tradizionale (Airbyte / Fivetran / Talend)

**Considerato per fase 2**. Strumenti maturi ma:
- Sovradimensionati per il volume DAINO (1-10 batch/giorno per cliente).
- Costo licenza per cliente sostanziale.
- Latenza tipica 5-15 min (incompatibile con replanning real-time).
- Schema mapping ETL è static; DAINO ha bisogno di mapping LLM-assisted per consultation_md → schema canonical.

Il pattern Ingestion Fabric può *eventualmente* delegare ad Airbyte per estrazione raw + DAINO fa solo il mapping. Soluzione ibrida da valutare al 5° cliente.

### 3.4 Connessione diretta DB cliente → backend definitivo

**Rifiutato per sicurezza**. Esporre credenziali DB cliente al backend solver è una superficie d'attacco grande. L'adapter Fabric isola: ha le credenziali DB, ma il backend definitivo vede solo il payload normalizzato.

## 4. Rationale

L'Ingestion Fabric è la giusta astrazione perché separa le **tre dimensioni che evolvono indipendentemente**:

1. **Modello matematico** (backend definitivo) — cambia raramente (~quarterly release).
2. **Sorgenti dati cliente** — vario tra clienti, cambia frequentemente (ogni cliente porta una nuova combinazione).
3. **Mapping semantico** — cambia per ogni nuovo cliente, ma riusabile via consultation_md + LLM mapping.

Avere un layer dedicato per (2) e (3) consente al backend di rimanere stabile e produzione-pronto, mentre l'onboarding di un nuovo cliente diventa una configurazione + (eventualmente) un nuovo connector file, NON un rilascio del solver.

Il Fabric è coerente con il pattern "BFF in TanStack server functions" (ADR-097 del backend research log): ogni frontend ha il suo BFF, ogni cliente ha il suo Fabric. Entrambi sono adapter sopra un core stable.

## 5. Consequences

### Positive
- Backend definitivo rimane **sealed**: nessuna dipendenza nuova per connettori, nessun rilascio del solver per onboardare un cliente.
- Onboarding cliente: ~3-7 giorni (configurazione + mapping) invece di 1-2 settimane (fork).
- Connettori riusabili: dopo il primo cliente SAP, il secondo è 2 giorni invece di 7.
- Schema mapping LLM-assisted: consultation_md scritta dal manager → mapping JSON via Sonnet/Opus → drastica riduzione effort di pre-vendita.
- Sicurezza: credenziali DB / API key cliente isolate nel Fabric, mai esposte al solver.

### Negative
- Un layer in più da deployare e monitorare (logging + alerting + osservabilità).
- Manutenzione connettori: ogni release ERP/MES può rompere un adapter.
- Schema drift: il payload canonical che il backend si aspetta è il *contract* del Fabric. Quando il backend evolve, il Fabric deve adeguarsi.
- Sui modelli on-premise (AS400, MSSQL air-gapped), il Fabric deve girare on-prem accanto al cliente — complica deploy.

### Risks
- **Connettori abbandonati**: se un cliente B2B usa SAP B1 versione 9.3 (legacy), l'effort di mantenimento può superare il valore. Mitigazione: matrice supportata pubblica + sunset policy.
- **LLM mapping cost**: se ogni nuovo cliente costa $50-200 in chiamate Opus per il mapping, va aggiunto al pricing. Mitigazione: prompt-caching, mapping una sola volta in onboarding, poi schema "frozen".
- **Sicurezza credenziali**: il Fabric custodisce token ERP / DB password. Necessita vault / secrets manager (HashiCorp Vault, AWS Secrets, Cloudflare Secrets). Mitigazione: ADR separato post-MVP per il secret management.

## 6. Migration path (oggi → fase 3)

### Fase 0 — oggi (Wave 0-5)
- Excel/CSV/PDF upload via `/api/upload-data` (backend definitivo).
- `frontend-industriale/SetupPage.tsx` + `DataInputModal.tsx` come UI.
- 1 cliente demo (`demo-commesse`).

### Fase 1 — primi 3 clienti B2B (3-6 mesi)
- Fabric MVP: 2 connettori (CSV via SMB share + REST API generic).
- Schema mapping: manuale per cliente, con consultation_md guidato da Sonnet (Wave 2 explainer pattern riusato).
- Deploy: stesso Cloudflare Workers / Nitro del frontend, con `wrangler.toml` per cliente.
- Throughput: 1-2 batch/giorno per cliente.

### Fase 2 — 5-10 clienti (6-12 mesi)
- Fabric: aggiungere connettori SAP B1, Odoo, Postgres.
- LLM mapping automatizzato: Opus 4.7 legge un sample dei dati cliente + consultation_md e genera il mapping JSON. Manager valida.
- Deploy: per-cliente isolato (Cloudflare Worker dedicato OPPURE shared con tenant key).
- Throughput: ogni 30 min batch + real-time per emergency replan.

### Fase 3 — 10+ clienti (12-18 mesi)
- Real-time connettori: Kafka / MQTT per IoT.
- Self-service onboarding via `frontend-industriale` (manager configura il connector senza intervento DAINO).
- Schema marketplace: pattern di mapping riusabili (es. "tessile italiano", "metalmeccanico tedesco").
- Throughput: continuous-streaming + replan automatico su event.

## 7. Connector matrix (priorità Fase 1)

| Priority | Connector | Source | Auth | Effort | Note |
|----------|-----------|--------|------|--------|------|
| P0 | CSV / Excel via SMB | File share Windows | NTLM / Kerberos | 3 giorni | Il caso più comune in PMI italiane. |
| P0 | REST API generic | API HTTP cliente | API key / OAuth2 | 2 giorni | Per portali partner, e-commerce. |
| P1 | PostgreSQL | DB operativo | password / cert | 2 giorni | Standard di mercato, driver Node stable. |
| P1 | MySQL | DB operativo | password / cert | 2 giorni | Idem. |
| P2 | SAP Business One | ERP | Service Layer auth | 7 giorni | Service Layer REST è ben documentato; SDK Node esiste. |
| P2 | MS SQL Server | DB operativo | SQL auth / AD | 3 giorni | Driver `mssql` per Node, ma certificati su molti deploy on-prem possono dare problemi. |
| P3 | Odoo | ERP | API key | 5 giorni | XML-RPC; alternative REST in versioni recenti. |
| P3 | Dynamics 365 BC | ERP | Azure AD OAuth2 | 7 giorni | OData REST API moderna. |
| P4 | AS400 / iSeries | ERP legacy | TLS DB2 | 14 giorni | Dipendenze native, casi limite. |

## 8. References

- ADR-097 (backend research log) — BFF in TanStack server functions, plugin pattern.
- ADR-006 (backend) — hybrid PDF ingestion via LLM (precursore del mapping LLM-assisted).
- `docs/wave0-compatibility.md` — endpoint backend disponibili (consumiamo `/api/upload-data` per ora, `/api/public/solve-template` come contract canonico).
- Anthropic prompt caching docs — per ammortizzare cost del mapping LLM su onboarding.
- Cloudflare Workers + Secrets — runtime target per Fabric Fase 1.
