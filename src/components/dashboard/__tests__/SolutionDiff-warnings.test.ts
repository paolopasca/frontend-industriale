/**
 * F-W11-LIVE-05 — verify SolutionDiff drops BFF strategy-router routing
 * detail markers from the user-facing "Avvertenze" list while leaving
 * genuine warnings, missing_kpi entries, and the soft-relax markers
 * untouched.
 *
 * The BFF still emits these markers so logs and integration tests can
 * still assert on them; this layer is purely the UI filter.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeWarnings } from '../SolutionDiff';

describe('sanitizeWarnings — F-W11-LIVE-05 routing-detail filter', () => {
  it('drops data_modifier_no_implementation:<intent> from user-facing warnings', () => {
    const out = sanitizeWarnings([
      'data_modifier_no_implementation:machine_unavailability',
    ]);
    expect(out.warnings).toEqual([]);
    expect(out.missingKpis).toEqual([]);
  });

  it('drops data_modifier_rejected:<intent> from user-facing warnings', () => {
    const out = sanitizeWarnings([
      'data_modifier_rejected:machine_unavailability',
    ]);
    expect(out.warnings).toEqual([]);
  });

  it('drops the exact strategy-fallback markers emitted by apply-whatif', () => {
    const out = sanitizeWarnings([
      'data_modifier_rejected_post_route',
      'strategy_a_via_rule_fallback',
    ]);
    expect(out.warnings).toEqual([]);
  });

  it('keeps genuine warnings untouched', () => {
    const out = sanitizeWarnings([
      'data_modifier_no_implementation:machine_unavailability',
      'something_unexpected_to_check_with_manager',
    ]);
    expect(out.warnings).toEqual(['something_unexpected_to_check_with_manager']);
  });

  it('still extracts missing_kpi entries even when routing markers are present', () => {
    const out = sanitizeWarnings([
      'data_modifier_no_implementation:deadline_change',
      'missing_kpi:makespan_min',
    ]);
    expect(out.warnings).toEqual([]);
    expect(out.missingKpis).toEqual(['makespan_min']);
  });

  it('still recognises the soft-relax markers when mixed with routing detail', () => {
    const out = sanitizeWarnings([
      'data_modifier_no_implementation:machine_unavailability',
      'lock_relaxed_to_soft',
    ]);
    expect(out.warnings).toEqual([]);
    expect(out.lockRelaxedFromWarning).toBe(true);
  });
});
