import { describe, it, expect } from 'vitest';
import {
  humanizeUnsupportedReason,
  UNSUPPORTED_REASON_LABELS,
} from '../unsupported-reason-labels';

/**
 * F-W10-02 — verify the BFF/router structured reason codes get mapped to
 * friendly Italian copy before they reach the manager's toast.
 *
 * Pre-fix the toast surfaced raw debug strings like
 * `invalid_extra_capacity_count:operators_must_be_positive_integer:got=0`,
 * which looked like an unhandled error to the user.
 */

describe('humanizeUnsupportedReason — F-W10-02', () => {
  it('maps invalid_extra_capacity_count to Italian copy', () => {
    const raw = 'invalid_extra_capacity_count:operators_must_be_positive_integer:got=0';
    const out = humanizeUnsupportedReason(raw);
    expect(out).toBe(UNSUPPORTED_REASON_LABELS.invalid_extra_capacity_count);
    expect(out).not.toContain(':');
    expect(out).not.toContain('got=');
  });

  it('maps missing_required_entity reasons', () => {
    expect(humanizeUnsupportedReason('missing_required_entity:order_id')).toBe(
      UNSUPPORTED_REASON_LABELS.missing_required_entity,
    );
  });

  it('maps entity_validation_failed reasons', () => {
    expect(humanizeUnsupportedReason('entity_validation_failed:start_min:not_a_positive_int')).toBe(
      UNSUPPORTED_REASON_LABELS.entity_validation_failed,
    );
  });

  it('maps intent_id_not_in_catalog reasons', () => {
    expect(humanizeUnsupportedReason('intent_id_not_in_catalog:something_new')).toBe(
      UNSUPPORTED_REASON_LABELS.intent_id_not_in_catalog,
    );
  });

  it('maps no_strategy_available reasons', () => {
    expect(humanizeUnsupportedReason('no_strategy_available:rule_addition')).toBe(
      UNSUPPORTED_REASON_LABELS.no_strategy_available,
    );
  });

  it('passes through verbatim Italian sentences (Wave 8 not_implemented copy)', () => {
    const italian =
      "Scenario riconosciuto ma non ancora supportato: il backend non implementa "
      + 'questa modifica nel modello CP-SAT. Riprova con un vincolo del catalogo gia attivo.';
    expect(humanizeUnsupportedReason(italian)).toBe(italian);
  });

  it('falls back to the raw string when the prefix is unknown', () => {
    const raw = 'never_seen_before_code:detail';
    expect(humanizeUnsupportedReason(raw)).toBe(raw);
  });

  it('returns a placeholder for empty/null/undefined input', () => {
    expect(humanizeUnsupportedReason(undefined)).toBe('motivo non specificato.');
    expect(humanizeUnsupportedReason(null)).toBe('motivo non specificato.');
    expect(humanizeUnsupportedReason('')).toBe('motivo non specificato.');
    expect(humanizeUnsupportedReason('   ')).toBe('motivo non specificato.');
  });

  it('treats the bare "unsupported" sentinel as a friendly message', () => {
    expect(humanizeUnsupportedReason('unsupported')).toBe(UNSUPPORTED_REASON_LABELS.unsupported);
  });
});
