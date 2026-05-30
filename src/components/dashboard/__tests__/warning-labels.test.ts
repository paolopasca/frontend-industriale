/**
 * F-W11-LIVE-05 (Wave 13 T4) — verify `humanizeWarning` maps every Wave 7-11
 * technical warning string emitted by the BFF strategy-router /
 * constraint-translator / apply-whatif pipeline to a manager-readable
 * Italian sentence.
 *
 * The dict-based mapper has three lookup tiers (exact match → first-`:`
 * prefix match → generic fallback) plus a verbatim-Italian-sentence
 * passthrough; each tier is covered below.
 */
import { describe, it, expect } from 'vitest';
import { humanizeWarning } from '../unsupported-reason-labels';

describe('humanizeWarning — Wave 7-11 warning mapping', () => {
  describe('exact match warnings', () => {
    it('maps low_confidence_classification', () => {
      expect(humanizeWarning('low_confidence_classification')).toBe(
        'AI poco sicura della classificazione — verifica risultato',
      );
    });

    it('maps lock_relaxed_to_soft', () => {
      expect(humanizeWarning('lock_relaxed_to_soft')).toBe(
        'Vincolo troppo restrittivo, lock di produzione rilassato',
      );
    });

    it('maps lock_relaxed_to_soft__consolidated_preserved_as_hint', () => {
      expect(humanizeWarning('lock_relaxed_to_soft__consolidated_preserved_as_hint')).toBe(
        'Vincolo troppo restrittivo, fasi consolidate preservate come preferenza',
      );
    });

    it('maps lock_relaxed_to_soft__plan_recomputed_from_scratch', () => {
      expect(humanizeWarning('lock_relaxed_to_soft__plan_recomputed_from_scratch')).toBe(
        'Vincolo impossibile col lock duro, piano ricalcolato da zero',
      );
    });

    it('maps prompt_injection_detected', () => {
      expect(humanizeWarning('prompt_injection_detected')).toBe(
        'Testo sospetto rilevato nella richiesta — vincolo non applicato',
      );
    });

    it('maps haiku_unknown_high_no_cascade as defensive fallback', () => {
      // Normally filtered before reaching the user, but if it leaks through
      // we still want a readable copy.
      expect(humanizeWarning('haiku_unknown_high_no_cascade')).toBe(
        'Richiesta fuori dal catalogo, nessuna interpretazione possibile',
      );
    });

    it('maps data_modifier_rejected_post_route', () => {
      expect(humanizeWarning('data_modifier_rejected_post_route')).toBe(
        'Strategia ottimale parziale — fallback B applicato',
      );
    });

    it('maps strategy_a_via_rule_fallback', () => {
      expect(humanizeWarning('strategy_a_via_rule_fallback')).toBe(
        'Strategia ottimale parziale — fallback B applicato',
      );
    });
  });

  describe('prefix-matched warnings', () => {
    it('maps data_modifier_no_implementation:<intent_id>', () => {
      expect(
        humanizeWarning('data_modifier_no_implementation:machine_unavailability'),
      ).toBe('Strategia ottimale parziale — fallback B applicato');
      // Same copy for any other intent — prefix-only match.
      expect(humanizeWarning('data_modifier_no_implementation:order_priority')).toBe(
        'Strategia ottimale parziale — fallback B applicato',
      );
    });

    it('maps data_modifier_rejected:<intent_id>', () => {
      expect(humanizeWarning('data_modifier_rejected:deadline_change')).toBe(
        'Strategia ottimale parziale — fallback B applicato',
      );
    });

    it('maps default_applied:<entity>=horizon_end(...)', () => {
      expect(humanizeWarning('default_applied:end_min=horizon_end(28800)')).toBe(
        'Valore mancante, applicato default automatico',
      );
    });

    it('maps canonicalised:<entity>:<raw>-><canon>', () => {
      expect(humanizeWarning('canonicalised:machine_id:M2->M02')).toBe(
        'Identificativo riconosciuto con normalizzazione automatica',
      );
    });

    it('maps not_implemented:<intent_id>', () => {
      expect(humanizeWarning('not_implemented:custom_intent_xyz')).toBe(
        'Scenario riconosciuto ma non ancora supportato dal backend',
      );
    });

    it('maps route_reason:<reason>', () => {
      expect(humanizeWarning('route_reason:fallback_to_opus')).toBe(
        'Routing alternativo applicato',
      );
    });

    it('maps unknown_machine:<id>', () => {
      expect(humanizeWarning('unknown_machine:M-99')).toBe(
        'Macchina non riconosciuta nel piano corrente',
      );
    });

    it('maps unknown_order:<id>', () => {
      expect(humanizeWarning('unknown_order:ORD-ABC')).toBe(
        'Commessa non riconosciuta nel piano corrente',
      );
    });

    it('maps schema_mismatch:<field>', () => {
      expect(humanizeWarning('schema_mismatch:extra_capacity.operators')).toBe(
        'Errore di formato nei dati generati — contatta supporto se persiste',
      );
      expect(humanizeWarning('schema_mismatch:unavailable_machines')).toBe(
        'Errore di formato nei dati generati — contatta supporto se persiste',
      );
    });

    it('maps missing_required_entity:<field>', () => {
      expect(humanizeWarning('missing_required_entity:machine_id')).toBe(
        'Dato necessario mancante nella richiesta',
      );
    });

    it('maps entity_validation_failed:<field>:<reason>', () => {
      expect(humanizeWarning('entity_validation_failed:start_min:not_a_positive_int')).toBe(
        'Valore non valido nella richiesta',
      );
    });
  });

  describe('verbatim Italian sentence passthrough', () => {
    it('surfaces capitalised Italian sentences with no `:` token as-is', () => {
      const sentence =
        'Scenario riconosciuto ma non ancora supportato dal solver.';
      expect(humanizeWarning(sentence)).toBe(sentence);
    });

    it('surfaces capitalised Italian sentences with accented chars as-is', () => {
      const sentence = 'Èerror grammaticale ma rispetta la regola';
      expect(humanizeWarning(sentence)).toBe(sentence);
    });
  });

  describe('generic fallback', () => {
    it('never leaks raw snake_case for unknown warnings', () => {
      const out = humanizeWarning('some_brand_new_internal_marker:foo:bar');
      expect(out).not.toContain('snake_case');
      expect(out).not.toContain(':');
      expect(out).not.toContain('_');
      expect(out).toBe('Verifica il risultato — avvertenza tecnica del sistema');
    });

    it('returns generic fallback for null/undefined/empty', () => {
      expect(humanizeWarning(null)).toBe(
        'Verifica il risultato — avvertenza tecnica del sistema',
      );
      expect(humanizeWarning(undefined)).toBe(
        'Verifica il risultato — avvertenza tecnica del sistema',
      );
      expect(humanizeWarning('')).toBe(
        'Verifica il risultato — avvertenza tecnica del sistema',
      );
      expect(humanizeWarning('   ')).toBe(
        'Verifica il risultato — avvertenza tecnica del sistema',
      );
    });

    it('returns generic fallback for non-string inputs', () => {
      // Defensive — production calls always pass string, but the
      // function tolerates the wider type so a runtime surprise from
      // a malformed SSE payload still degrades gracefully.
      // @ts-expect-error intentional bad input
      expect(humanizeWarning(42)).toBe(
        'Verifica il risultato — avvertenza tecnica del sistema',
      );
      // @ts-expect-error intentional bad input
      expect(humanizeWarning({})).toBe(
        'Verifica il risultato — avvertenza tecnica del sistema',
      );
    });
  });
});
