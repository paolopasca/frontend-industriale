# Wave 16.2 — Test Report (Post-merge)

> Test eseguiti 2026-05-26 dal team-lead post merge PR #6
> Tipologia: mock unit + stress agentic + eval data realistic + MCP live UI
> Tracking: costi + correctness + latency + bug trovati

---

## Summary

| Categoria | Test | Esito | Cost |
|---|---|---|---|
| **Mock backend** | 69 pytest (extractor + routes + contract) | ✅ 69/69 PASS (1.21s) | $0 |
| **Mock BFF** | 5 vitest bff-extract-constraint | ✅ 5/5 PASS (125ms) | $0 |
| **Stress agentic** | 30 scenari extract-constraint | ✅ 27/30 correct (90%), 0 errors, avg 8ms | $0.003 backend compute |
| **Eval data realistic** | demo-commesse via UI | ⚠️ KPI OK ma 503 rate-limit bloccante | – |
| **MCP live UI** | Setup → Solve → AI panels | ✅ KPI corretti, Wave 15.1 fix visibili | $0.0129 backend solve |

**Stato finale**: Wave 16.2 funziona a livello backend extractor (90% accuracy) ma il live test ha esposto **2 bug residui** che impattano l'UX manager.

---

## 1. Mock unit tests

### Backend (`daino-backend-definitivo`)
```
.venv/bin/pytest tests/test_constraint_extractor.py \
  tests/test_routes_internal.py \
  tests/test_constraint_extractor_contract.py -q
# 69 passed in 1.21s
```

### Frontend BFF (`frontend-industriale`)
```
npx vitest run --config vitest.server.config.ts src/server/llm/__tests__/bff-extract-constraint.test.ts
# 5/5 tests passed (125ms)
```

Tutti i percorsi HIT / GRAY_ZONE / MISS / timeout-fallback coperti unit.

---

## 2. Stress agentic — 30 scenari su `/api/internal/extract-constraint`

Test script: `/tmp/stress-eval-extract.sh`. Context realistico con 5 macchine M-1..M-5, alias "linea N" → "M-N", 10 ordini COM-001..COM-010, 3 turni (mattino/sera/notte), time_config + shift_types canonical + order_deadlines.

### Risultati per banda

| Banda | Expected | Actual | Match rate |
|---|---|---|---|
| HIT (>=0.85) | 12 | 11 | 91.7% (1 miss: "fermare M-3 dalle 09 alle 11" → MISS) |
| GRAY_ZONE (0.5-0.85) | 10 | 8 | 80% (2 miss: "Sposta il turno sera", "Ferma la linea 99 dalle 14 alle 18") |
| MISS (<0.5) | 8 | 11 | 137.5% (sovra-classificati 3) |
| **Overall correct** | 30 | **27** | **90%** |

### 3 bug pattern (Wave 16.3 tasks #34-#36)

1. **#34** machine_unavail_v1 regex non riconosce `M-N` diretto, solo "linea N" → 1 miss
2. **#35** shift_window_v2 troppo strict, verbo "sposta il turno X" non matchata → 1 miss
3. **#36** confidence drop su alias miss troppo aggressiva (`linea 99` → 0.3 invece di 0.5+ GRAY) → 1 miss

### Latency
- Min: 7ms
- Max: 13ms
- **Avg: 8ms**
- vs Opus 4.7 translator: ~3000ms (375× più veloce)

### Cost tracking

| Item | Value |
|---|---|
| Extractor calls (30 chiamate) | $0.003 (compute only) |
| Opus fallback estimated (11 MISS) | $4.95 |
| Wave 16.2 total cost (30 calls) | **$4.95** |
| Wave 16.1 baseline (Opus-all) | $13.50 |
| **Savings** | **$8.55 (-63%)** |

Note: -63% < target -69% perché ho 3 wrong-cases sovra-classificati come MISS. Se #34-#36 fixati: cost = $3.60 → **-73%**.

