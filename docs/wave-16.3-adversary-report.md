# Wave 16.3 — Adversary Report (final, post-reboot)

> Devil-advocate read-only review. 2026-05-26. 7 commit Wave 16.3 + 1 e2e file. Severity bands + verdetto. Eseguito su backend `feat/wave-16.3-extractor-tuning` (commit 4fe8c2a) e frontend `feat/wave-16.3-fixes` (commit e5856d7).

## Verdetto finale: **FIX-THEN-MERGE**

Wave 16.3 raggiunge gli obiettivi numerici dichiarati (30/30 stress, -73% cost, 7ms latency) e i 3 fix BE risolvono regressioni reali del Wave 16.2. **Tuttavia, fix #36 introduce un percorso "silent no-op" critico** (la stessa classe di bug F-W10-01 che ha già morso il team), e il fix #38 rate-limit ha un rischio di esposizione produzione se `NODE_ENV` non è configurato esplicitamente sul deployment Cloudflare Workers.

Raccomando: fix CRITICAL-1 (silent no-op fix #36) e HIGH-1 (NODE_ENV default) PRIMA del merge. Tutti gli altri findings sono follow-up Wave 16.4 accettabili.

## Validation re-run

- **pytest** (`tests/test_constraint_extractor.py tests/test_routes_internal.py tests/test_constraint_extractor_contract.py`): **83/83 passed** in 1.14s. Conferma scope dichiarata in brief.
- **vitest server** (`src/server/llm/__tests__/bff-extract-constraint.test.ts`): **7/7 passed**. Conferma scope dichiarata in brief.
- **vitest server SUITE COMPLETA** (`npx vitest run --config vitest.server.config.ts`): **142/150 passed, 1 failed** (`apply-whatif-low-confidence.test.ts > F-W8-07 — confidence=low on unknown intent_id ...`) — pre-esistente, già rosso al baseline 5d38182 Wave 16.2. NON regressione di Wave 16.3.
- **vitest client** (`npx vitest run --config vitest.config.ts`): **118/118 passed**. Include i 23 nuovi test di fix #37 (9 ExplanationPanel + 9 AdvisorPanel + 5 streamingFetch).
- **stress eval** (`bash /tmp/stress-eval-extract.sh`): **30/30 correct**, latency avg 7ms, total cost stimato $3.60 vs $13.50 baseline (-73%). Numeri reali, riprodotti live.

## CRITICAL

### CRITICAL-1 — Fix #36 percorso silent no-op end-to-end (commit 4fe8c2a)

**Lente**: edge cases / contract drift / test gaming
**File**:
- `daino-backend-definitivo/daino/arm_c/constraint_extractor.py:399-433` (handler)
- `daino-backend-definitivo/daino/api/routes_internal.py:121-213` (`_build_confirmation_message`)
- `frontend-industriale/src/server/llm/constraint-translator.ts:794-813` (`mapBackendPayloadToConstraintChange`, no validation)
- `frontend-industriale/src/components/dashboard/WhatIfConfirmationModal.tsx` (nessun input field per disambiguare il target)
- `frontend-industriale/src/routes/api/apply-whatif.ts:597-599` (route accetta confirmedPayload senza unwrap del sentinel `"?"`)
- `daino-backend-definitivo/daino/templates/fjsp_constraints/f_apply_rules.py:131-168` (`_apply_unavailable_machines` log+skip su `"?"`)

**Repro live confermata**:
```
curl -X POST .../extract-constraint -d '{"instruction":"Ferma la linea 99 dalle 14 alle 18", "solution_context":{...}}'
→ result=gray_zone confidence=0.70 pattern_id=machine_unavail_v1
  payload={"unavailable_machines":{"?":[{"start_min":840,"end_min":1080,"raw_target":"linea 99"}]}}
  confirmation_message="Sto leggendo la richiesta ma con qualche incertezza (confidence 0.70). Confermi?"
```

**Sequenza bug**:
1. Backend ritorna GRAY con `unavailable_machines: {"?": [...]}` (sentinel-key).
2. `_build_confirmation_message` non ha branch per `pid == "machine_unavail_v1"` → fallback generico "Sto leggendo la richiesta ma con qualche incertezza (confidence 0.70). Confermi?".
3. BFF `mapBackendPayloadToConstraintChange` mappa a `type='block_machine'` e usa il payload tale-e-quale. **NON chiama `validateRulesByType`**.
4. BFF emette `requires_confirmation` con `confirmedPayload = {unavailable_machines: {"?": [...]}}`.
5. UI mostra modal con messaggio generico. **Nessun input field** — manager non può specificare "quale linea". Solo "Annulla / Riformula con AI / Conferma e applica".
6. Se manager clicca "Conferma e applica" (CTA primaria verde), UI re-invia `userConfirmedGrayZone=true + confirmedPayload={unavailable_machines:{"?":[...]}}`.
7. Route `apply-whatif.ts:597-599` setta `rulesForSolve = input.confirmedPayload` senza unwrap.
8. Solver chiama `_apply_unavailable_machines` con `{"?": [...]}` → log warning "unknown machine_id=`'?'` — skipped". Vincolo NON applicato.
9. Solver completa con KPI INVARIATI. UI mostra `solved` + SolutionDiff vuoto.
10. **Manager crede di aver applicato un fermo macchina; non è successo nulla.**

**Test gaming**:
- Backend test `test_gray_unresolved_target_with_valid_time` asserisce solo la SHAPE del payload, MAI il comportamento end-to-end.
- `test_routes_internal.py` testa confirmation_message solo per `machine_unavail_v2`, non per il nuovo flow v1 di fix #36.
- BFF `bff-extract-constraint.test.ts` testa solo payload pulito, non sentinel `"?"`.
- e2e `wave-16.3-smoke.spec.ts:404+` testa GRAY con "Anticipa COM-001" (deadline_change_v3), non asserisce mai contenuto di `confirmedPayload`.

**Recall**: classe di bug F-W10-01 (BFF silent no-op senza flag espliciti) tracciata in `feedback_test_realistic_caller_shape.md`.

**Severity**: CRITICAL — manager pensa di aver applicato un vincolo che non viene applicato. In contesti regolamentati, un'azione "confermata" ma silenziosamente droppata è peggio di un errore visibile.

**Fix proposto (minimo, defense-in-depth)**:
- Backend: `_build_confirmation_message` aggiungere branch per `machine_unavail_v1 + sentinel "?"` con messaggio esplicito.
- BFF: route `apply-whatif.ts` rifiuta `confirmedPayload.unavailable_machines["?"]` con `aborted_unsupported`.
- Test: e2e "Ferma la linea 99" + Conferma → assert stato terminale ≠ `done` con KPI invariati.

## HIGH

### HIGH-1 — Rate-limit bypass produzione dipende da `NODE_ENV='production'` non garantito (commit 256ce3b)

**Lente**: security
**File**: `frontend-industriale/src/server/llm/client.ts:49-63`

```ts
function shouldBypassRateLimit(ipOrCompositeKey: string): boolean {
  if (process.env.DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL === '0') return false;
  if (process.env.NODE_ENV === 'production') return false;
  void ipOrCompositeKey;
  return true;  // ← bypass per tutti gli IP se NODE_ENV !== 'production'
}
```

**Sequenza bug ipotetica**:
1. Team deploya su Cloudflare Workers: `wrangler deploy`.
2. `wrangler.jsonc` non setta `NODE_ENV` (verificato: nessuna ricorrenza nel file).
3. Cloudflare Workers runtime non setta `process.env.NODE_ENV='production'` di default.
4. In produzione `process.env.NODE_ENV === undefined`. Check fallisce → bypass attivo.
5. Tutti gli endpoint senza rate-limit di fatto.
6. Attaccante o bug client → spam unbounded → fattura Anthropic runaway.

**Differenza con baseline pre-Wave 16.3**: la vecchia funzione filtrava prima sull'IP (`local/127.0.0.1/::1` only). La nuova rimuove quel filtro, lasciando `NODE_ENV` come unica linea di difesa.

**Severity**: HIGH — non sfruttabile da remoto subito ma una svista config produce esposizione finanziaria immediata.

**Fix proposto**:
- Invertire default: `return process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test'` (esplicito allow-list).
- Assertion al boot: warn se NODE_ENV undefined.
- `wrangler.jsonc`: aggiungere `[vars] NODE_ENV = "production"`.
- Unit test con `NODE_ENV = undefined` → assert no bypass.

### HIGH-2 — Doc drift fix #34: "linea M-3" dichiarato match, in realtà MISS

**File**: `daino-backend-definitivo/daino/arm_c/constraint_extractor.py:235-238`

Commento dice che "linea M-3" è gestito, in realtà va in MISS. Phrasing plausibile in italiano colloquiale → fallback Opus $0.45.

**Fix proposto**: aggiornare commento O estendere pattern per coprire "linea M-N".

## MEDIUM

### MEDIUM-1 — Fix #36 alias-miss penalty produce GRAY anche per target generici

Test live:
```
"Ferma macchina dalle 14 alle 18" → GRAY 0.70, raw_target="macchina"
"Ferma forno dalle 14 alle 18" → GRAY 0.70, raw_target="forno"
```

**Fix proposto**: void-targets set in `_handle_machine_unavail_v1`: `{"macchina","linea","forno","il","la"}` → MISS.

### MEDIUM-2 — Test "Riformula con AI hidden by default" commento errato

**File**: `tests/e2e/wave-16.3-smoke.spec.ts:471`

Commento dice prop default false, ma caller reale passa true. Test non asserisce non-visibilità → fix: aggiungere `expect(button).toBeVisible()` o aggiornare commento.

### MEDIUM-3 — `_build_confirmation_message` dispatcher pattern_id ↔ message disallineato

Già coperto da CRITICAL-1. Aggiungere test parametrico su tutti pattern_id GRAY.

### MEDIUM-4 — Fix #35 lookahead non copre unità "giorni"

```
"Sposta il turno notte di 3 giorni" → GRAY 0.60 payload={shift_changes:[{shift_id:"notte"}]}
```

V2 matcha ma payload droppato dal solver. Silent no-op.

**Fix proposto**: lookahead `(?!\s+di\s+\d+\s+(?:min|or|giorn))`.

### MEDIUM-5 — Stress eval cost stimato è bottom-up, non costo reale Opus

`$3.60 = $0.45 * 8 MISS + $0.0001 * 30` è stima a-priori. Latency 7ms è invece misurata real.

**Fix proposto**: doc clarification che `-73%` è stima bottom-up.

## LOW

### LOW-1 — ReDoS prudent ma non rigoroso

Edge case 10000 spazi → 307ms. Nessun max_length su `ExtractConstraintIn.instruction`.

**Fix proposto**: `max_length=2000` su instruction field.

### LOW-2 — Retry loop in ExplanationPanel non resetta `costUsd` tra attempt

Minor cosmetic.

### LOW-3 — Retry esegue `setText('')` ma non resetta scroll

Cosmetic.

## Verifiche positive

- **Time validation reorder fix #36**: bad-time + bad-target → MISS (corretto). Confermato live.
- **Negative lookahead fix #35**: v2 non shadowa v1 quando quantità presente. Confermato live.
- **`_apply_unavailable_machines` defense-in-depth**: sentinel `"?"` non crasha il solver (log+skip).
- **Retry loop bounded**: MAX_RETRIES=2, backoff ≤ 4s. No infinite loop. AbortController OK.
- **`isTransientPanelError` classifier**: 5xx/network = transient, 4xx/rate-limit = permanent. 5 unit test.
- **Compound detection regex fix #34**: "Ferma M-1 e M-2" → MISS (compound detected).
- **Stress eval 30/30 reale**: latency 7ms, output identico al brief.
- **Anticipa/posticipa direzione**: semantica italiana corretta.

## Raccomandazioni Wave 16.4

**Mandatorie prima del prossimo deploy**:
1. **Fix CRITICAL-1**: backend custom confirmation_message + BFF reject sentinel "?" in retry. E2e test scenario "Ferma la linea 99".
2. **Fix HIGH-1**: invertire default `shouldBypassRateLimit` + `wrangler.jsonc NODE_ENV`. Unit test undefined.

**Strongly recommended**:
3. MEDIUM-1: void-targets set in v1 handler.
4. MEDIUM-3: parametrizzare test confirmation_message su tutti pattern_id GRAY.
5. MEDIUM-4: lookahead esteso a "giorni".

**Tech debt opzionali**:
6. LOW-1: `max_length=2000` su instruction.
7. MEDIUM-2 + HIGH-2: aggiornare commenti.
8. MEDIUM-5: doc clarification cost stimato.
9. Fix pre-existing `apply-whatif-low-confidence.test.ts > F-W8-07`.
10. Rate-limit più alto su apply-whatif per pilot B2B (5/h restrittivo).

---

**Conclusione**: Wave 16.3 sblocca 3 regression reali del 16.2 e il refactor retry è solido. Ma il fix #36 ha riaperto la classe di bug F-W10-01 (silent no-op) e il fix #38 ha indebolito una difesa di sicurezza che dipendeva dal whitelist IP. Entrambi sono fix-then-merge, non block. Stimato 1 sessione (30-60 min) per chiudere CRITICAL-1 + HIGH-1.
