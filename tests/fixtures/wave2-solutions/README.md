# Wave 2 — LLM fixture set

5 fixture JSON per test deterministico Explainer + Advisor (no-hallucination, edge case, stress).

| File | Status | Purpose |
|------|--------|---------|
| `optimal.json` | OPTIMAL | Happy path. 4 fasi, KPI completi. Explainer/Advisor devono celebrate + 1 attention point (machine_util 92%). |
| `feasible-warning.json` | FEASIBLE | Warning attivo (COM-007 in ritardo 120min, M-3 al 95%). Explainer deve indicare "fattibile ma non ottima"; Advisor priorizza ⚠️ riassegnazione COM-007. |
| `infeasible.json` | INFEASIBLE | Capacità M-3 insufficiente. Explainer spiega in 2-3 frasi la causa; Advisor propone vincoli da rilassare (NO actionable on plan). |
| `empty.json` | OPTIMAL ma fasi=[] | Solver girato ma nessuna commessa pianificata. Explainer = templated "Nessuna commessa pianificabile..."; Advisor = solo 📋 verifiche manuali sui dati. |
| `malformed.json` | string-typed `solution` | Solution non-object. Explainer = templated "Pianificazione non disponibile: dati non leggibili"; Advisor = templated verifiche. |

## Uso negli script

```bash
for f in tests/fixtures/wave2-solutions/{optimal,feasible-warning,infeasible,empty,malformed}.json; do
  echo "=== $f ==="
  curl -s -N -X POST http://localhost:8080/api/explain \
    -H 'Content-Type: application/json' \
    --data @"$f"
  echo
done
```

## Cosa il no-hallucination test verifica

Per ognuna delle 5 fixture × 2 endpoint × 2 ripetizioni (20 chiamate totali):

1. Estrai TUTTI i numeri dall'output LLM (regex `\d+([.,]\d+)?`).
2. Per ogni numero, verifica che esista (esattamente o come ratio normalizzato es. 0.95→95%) nel fixture input (KPI o `solution`).
3. Tolleranza: numeri derivati banali (es. 100−95=5%) sono accettabili; nuove costanti (es. "investimento di 50K€") sono **hallucination**.

Soglia di PASS: ≥95% dei numeri citati verificabili. <90% = FAIL.

## Cosa l'edge-case test verifica

| Fixture | Atteso Explainer | Atteso Advisor |
|---------|-------------------|-----------------|
| optimal | ✅ apertura + numeri da KPI | ≥1 ✅ conferma + 1 monitor 📋 |
| feasible-warning | "FEASIBLE/fattibile/non ottima" parola presente | ≥1 ⚠️ critica con citation del ritardo |
| infeasible | "non possibile" o "vincoli" parola presente, NO action | 3-5 ⚠️ o 📋, vincoli da rilassare, NO operations su plan |
| empty | templated string "Nessuna commessa pianificabile" | tutto 📋 verifiche sui dati |
| malformed | templated string "Pianificazione non disponibile" | tutto 📋 verifiche |

Nessuna fixture deve far crashare il BFF (status 200 sempre, oppure 4xx coerente per malformed).
