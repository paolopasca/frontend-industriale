/**
 * Wave 7 — Frozen-window builder.
 *
 * Given an FJSP baseline `{[commessa]: { fasi: [...] }}` and a cutoff
 * (`cutoffMin = currentTimeMin + cushionMin`), extract the list of
 * phases that have already finished (or finish exactly at the cutoff).
 * The BFF ships this list to the backend's hard-lock branch
 * (`daino/templates/fjsp.py:1410-1524`) so the solver pins them via
 * `model.add(start_var == start_min)` and the matching machine
 * alternative is forced present.
 *
 * Contract:
 *   - A phase is "frozen" when `fase.end_min <= cutoffMin`.
 *   - A phase that straddles the cutoff (`start_min < cutoffMin < end_min`)
 *     is intentionally NOT returned — the solver is free to keep it or
 *     reschedule it. The Wave 7 plan §4 calls this out explicitly:
 *     "fase a cavallo (start < cutoff < end): NON includere
 *     (lascia libera al solver)".
 *   - A phase entirely in the future (`start_min >= cutoffMin`) is also
 *     not frozen.
 *
 * Output shape (matches the backend reader at fjsp.py:1430-1465):
 *   { job_id, seq, start_min, end_min, machine_id, worker_id,
 *     commessa, operazione, operatore }
 *
 * Field naming note: the backend accepts both `job_id`/`commessa` and
 * `seq`/`sequenza`. We emit both so the payload is self-describing for
 * any debug log; the load-bearing fields for the solver are
 * `job_id` + `seq` + `machine_id` + `start_min` + `end_min`.
 *
 * `seq` MUST match the backend convention: 1-based when the baseline
 * does not carry an explicit `sequenza`/`seq` field. The backend keys
 * its `alternatives` dict on the same value it reads from
 * `op["sequenza"]` (fjsp.py:713-715, 800-810), and the parallel warm-
 * start parser at fjsp.py:1978 uses `enumerate(fasi, start=1)` as the
 * positional fallback. Pre-fix this builder emitted 0-based indices, so
 * every `alternatives[(jid, 0)]` lookup missed and the hard-lock silently
 * skipped 100% of frozen phases (`frozen_phase_skipped` with reason
 * `(job_id, seq) not in current alternatives`). Devils F-W8-09 2026-05-22.
 */

export interface FrozenPhase {
  job_id: string;
  seq: number;
  start_min: number;
  end_min: number;
  machine_id: string;
  worker_id: string;
  /** Legacy aliases preserved for UI/debug; backend reads job_id/seq/machine_id. */
  commessa: string;
  operazione: string;
  operatore: string;
}

interface BaselineFase {
  operazione?: unknown;
  macchina?: unknown;
  machine_id?: unknown;
  operatore?: unknown;
  start_min?: unknown;
  end_min?: unknown;
  // Optional explicit sequence identifier. Backend reads either name.
  // When both absent, builder falls back to 1-based positional index.
  sequenza?: unknown;
  seq?: unknown;
}

interface BaselineJob {
  fasi?: unknown;
}

type BaselineSolution = Record<string, BaselineJob | unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

function asFiniteInt(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.trunc(v);
}

/**
 * Build the frozen-phases list. Tolerant to missing fields and unexpected
 * shapes — anything that can't be coerced into the FrozenPhase contract
 * is silently skipped (we never inject placeholders into the hard-lock
 * payload, since a bad lock would cause the solver to refuse with
 * INFEASIBLE rather than just degrade gracefully).
 */
