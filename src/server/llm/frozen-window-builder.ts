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
 * `seq` is the 0-based index inside the baseline `fasi` array. The
 * backend's `alternatives` dict is keyed `(jid, seq)` where seq is the
 * operation sequence number (see fjsp.py: `alternatives[jid, seq] = alts`).
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
    for (let seq = 0; seq < fasiRaw.length; seq++) {
      const faseRaw = fasiRaw[seq];
      if (!isObject(faseRaw)) continue;
      const fase = faseRaw as BaselineFase;
      const start = asFiniteInt(fase.start_min);
      const end = asFiniteInt(fase.end_min);
      const operazione = asString(fase.operazione) ?? `OP-${seq + 1}`;
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
