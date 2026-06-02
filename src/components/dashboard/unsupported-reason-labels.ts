/**
 * F-W10-02 — friendly Italian copy for `aborted_unsupported` payload.reason.
 *
 * The BFF/router emits structured reason codes like
 * `invalid_extra_capacity_count:operators_must_be_positive_integer:got=0`
 * or `entity_validation_failed:start_min:not_a_positive_int`. Mapping by the
 * first ':' segment lets us add new prefixes without re-coding consumers,
 * and we fall back to the raw string when nothing matches so debug info is
 * still surfaced for unknown reasons.
 *
 * F-W11-LIVE-05 (Wave 13) — same pattern for `warnings[]` items reaching the
 * SolutionDiff "Avvertenze" banner. Errors and warnings live in the same
 * module because the prefix-mapping mechanic is identical, but they use
 * two distinct dicts so keys never collide accidentally (e.g. an error
 * `unsupported` label should not leak into the warnings list).
 */

export const UNSUPPORTED_REASON_LABELS: Record<string, string> = {
  invalid_extra_capacity_count:
    'Hai chiesto 0 o un numero negativo di operatori. Riprova con un numero positivo.',
  missing_required_entity:
    'Manca un dato necessario per applicare il vincolo. Riformula con piu dettagli.',
  entity_validation_failed:
    'Uno dei valori indicati non e valido. Riformula il vincolo.',
  intent_id_not_in_catalog:
    'Vincolo non ancora supportato. Prova un comando del catalogo (blocco macchina, priorita, deadline, capacita, turno).',
  no_strategy_available:
    'Non riesco ad applicare questo vincolo con le strategie disponibili.',
  // Wave 16.7 — the merged constraints have no feasible schedule (e.g. too many
  // machines/operators blocked at once). Tell the manager WHY + how to recover.
  infeasible_constraints:
    'I vincoli combinati non hanno una soluzione fattibile. Rimuovi un vincolo (es. una macchina ferma) e riprova.',
  // A degenerate solve returned an empty plan — was previously surfaced raw.
  empty_solution_after_solve:
    'Lo scenario non produce una pianificazione applicabile. Prova ad ammorbidire o rimuovere un vincolo.',
  unsupported: 'Scenario non applicabile.',
};

export function humanizeUnsupportedReason(reason: string | undefined | null): string {
  if (!reason || typeof reason !== 'string') return 'motivo non specificato.';
  const trimmed = reason.trim();
  if (!trimmed) return 'motivo non specificato.';
  // Reasons can be a verbatim Italian sentence (e.g. Wave 8 `not_implemented`
  // intents return a full sentence) — surface those as-is when they start
  // with a capital letter and contain no ':' code-token shape.
  if (!trimmed.includes(':') && /^[A-ZÀ-Ü]/.test(trimmed)) return trimmed;
  const prefix = trimmed.split(':')[0];
  const mapped = UNSUPPORTED_REASON_LABELS[prefix];
  if (mapped) return mapped;
  return trimmed;
}

/**
 * F-W11-LIVE-05 (Wave 13 T4) — friendly Italian copy for warnings that reach
 * the SolutionDiff "Avvertenze" banner. The BFF emits technical strings like
 * `data_modifier_no_implementation:machine_unavailability` or
 * `canonicalised:machine_id:M2->M02` — a manager has no way to read these.
 *
 * Mapping strategy:
 * - Exact match first (e.g. `low_confidence_classification`,
 *   `prompt_injection_detected`) — needed because some warnings are pure
 *   markers without a prefix.
 * - Then prefix match on the first `:` segment (same trick used for the
 *   reason labels), so all `schema_mismatch:*` variants collapse to one
 *   user copy without enumerating every sub-field.
 * - Verbatim Italian sentences (BFF emits these for `not_implemented`
 *   intent fallbacks) are surfaced as-is.
 * - Unknown markers fall back to a generic "verifica risultato" label so
 *   the manager never sees raw `snake_case:tokens`. The raw string is
 *   kept in the data-attr for debugging.
 *
 * NOTE: warnings classified as "internal" by SolutionDiff.sanitizeWarnings
 * (BFF routing detail like `data_modifier_no_implementation:*`,
 * `data_modifier_rejected:*`, `data_modifier_rejected_post_route`,
 * `strategy_a_via_rule_fallback`, `haiku_unknown_high_no_cascade`) are
 * dropped BEFORE reaching this mapper, so they need no entry here.
 * Mappings are kept anyway as a defensive fallback in case a future
 * change unguards the filter.
 */