export function buildFrozenPhases(
  baseline: unknown,
  cutoffMin: number,
): FrozenPhase[] {
  if (!Number.isFinite(cutoffMin) || cutoffMin <= 0) return [];
  if (!isObject(baseline)) return [];

  const frozen: FrozenPhase[] = [];
  for (const [commessa, jobRaw] of Object.entries(baseline as BaselineSolution)) {
    if (!isObject(jobRaw)) continue;
    const fasiRaw = (jobRaw as BaselineJob).fasi;
    if (!Array.isArray(fasiRaw)) continue;
    for (let idx = 0; idx < fasiRaw.length; idx++) {
      const faseRaw = fasiRaw[idx];
      if (!isObject(faseRaw)) continue;
      const fase = faseRaw as BaselineFase;
      // Backend keys alternatives[(jid, seq)] on op["sequenza"] (fjsp.py:715,
      // 800). When the baseline carries no explicit sequenza/seq, match the
      // backend's positional convention (fjsp.py:1978: enumerate start=1)
      // by using a 1-based index. Pre-fix this builder used 0-based, which
      // missed every (jid, 0) lookup and silently skipped 100% of locks.
      const seqExplicit = asFiniteInt(fase.sequenza) ?? asFiniteInt(fase.seq);
      const seq = seqExplicit !== null && seqExplicit > 0 ? seqExplicit : idx + 1;
      const start = asFiniteInt(fase.start_min);
      const end = asFiniteInt(fase.end_min);
      const operazione = asString(fase.operazione) ?? `OP-${seq}`;
      const machineId = asString(fase.machine_id) ?? asString(fase.macchina);
      const operatore = asString(fase.operatore) ?? '';
      if (start === null || end === null) continue;
      if (machineId === null) continue;
      if (end <= start) continue;
      // Phase fully completed at or before cutoff → freeze.
      // Edge case (straddling): start < cutoff < end → leave to solver.
      // Edge case (future): start >= cutoff → leave to solver.
      if (end <= cutoffMin) {
        frozen.push({
          job_id: commessa,
          seq,
          start_min: start,
          end_min: end,
          machine_id: machineId,
          worker_id: operatore,
          commessa,
          operazione,
          operatore,
        });
      }
    }
  }
  return frozen;
}

/**
 * Wave 16.4 A4 — detect a scenario start time from the manager's free-text
 * utterance.
 *
 * Common what-if utterances ("ferma M-1 domani dalle 14 alle 18", "anticipa
 * COM-001 al giorno 3") describe a constraint that will take effect at a
 * future point in time. The legacy `cutoffMin = currentTimeMin + cushionMin`
 * (30 min lookahead) is correct for an immediate "ferma adesso" intent but
 * wrong for "domani": the manager doesn't want the schedule frozen up to
 * 30 minutes from now, they want it frozen up to the start of day 2 (so
 * the solver can re-plan around the future constraint without disturbing
 * everything already scheduled).
 *
 * This helper picks up four temporal forms, each scaled by the company's
 * working-day length `dayLengthMin` (mirrors temporal-resolver.ts: whole
 * day G == [(G-1)*dl, G*dl), so "domani" == day 2 == 1*dl):
 *   - "domani"        → 1 * dayLengthMin
 *   - "dopodomani"    → 2 * dayLengthMin
 *   - "giorno N"      → (N - 1) * dayLengthMin   (N ∈ [2, 365]; N=1 returns null)
 *   - "fra N giorni"  → N * dayLengthMin         (N ∈ [1, 365])
 *
 * Returns `null` when no temporal phrase is detected, or when the matched
 * phrase resolves to 0 (e.g. "giorno 1" == horizon start; manager is
 * already past it and the legacy cushion path is the correct fallback).
 *
 * The returned value is in minutes from horizon start (the same coordinate
 * system as currentTimeMin / cutoffMin).
 */
// Wave 16.8 — legacy fallback ONLY. The real working-day length is data-
// dependent (demo-commesse runs a 06:00–22:00 plant → 960 min/day) and must be
// passed in. Hard-coding 1440 froze a 960-min plant through the middle of the
// next working day. Kept as the default for callers not yet wired (apply-whatif.ts).
const DAY_MIN = 1440;

