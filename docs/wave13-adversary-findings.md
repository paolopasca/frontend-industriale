# Wave 13 — Devil's Advocate Findings

**Reviewer**: w13-devils-advocate (Opus)
**Policy**: ADR-099.7 — continuous post-DONE review (NOT real-time during edits)
**Status**: WAITING — all 4 tasks T1-T4 still `in_progress`

---

## Baseline analysis (pre-fix, anchoring for future review)

Before any teammate finishes, here is the architectural state I've verified by reading the code. These are the load-bearing invariants I will compare each fix against.

### T1 — F-W11-LIVE-03 status mismatch (root cause hypothesis)

**Verified via code read**:

1. Backend `POST /api/public/solve-template` (daino/api/routes_optimize.py:2118-2175) returns:
   ```python
   {
     "status": result.get("status", "UNKNOWN"),  # ROOT-LEVEL status
     "solution": result.get("solution", {}),     # INNER per-job dict, NO status inside
     "kpis": ...,
     "warnings": [...],
     ...
   }
   ```
   The root `status` is FEASIBLE/OPTIMAL. The inner `solution` dict has no `status` key.

2. Frontend `extractAiInputs` (src/routes/index.tsx:47-64) extracts ONLY the inner solution dict:
   ```typescript
   if (r.solution !== undefined) {
     return { solution: r.solution, kpis: toNumberMap(k) };
   }
   ```
   It drops the root `status` field.

3. Frontend BFF endpoints (explainer.ts:84, manager-chat-tools.ts:143-146) read status from `solution['status']`:
   ```typescript
   const status = normalizeStatus(solution['status']);  // explainer.ts
   const status = asString(statusContainer['status'] ?? root['status'], ...).toUpperCase();
   ```
   For manager-chat-tools, the fallback `fasi.length > 0 ? 'FEASIBLE' : 'UNKNOWN'` would actually mask this if `fasi` are non-empty — so the chat tool might already work via fallback. But the explainer has NO fallback → returns UNKNOWN.

**Most likely fix locations**:
- Cleanest: change `extractAiInputs` to wrap `{ status, ...inner }` into the solution it sends to BFF.
- OR: send `status` as a separate field in the explain/advise/manager-chat body, parallel to `solution`.
- OR: have BFFs accept the full backend response, not pre-extracted.

**Devil's question if w13-status-fix touches `solution_validator.py`**:
- Validator already had F-W10-05 fix (ADR-100.1) to emit F06 violations for unknown operators. If the new fix relaxes the violation emission to keep FEASIBLE status, F-W10-05 regresses → systemic constraint laundering returns. This is the Wave 11 incident pattern. The validator's job is to DOWNGRADE feasible solutions when hard constraints are violated. The fix must NOT change that.

**Devil's question on chat fallback** (manager-chat-tools.ts:146):
```typescript
fasi.length > 0 ? 'FEASIBLE' : 'UNKNOWN'
```
This fallback already saves the chat. So the symptom "Chat returns fallback 'non ho una pianificazione attiva'" is plausibly NOT due to status alone (since fasi would be non-empty when chat receives a real solution). MAY be that fasi extraction also fails. To verify: when w13-status-fix is DONE, test the chat with a working backend solve and see if chat actually uses tools or falls back. If chat still falls back even after status fix, root cause is elsewhere.

**Devil's question on UNKNOWN as legit value**:
- If the solver actually returns UNKNOWN (time_limit reached, no incumbent), the explanation/chat SHOULD say "UNKNOWN" honestly. The fix must distinguish "lost in translation" from "actually unknown". A blanket `status = 'FEASIBLE'` fallback whenever fasi exist would mask real unknown states.

### T2 — friendly error messages (architectural risk)

