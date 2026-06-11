import { describe, expect, it } from 'vitest';

import { formatModelMinute, makespanToWorkingDays, minutesToTimeStr, type TimeConfig } from '../resultAdapter';

const tc = (dayLengthMin: number): TimeConfig => ({
  company_start_hour: 6,
  company_end_hour: 6 + dayLengthMin / 60,
  day_length_min: dayLengthMin,
  start_date: '2026-04-01',
  start_weekday: 0,
});

describe('makespanToWorkingDays — scalable to ANY plant day length (Wave 16.8)', () => {
  // 48 working hours of makespan, converted by the company's REAL working-day
  // length — NOT a hardcoded 8h. Proves it scales to 8h/10h/16h/24h plants.
  it.each([
    ['8h plant', 480, 6.0],
    ['10h plant', 600, 4.8],
    ['16h plant (demo-commesse)', 960, 3.0],
    ['24h plant', 1440, 2.0],
  ] as Array<[string, number, number]>)(
    '%s: 48h makespan → %f giorni',
    (_name, dayLengthMin, expected) => {
      expect(makespanToWorkingDays(48, tc(dayLengthMin))).toBe(expected);
    },
  );

  it('the live bug: 3580 min (59.67h) on the 16h demo plant → 3.7 gg, NOT 7.5', () => {
    const hours = 3580 / 60;
    expect(makespanToWorkingDays(hours, tc(960))).toBe(3.7);
    expect(makespanToWorkingDays(hours, tc(960))).not.toBe(7.5);
    // The old hardcoded /8 produced 7.5 — now reachable ONLY via the no-config
    // fallback, never on a real plant with time_config.
    expect(makespanToWorkingDays(hours, undefined)).toBe(7.5);
  });

  it('falls back to an 8h day only when time_config is absent or invalid', () => {
    expect(makespanToWorkingDays(48, undefined)).toBe(6.0); // 48 / 8
    expect(makespanToWorkingDays(48, tc(0))).toBe(6.0); // day_length_min<=0 → fallback
  });
});

describe('minutesToTimeStr — fallback is day_length/company-start aware (Wave 17 H2)', () => {
  it('uses the isoDatetime when present (preferred path, unchanged)', () => {
    expect(minutesToTimeStr(0, undefined, '2026-04-01 08:00')).toBe('01/04 08:00');
  });

  it('uses formatModelMinute when a TimeConfig is present (unchanged)', () => {
    // The tc-present path must delegate to formatModelMinute verbatim.
    expect(minutesToTimeStr(600, tc(960))).toBe(formatModelMinute(600, tc(960)));
  });

  it('keeps the legacy 8h/06:00 fallback when neither tc nor overrides are given', () => {
    // 120 min → 2h → G1 08:00 ; 500 min → 8h20 → G2 06:20 (8h day rolls over).
    expect(minutesToTimeStr(120)).toBe('G1 08:00');
    expect(minutesToTimeStr(500)).toBe('G2 06:20');
  });

  it('honors explicit dayLengthMin/companyStartHour overrides without a TimeConfig', () => {
    // 16h plant (960), start 06:00: 500 min → still day 1 (500 < 960), 8h20 in
    // → 06:00 + 8h20 = 14:20. The 8h fallback would WRONGLY roll to G2 06:20.
    expect(minutesToTimeStr(500, undefined, undefined, 960, 6)).toBe('G1 14:20');
    // 24h plant, midnight start: 1500 min → day 2, 60 min in → 01:00.
    expect(minutesToTimeStr(1500, undefined, undefined, 1440, 0)).toBe('G2 01:00');
  });

  it('ignores non-positive override day length and keeps the 8h fallback', () => {
    expect(minutesToTimeStr(120, undefined, undefined, 0, 6)).toBe('G1 08:00');
  });
});
