import { describe, it, expect } from 'vitest';
import { deriveCurrentTimeMin, baselineStartMs } from '../ReplanModal';

/**
 * Wave 16.5 B1 (devil-advocate HIGH) — the fresh-solve ripianifica path must
 * derive "now" in baseline-relative minutes so /api/reschedule-fresh can
 * freeze already-elapsed phases. A plain "M1 è rotta" carries no temporal
 * phrase, so without currentTimeMin the BFF cutoff is undefined and the
 * solver reshuffles work already done this morning.
 *
 * baselineStartMs anchors on time_config (start_date + company_start_hour),
 * falling back to the earliest fase.start_datetime. deriveCurrentTimeMin
 * returns null (→ caller omits the field, BFF skips the freeze) rather than
 * silently sending 0, which would also mean "no lock".
 */

describe('baselineStartMs', () => {
  it('anchors on time_config.start_date + company_start_hour', () => {
    const baseline = {
      time_config: { start_date: '2026-06-01', company_start_hour: 6, day_length_min: 960 },
    };
    // Model-minute 0 == 06:00 local on 2026-06-01.
    expect(baselineStartMs(baseline)).toBe(Date.parse('2026-06-01T06:00:00'));
  });

  it('defaults company_start_hour to 00 when absent', () => {
    const baseline = { time_config: { start_date: '2026-06-01' } };
    expect(baselineStartMs(baseline)).toBe(Date.parse('2026-06-01T00:00:00'));
  });

  it('falls back to earliest fase.start_datetime (raw solution shape)', () => {
    const baseline = {
      solution: {
        'COM-001': {
          fasi: [
            { start_datetime: '2026-06-01T08:00:00', macchina: 'M-1' },
            { start_datetime: '2026-06-01T06:30:00', macchina: 'M-2' },
          ],
        },
        'COM-002': {
          fasi: [{ start_datetime: '2026-06-01T07:15:00', macchina: 'M-1' }],
        },
      },
    };
    expect(baselineStartMs(baseline)).toBe(Date.parse('2026-06-01T06:30:00'));
  });

  it('falls back to earliest fase.start_datetime (flat envelope shape)', () => {
    const baseline = {
      fasi: [
        { start_datetime: '2026-06-01T09:00:00' },
        { start_datetime: '2026-06-01T06:45:00' },
      ],
    };
    expect(baselineStartMs(baseline)).toBe(Date.parse('2026-06-01T06:45:00'));
  });

  it('prefers time_config over fasi when both present', () => {
    const baseline = {
      time_config: { start_date: '2026-06-01', company_start_hour: 6 },
      solution: { 'COM-001': { fasi: [{ start_datetime: '2026-06-01T08:00:00' }] } },
    };
    expect(baselineStartMs(baseline)).toBe(Date.parse('2026-06-01T06:00:00'));
  });

  it('returns null for malformed start_date', () => {
    expect(baselineStartMs({ time_config: { start_date: '01/06/2026' } })).toBeNull();
  });

  it('returns null when no anchor is derivable', () => {
    expect(baselineStartMs({ solution: { 'COM-001': { fasi: [{ macchina: 'M-1' }] } } })).toBeNull();
    expect(baselineStartMs(null)).toBeNull();
    expect(baselineStartMs('not an object')).toBeNull();
    expect(baselineStartMs({})).toBeNull();
  });
});

describe('deriveCurrentTimeMin', () => {
  const anchor = Date.parse('2026-06-01T06:00:00');
  const baseline = { time_config: { start_date: '2026-06-01', company_start_hour: 6 } };

  it('returns elapsed minutes from the baseline anchor', () => {
    // 5 hours after opening → 300 model-relative minutes.
    expect(deriveCurrentTimeMin(baseline, anchor + 300 * 60_000)).toBe(300);
  });

  it('rounds to the nearest minute', () => {
    expect(deriveCurrentTimeMin(baseline, anchor + 120 * 60_000 + 40_000)).toBe(121);
  });

  it('returns null at exactly the anchor (nothing has run yet)', () => {
    expect(deriveCurrentTimeMin(baseline, anchor)).toBeNull();
  });

  it('returns null when now precedes the anchor (clock/anchor disagree)', () => {
    expect(deriveCurrentTimeMin(baseline, anchor - 60 * 60_000)).toBeNull();
  });

  it('returns null (not 0) when the anchor cannot be derived', () => {
    // Critical: 0 would mean "no lock" at the BFF — same bug as omitting it.
    // null signals the caller to omit currentTimeMin entirely.
    expect(deriveCurrentTimeMin({ solution: {} }, Date.now())).toBeNull();
  });
});