**Verified**:
- `src/components/dashboard/unsupported-reason-labels.ts` is the existing humanizer (Wave 10 F-W10-02). T2 will likely create a parallel `streamingFetch.ts:friendlyErrorMessage()` for SSE errors.
- T2 must NOT silently swallow useful debug info. Mapping `invalid_body` → "Richiesta non valida, ricarica pagina" hides what field validation failed. Fine for end-user but devs see raw error in DevTools/network only.

**Devil's questions**:
1. **Dict coverage**: T2 description says "extend mapping to cover all error codes". Hard to enumerate exhaustively. Strategy: fall-through to raw string when no mapping match (mirrors `humanizeUnsupportedReason` line 36 — return trimmed raw). Verify T2 implements this fall-through, NOT a silent "Errore sconosciuto" generic message.
2. **Network error tier confusion**: 503/504 (network unreachable), 4xx (client/validation), SSE `error` event with structured payload — these arrive through different code paths. T2 must handle them all in the right place.
3. **Multi-lingua future**: Italian-only is OK per project scope, but flag for future i18n. Trackable.
4. **Coordination with T4**: both touch `unsupported-reason-labels.ts`. Risk of merge conflict if not coordinated. The Task description acknowledges this — verify the two teammates don't drift.

### T3 — UX polish

**Verified**:
- `OptimizationLoader.tsx:337` already says "è pronto" with accent in current code. EITHER (a) the loader was already fixed in some prior commit, OR (b) the symptom screenshot is older than current main. Verify w13-ux-polish actually finds the diff to fix. If no diff exists for "e pronto" they may incorrectly mark it done.
- ManagerChatPanel uses fixed-position floating button (line ~217 area). z-index conflicts with ReplanModal (line 156 of index.tsx) and DataInputModal need verification.

**Devil's questions**:
1. **z-index war**: Chat panel must be BELOW modals (so Replan and DataInput overlay it correctly), but ABOVE Gantt/main content. Verify the value picked doesn't break the modal stack.
2. **Status badge for UNKNOWN**: A new "warning yellow" badge for UNKNOWN. If `low_confidence_classification` ALSO uses yellow, the manager won't know whether it's solver state or AI uncertainty. Need distinct visual treatment.
3. **OrdersTable placeholder "—"**: Verify the chosen placeholder doesn't break existing CSV export (if any) — em dash in a CSV field can confuse parsers. Best to use empty string in data, "—" only in render.
4. **CSS @import order**: This is a real warning. Browsers are strict about @import being first. Verify fix doesn't break existing styles by reordering import after critical base styles.

### T4 — warning mapper

**Verified**:
- Existing `unsupported-reason-labels.ts` is a flat Record<string,string>. Extending it with `data_modifier_no_implementation:*` is a string prefix concept. The humanizer at line 33 uses `trimmed.split(':')[0]` so `data_modifier_no_implementation:machine_unavailability` → key lookup on `data_modifier_no_implementation`. This pattern works.

**Devil's questions**:
1. **Coverage scope**: Task says "all warnings Wave 7-11". Hard to enumerate. Risk: T4 maps the obvious 5-10 but misses the long tail. Fall-through to raw must be preserved.
2. **Conflict with T2**: Same file. Coordination explicit in tasks. Verify final commit has both extensions and no overwrites.
3. **SolutionDiff renders warnings already**: Check current renderer to ensure T4 isn't adding a duplicate display path while leaving the raw path active somewhere else.
4. **Italian copy in `data_modifier_no_implementation` mapping**: "Strategia ottimale parziale — fallback applicato" is OK for manager, but hides what fallback was applied. The Strategy B (rule_addition) is itself a real solution. Manager might want to know which strategy was used, not just "fallback". Tradeoff: brevity vs transparency.

---

## Findings will be added below as tasks complete

Format:
```
### F-W13-XX [SEVERITY]: Title
Status: OPEN | CONFIRMED | FALSE_ALARM | RESOLVED
Task: T<N>
Evidence: file:line + reproducer
Risk: ...
Recommendation: ...
```

No CRITICAL/HIGH findings yet — all 4 tasks still mid-implementation. Will review post-DONE.
