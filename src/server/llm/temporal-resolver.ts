/**
 * Wave 16.8 — canonical L-aware temporal resolver.
 *
 * THE single source of truth for converting a manager's SYMBOLIC time reference
 * (day + clock, as understood by the LLM) into absolute solver minutes. The LLM
 * (Haiku interpreter / Opus translator) must NEVER compute minutes itself: it
 * emits symbols ("domani", "giorno 3", "dalle 14 alle 18"), and this function
 * grounds them using the company's real time_config.
 *
 * Solver axis (verified): minute 0 = day 1 at `company_start_hour` (e.g. 06:00),
 * each day spans `day_length_min` (e.g. 960 for a 06:00–22:00 plant). So:
 *
 *   abs(day G, hh:mm) = (G-1)*day_length_min + (hh*60+mm - company_start_hour*60)
 *   whole day G        = [(G-1)*day_length_min, G*day_length_min)
 *   range X..Y (return) = [(X-1)*dl, (Y-1)*dl)   // days X..Y-1, returns on Y
 *
 * This MUST stay byte-for-byte equivalent to the backend resolver
 * (daino/arm_c/constraint_extractor.py `_machine_unavail_window` / `_rel_day_idx`
 * once aligned). The golden-vector parity test guards the two against drift
 * (feedback_befe_temporal_lockstep).
 */

export interface ResolverTimeConfig {
  /** Working-day length in minutes (company_end - company_start). */
  day_length_min: number;
  /** Hour the working day starts (solver minute 0). 6 for a 06:00 plant. */
  company_start_hour: number;
}

/** A relative token ("oggi"/"domani"/"dopodomani") or an absolute 1-based day N. */
export type DayRef = 'oggi' | 'domani' | 'dopodomani' | number;

export interface SymbolicWindow {
  /** When the block starts (or the single/first day). */
  day_ref: DayRef;
  /**
   * For a range "dal giorno X al giorno Y": the RETURN day (exclusive upper
   * bound). The block covers days [day_ref .. day_ref_end-1]. Whole-day only.
   */
  day_ref_end?: DayRef;
  /** Clock start within the day (24h). Absent → start of working day. */
  start_hour?: number;
  start_minute?: number;
  /** Clock end within the day (24h). Absent → end of working day. */
  end_hour?: number;
  end_minute?: number;
}

export interface AbsWindow {
  start_min: number;
  end_min: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Map a DayRef to a 0-based day index on the solver axis.
 * - relative tokens resolve against `anchorDayIndex` (the 0-based index of
 *   "oggi"; 0 when the manager gave no "siamo al giorno N" anchor).
 * - an absolute integer N (1-based "giorno N") → index N-1, independent of anchor.
 * Returns null for an unusable ref.
 */
export function dayIndexFromRef(ref: DayRef, anchorDayIndex: number): number | null {
  if (typeof ref === 'number') {
    if (!Number.isInteger(ref) || ref < 1) return null;
    return ref - 1;
  }
  switch (ref) {
    case 'oggi':
      return anchorDayIndex;
    case 'domani':
      return anchorDayIndex + 1;
    case 'dopodomani':
      return anchorDayIndex + 2;
    default:
      return null;
  }
}

/**
 * Resolve a symbolic window to absolute solver minutes. Returns null when the
 * reference is unusable (bad day, inverted/empty clock range) so the caller can
 * degrade to a clarification ask rather than emit a wrong window.
 */
export function resolveWindowToAbsMinutes(
  w: SymbolicWindow,
  tc: ResolverTimeConfig,
  anchorDayIndex = 0,
): AbsWindow | null {
  const dl = tc.day_length_min;
  if (!Number.isInteger(dl) || dl <= 0) return null;
  const cs = tc.company_start_hour * 60;

  const di = dayIndexFromRef(w.day_ref, anchorDayIndex);
  if (di === null || di < 0) return null;

  // Range form "dal giorno X al giorno Y" → whole days [X .. Y-1].
  if (w.day_ref_end !== undefined && w.day_ref_end !== null) {
    const diEnd = dayIndexFromRef(w.day_ref_end, anchorDayIndex);
    if (diEnd === null) return null;
    const start = di * dl;
    const end = diEnd * dl;
    if (end <= start) {
      // Degenerate (X >= Y): treat as the single day X.
      return { start_min: start, end_min: start + dl };
    }
    return { start_min: start, end_min: end };
  }

  // Single day. Clock parts default to the full working day [0, dl].
  const hasStart = Number.isFinite(w.start_hour);
  const hasEnd = Number.isFinite(w.end_hour);
  const sm = hasStart
    ? clamp((w.start_hour as number) * 60 + (w.start_minute ?? 0) - cs, 0, dl)
    : 0;
  const em = hasEnd
    ? clamp((w.end_hour as number) * 60 + (w.end_minute ?? 0) - cs, 0, dl)
    : dl;

  const start = di * dl + sm;
  const end = di * dl + em;
  if (end <= start) return null; // inverted/empty clock range → caller clarifies.
  return { start_min: start, end_min: end };
}
