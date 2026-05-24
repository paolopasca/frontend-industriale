/**
 * F-W10-02 — friendly Italian copy for `aborted_unsupported` payload.reason.
 *
 * The BFF/router emits structured reason codes like
 * `invalid_extra_capacity_count:operators_must_be_positive_integer:got=0`
 * or `entity_validation_failed:start_min:not_a_positive_int`. Mapping by the
 * first ':' segment lets us add new prefixes without re-coding consumers,
 * and we fall back to the raw string when nothing matches so debug info is
 * still surfaced for unknown reasons.
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
