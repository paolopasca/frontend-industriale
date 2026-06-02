import { describe, expect, it } from 'vitest';

import {
  dayIndexFromRef,
  resolveWindowToAbsMinutes,
  type ResolverTimeConfig,
  type SymbolicWindow,
} from '../temporal-resolver';

/**
 * Wave 16.8 — GOLDEN VECTORS (the temporal contract).
 *
 * These same (input, time_config, anchor → absolute minutes) tuples MUST hold
 * on the backend resolver too (daino/arm_c/constraint_extractor.py). If the two
 * sides diverge, the silent window-misplacement bug returns. Keep this list and
 * the backend's `tests/test_temporal_golden.py` identical
 * (feedback_befe_temporal_lockstep).
 */
const DEMO: ResolverTimeConfig = { day_length_min: 960, company_start_hour: 6 }; // 06:00–22:00
const C24: ResolverTimeConfig = { day_length_min: 1440, company_start_hour: 0 }; // 24h, midnight
const PLANT_B: ResolverTimeConfig = { day_length_min: 720, company_start_hour: 8 }; // 08:00–20:00

interface GoldenCase {
  name: string;
  w: SymbolicWindow;
  tc: ResolverTimeConfig;
  anchor: number;
  expect: { start_min: number; end_min: number } | null;
}

export const GOLDEN_VECTORS: GoldenCase[] = [
  // ── demo 960/06:00 — whole day ────────────────────────────────────────────
  { name: 'demo: domani (anchor g1) → giorno 2 intero', w: { day_ref: 'domani' }, tc: DEMO, anchor: 0, expect: { start_min: 960, end_min: 1920 } },
  { name: 'demo: giorno 3 target intero', w: { day_ref: 3 }, tc: DEMO, anchor: 0, expect: { start_min: 1920, end_min: 2880 } },
  { name: 'demo: dopodomani (anchor g1) → giorno 3 intero', w: { day_ref: 'dopodomani' }, tc: DEMO, anchor: 0, expect: { start_min: 1920, end_min: 2880 } },
  // ── demo — range "dal giorno X al Y" (Y = return, exclusive) ──────────────
  { name: 'demo: dal giorno 2 al giorno 4 → giorni 2,3', w: { day_ref: 2, day_ref_end: 4 }, tc: DEMO, anchor: 0, expect: { start_min: 960, end_min: 2880 } },
  // ── demo — explicit hours (company_start offset applies) ──────────────────
  { name: 'demo: domani dalle 14 alle 18', w: { day_ref: 'domani', start_hour: 14, end_hour: 18 }, tc: DEMO, anchor: 0, expect: { start_min: 1440, end_min: 1680 } },
  { name: 'demo: giorno 2 dalle 6 alle 22 = giorno intero', w: { day_ref: 2, start_hour: 6, end_hour: 22 }, tc: DEMO, anchor: 0, expect: { start_min: 960, end_min: 1920 } },
  { name: 'demo: anchor g2, oggi dalle 14 alle 18', w: { day_ref: 'oggi', start_hour: 14, end_hour: 18 }, tc: DEMO, anchor: 1, expect: { start_min: 1440, end_min: 1680 } },
  { name: 'demo: dalle 14 (no end) → 14:00 a fine giornata', w: { day_ref: 'domani', start_hour: 14 }, tc: DEMO, anchor: 0, expect: { start_min: 1440, end_min: 1920 } },
  // ── 24h/midnight plant — old hardcoded numbers are correct ONLY here ──────
  { name: 'C24: domani dalle 14 alle 18 → [2280,2520]', w: { day_ref: 'domani', start_hour: 14, end_hour: 18 }, tc: C24, anchor: 0, expect: { start_min: 2280, end_min: 2520 } },
  // ── plant B 720/08:00 — proves scalability to other companies ─────────────
  { name: 'B: domani dalle 14 alle 16', w: { day_ref: 'domani', start_hour: 14, end_hour: 16 }, tc: PLANT_B, anchor: 0, expect: { start_min: 1080, end_min: 1200 } },
  { name: 'B: giorno 2 intero', w: { day_ref: 2 }, tc: PLANT_B, anchor: 0, expect: { start_min: 720, end_min: 1440 } },
  // ── invalid / degrade ─────────────────────────────────────────────────────
  { name: 'inverted clock range → null', w: { day_ref: 'domani', start_hour: 18, end_hour: 14 }, tc: DEMO, anchor: 0, expect: null },
  { name: 'giorno 0 (nonsense) → null', w: { day_ref: 0 }, tc: DEMO, anchor: 0, expect: null },
];

describe('temporal-resolver — golden vectors (contract)', () => {
  for (const c of GOLDEN_VECTORS) {
    it(c.name, () => {
      expect(resolveWindowToAbsMinutes(c.w, c.tc, c.anchor)).toEqual(c.expect);
    });
  }

  it('demo "domani 14-18" is NOT the old buggy midnight/1440 value [2280,2520]', () => {
    const got = resolveWindowToAbsMinutes(
      { day_ref: 'domani', start_hour: 14, end_hour: 18 },
      DEMO,
      0,
    );
    expect(got).not.toEqual({ start_min: 2280, end_min: 2520 });
    expect(got).toEqual({ start_min: 1440, end_min: 1680 });
  });
});

describe('dayIndexFromRef', () => {
  it('relative tokens resolve against the anchor', () => {
    expect(dayIndexFromRef('oggi', 0)).toBe(0);
    expect(dayIndexFromRef('domani', 0)).toBe(1);
    expect(dayIndexFromRef('dopodomani', 0)).toBe(2);
    expect(dayIndexFromRef('oggi', 1)).toBe(1); // siamo al giorno 2
    expect(dayIndexFromRef('domani', 1)).toBe(2);
  });
  it('absolute "giorno N" is anchor-independent (index N-1)', () => {
    expect(dayIndexFromRef(1, 0)).toBe(0);
    expect(dayIndexFromRef(2, 5)).toBe(1);
  });
  it('rejects nonsense', () => {
    expect(dayIndexFromRef(0, 0)).toBeNull();
    expect(dayIndexFromRef(-1, 0)).toBeNull();
  });
});