// Regex patterns are module-level so detectScenarioStartMin and
// detectScenarioPhraseMatches stay in lockstep — they both match the same
// surface. Devil-advocate LOW-4 (2026-05-27): standardize N range to
// [1, 365] with consistent \d{1,3} caps across "fra/tra/in N giorni" and
// "giorno N".
const RE_DOPODOMANI = /\bdopodomani\b/;
const RE_DOMANI = /\bdomani\b/;
const RE_FRA_N_GIORNI = /\b(?:fra|tra|in)\s+(\d{1,3})\s+giorn[io]\b/;
const RE_GIORNO_N = /\bgiorno\s+(\d{1,3})\b/;

export function detectScenarioStartMin(
  whatifText: string,
  // Wave 16.8: dayLengthMin va passato dal baseline.time_config — wiring del
  // caller fatto separatamente. Opzionale con fallback al vecchio 1440 così
  // apply-whatif.ts continua a compilare/comportarsi come prima finché il suo
  // wiring non atterra. Valori non-positivi/non-finiti ricadono sul default.
  dayLengthMin?: number,
): number | null {
  if (typeof whatifText !== 'string' || whatifText.trim().length === 0) return null;
  const t = whatifText.toLowerCase();

  const L =
    typeof dayLengthMin === 'number' && Number.isFinite(dayLengthMin) && dayLengthMin > 0
      ? dayLengthMin
      : DAY_MIN;

  // "dopodomani" must be checked BEFORE "domani" because it contains it.
  if (RE_DOPODOMANI.test(t)) return 2 * L;
  if (RE_DOMANI.test(t)) return 1 * L;

  // "fra N giorni" / "tra N giorni" / "in N giorni". N==0 ("fra 0 giorni"
  // is semantically "now") returns null so the legacy cushion path runs.
  const fraMatch = t.match(RE_FRA_N_GIORNI);
  if (fraMatch) {
    const n = Number(fraMatch[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 365) return n * L;
  }

  // "giorno N" (1-based day index). Day 1 == horizon start == minute 0,
  // which the manager has already crossed; return null so the legacy
  // cushion path runs (devil-advocate LOW-3 2026-05-27).
  const dayMatch = t.match(RE_GIORNO_N);
  if (dayMatch) {
    const n = Number(dayMatch[1]);
    if (Number.isFinite(n) && n >= 2 && n <= 365) return (n - 1) * L;
  }

  return null;
}

/**
 * Wave 16.4 A4 — return the list of temporal phrase forms found in the
 * utterance. Used by the BFF route to detect ambiguity ("dopodomani arriva
 * il giorno 5"): when len(matches) > 1, the chosen form (whatever
 * detectScenarioStartMin priority picks) may not be what the manager
 * intended. The route emits a warning so the UI can surface a "you said
 * both X and Y" banner. Devil-advocate MEDIUM-2 (2026-05-27).
 *
 * Each entry is one of: 'dopodomani' | 'domani' | 'fra_n_giorni' | 'giorno_n'.
 * Order in the returned array matches the priority order used by
 * detectScenarioStartMin so callers can read matches[0] for the "winner".
 */
export function detectScenarioPhraseMatches(whatifText: string): string[] {
  if (typeof whatifText !== 'string' || whatifText.trim().length === 0) return [];
  const t = whatifText.toLowerCase();
  const matches: string[] = [];

  if (RE_DOPODOMANI.test(t)) matches.push('dopodomani');
  // "domani" must NOT be double-counted when "dopodomani" is also present.
  // Strip dopodomani occurrences before testing for domani.
  const tWithoutDopo = t.replace(/\bdopodomani\b/g, '');
  if (RE_DOMANI.test(tWithoutDopo)) matches.push('domani');

  const fra = t.match(RE_FRA_N_GIORNI);
  if (fra) {
    const n = Number(fra[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 365) matches.push('fra_n_giorni');
  }
  const giorno = t.match(RE_GIORNO_N);
  if (giorno) {
    const n = Number(giorno[1]);
    if (Number.isFinite(n) && n >= 2 && n <= 365) matches.push('giorno_n');
  }
  return matches;
}