---

## 3. MCP live UI test (Chrome MCP)

### Verifiche positive

| Wave fix | Verificato? | Note |
|---|---|---|
| Wave 15.1 W15-04 OptimizationLoader label | ✅ | "Costo backend: $0.01291" visibile (era "BFF · Costi LLM") |
| Wave 15.1 W15-05 copy "Opus 4.7" → "il sistema AI" | ✅ | What-If: "Il sistema AI analizza impatti..." + Sotto-commesse: "il sistema AI propone..." |
| KPI dashboard | ✅ | Makespan 3.8 giorni / Ritardo 303 min / On-time 100% / Costo €1.240 |
| Solve template_solve | ✅ | Status FEASIBLE objective 8131186, ~25s |
| Backend connesso badge | ✅ | green dot |

### Bug trovati live (2 nuovi, tracciabili)

#### 🚨 #37 — explain/advise auto-fire 503 → 200 retry ma UI resta in error
**Sintomo**: dopo solve, "Spiegazione AI" e "Consigli AI" mostrano "Servizio AI temporaneamente non disponibile. Riprova fra qualche minuto."
**Network**: `/api/explain` PRIMA 503, poi 200 al retry. `/api/advise` stesso. Ma UI rimane in error state.
**Possibili cause**: (a) UI non consuma il response 200 successivo perché error state già settato, (b) timeout race, (c) rate-limit interceptor cache.
**Fix**: verificare error handling in ExplanationPanel.tsx + AdvisorPanel.tsx — il retry success deve resettare error state.

#### 🚨 #38 — `.env.local` manca `DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL=1`
**Root cause**: `.dev.vars` ha `BYPASS_LOCAL=1` ma `.env.local` NO. Dotenv-cli Wave 15.1 W15-02 carica solo `.env.local`, quindi rate-limit 10/h è attivo in dev.
**Sintomo**: dopo poche chiamate (explain + advise + whatif + apply-whatif insieme = 4+) il manager vede "Servizio AI temporaneamente non disponibile" per le successive ~1h.
**Impact UX**: workflow manager bloccato dopo ~10 click.
**Fix immediato**: aggiungere `DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL=1` a `.env.local` (già fatto durante test).
**Fix permanente**: alzare default LIMIT a 100/h in production O documentare BYPASS in README.

---

## 4. Cosa NON è stato testato live

- **Wave 16.2 BFF integration end-to-end** (HIT/GRAY/MISS via UI): il rate-limit ha interrotto il test prima del What-If "Esegui ottimizzazione con questo vincolo". Tuttavia il BFF→backend extractor è coperto da unit test 5/5 PASS + stress test backend 27/30 correct + il backend è confermato funzionante via curl diretto.
- **WhatIfConfirmationModal GRAY_ZONE flow**: non testato live ma 5/5 unit test PASS.
- **Cost telemetry in produzione**: tracker `onUsage()` chiamato anche su HIT (Wave 16.2 fix `13063ca`) ma non verificato visivamente nel cost dashboard.

Tutti coperti dal task #19 (e2e smoke pre-pilot).

---

## 5. Recommendation

**Wave 16.2 è merge-clean e funzionante a livello unit + integration**, ma:
- **Fix Wave 16.3 imminente raccomandato** prima di pilot cliente B2B
- **Task #38 rate-limit BYPASS** è il fix più urgente (UX-blocker)
- **Task #34-#36 pattern accuracy** (+9% atteso → 99%) per massimizzare cost saving
- **Task #19 e2e smoke test** dopo i fix sopra

Total Wave 16.3 effort stimato: ~2-3 ore lavoro per chiudere #34-#38 + run e2e smoke.

---

## 6. File modificati durante test

- `.env.local`: aggiunto `DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL=1` (fix immediato #38)
- `/tmp/stress-eval-extract.sh`: NEW script di stress + eval (riusabile per future wave)
- `docs/wave-16.2-test-report.md`: questo file