export const WARNING_LABELS_EXACT: Record<string, string> = {
  // F-W8-07 — Haiku tagged the classification with confidence='low'. This
  // is also surfaced via a dedicated yellow banner above the warnings
  // list; the entry here is the fallback copy if the dedicated banner
  // gets disabled for any reason.
  low_confidence_classification:
    'AI poco sicura della classificazione — verifica risultato',
  // F-W11-LIVE-05 — defensive fallbacks; usually filtered out earlier.
  data_modifier_rejected_post_route:
    'Strategia ottimale parziale — fallback B applicato',
  strategy_a_via_rule_fallback:
    'Strategia ottimale parziale — fallback B applicato',
  haiku_unknown_high_no_cascade:
    'Richiesta fuori dal catalogo, nessuna interpretazione possibile',
  // F-W8-06 OPT 2 / Wave 9 OPT 1 — same defensive fallback. The dedicated
  // amber/red banners always take precedence.
  lock_relaxed_to_soft:
    'Vincolo troppo restrittivo, lock di produzione rilassato',
  lock_relaxed_to_soft__consolidated_preserved_as_hint:
    'Vincolo troppo restrittivo, fasi consolidate preservate come preferenza',
  lock_relaxed_to_soft__plan_recomputed_from_scratch:
    'Vincolo impossibile col lock duro, piano ricalcolato da zero',
  // constraint-translator may report this when it detects an injection
  // attempt in the manager utterance (e.g. "ignore previous instructions").
  prompt_injection_detected:
    'Testo sospetto rilevato nella richiesta — vincolo non applicato',
};

export const WARNING_LABELS_PREFIX: Record<string, string> = {
  // strategy-router cascade markers — kept as defensive fallback only,
  // SolutionDiff drops them before they reach this mapper.
  data_modifier_no_implementation:
    'Strategia ottimale parziale — fallback B applicato',
  data_modifier_rejected:
    'Strategia ottimale parziale — fallback B applicato',
  // strategy-router entity validation — applied default for a missing
  // optional entity (e.g. `end_min` defaulted to horizon_end).
  default_applied:
    'Valore mancante, applicato default automatico',
  // strategy-router canonicalisation — e.g. "M2" → "M02".
  canonicalised:
    'Identificativo riconosciuto con normalizzazione automatica',
  // catalog: intent recognised but backend not yet wired (the BFF should
  // short-circuit to unsupported, but the warning may still appear).
  not_implemented:
    'Scenario riconosciuto ma non ancora supportato dal backend',
  // routeIntent fallback path — internal routing detail.
  route_reason:
    'Routing alternativo applicato',
  // constraint-translator entity ID checks — the LLM referenced an ID
  // not present in the solution.
  unknown_machine:
    'Macchina non riconosciuta nel piano corrente',
  unknown_order:
    'Commessa non riconosciuta nel piano corrente',
  // constraint-translator schema validation — the rules payload built by
  // the LLM does not match the backend contract.
  schema_mismatch:
    'Errore di formato nei dati generati — contatta supporto se persiste',
  // Wave 7+ entity validation — the parsed entities did not pass the
  // catalog validators. Usually accompanied by an Opus translator
  // fallback so the user still gets a candidate plan.
  missing_required_entity:
    'Dato necessario mancante nella richiesta',
  entity_validation_failed:
    'Valore non valido nella richiesta',
};

const GENERIC_WARNING_FALLBACK = 'Verifica il risultato — avvertenza tecnica del sistema';

export function humanizeWarning(raw: string | undefined | null): string {
  if (!raw || typeof raw !== 'string') return GENERIC_WARNING_FALLBACK;
  const trimmed = raw.trim();
  if (!trimmed) return GENERIC_WARNING_FALLBACK;
  // Verbatim Italian sentence (capitalised, no `:` token) — surface as-is
  // (e.g. backend `not_implemented` reasons that already carry a sentence).
  if (!trimmed.includes(':') && /^[A-ZÀ-Ü]/.test(trimmed)) return trimmed;
  // Exact match wins (catches markers with no `:` like `low_confidence_classification`).
  const exact = WARNING_LABELS_EXACT[trimmed];
  if (exact) return exact;
  // Prefix match on the first `:` segment.
  const prefix = trimmed.split(':')[0];
  const prefixMapped = WARNING_LABELS_PREFIX[prefix];
  if (prefixMapped) return prefixMapped;
  // Unknown marker — never leak raw snake_case to the manager. The raw
  // string is intentionally NOT included in the message; callers that
  // need it for debugging should read the original `warnings[]` array.
  return GENERIC_WARNING_FALLBACK;
}
