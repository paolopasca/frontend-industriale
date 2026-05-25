/**
 * Bridge between the backend template_solve response shape and the unified
 * shape consumed by every AI surface (Explainer, Manager Chat, Advisor,
 * WhatIf, Split, SplitSuggestion).
 *
 * Wave 13 F-W11-LIVE-03: the backend returns
 *   { status, solution: { COM-001: { fasi: [...] }, ... }, kpis, warnings, ... }
 *
 * but the AI surfaces all read `input.solution.status` plus a flat `fasi[]`
 * array with `commessa` on each fase. Without normalization the AI saw
 * status=UNKNOWN and fasi=[], so Spiegazione AI said "UNKNOWN" and Manager
 * Chat hit the "Non ho una pianificazione attiva" fallback even with a
 * valid FEASIBLE plan on the dashboard.
 *
 * The envelope produced here carries:
 *   - `status` lifted from the response top level
 *   - `warnings`/`reason`/`vincoli_critici` lifted likewise
 *   - `fasi[]` flattened from `solution[commessa].fasi`, with `commessa`,
 *     `ritardo_min`, and `deadline_min` injected on each entry
 *   - `commesse` preserving the original commessa-keyed map
 *
 * `buildAiKpis` adds alias keys (`makespan_min`, `cost_usd`, `n_in_ritardo`,
 * ...) so `get_kpi_summary` and `get_cost_breakdown` surface concrete numbers.
 */

export interface AiSolutionEnvelope {
  status: string;
  warnings: string[];
  fasi: Array<Record<string, unknown>>;
  commesse: Record<string, unknown>;
  reason: string | null;
  vincoli_critici: string[];
}

export interface AiInputs {
  solution: unknown;
  kpis: Record<string, number>;
}

export function extractAiInputs(raw: unknown): AiInputs {
  if (!raw || typeof raw !== 'object') return { solution: null, kpis: {} };
  const r = raw as Record<string, unknown>;
  if (r.solution !== undefined) {
    const envelope = buildAiSolutionEnvelope(r);
    const k = (r.kpis ?? {}) as Record<string, unknown>;
    return {
      solution: envelope,
      kpis: buildAiKpis(toNumberMap(k), envelope),
    };
  }
  const result = r.result as Record<string, unknown> | undefined;
  if (result) {
    return {
      solution: result.piano ?? result,
      kpis: toNumberMap((result.kpi ?? {}) as Record<string, unknown>),
    };
  }
  return { solution: raw, kpis: {} };
}

export function buildAiSolutionEnvelope(root: Record<string, unknown>): AiSolutionEnvelope {
  const status = typeof root.status === 'string' ? root.status : 'UNKNOWN';
  const warnings: string[] = Array.isArray(root.warnings)
    ? root.warnings.filter((w): w is string => typeof w === 'string')
    : [];
  const inner = (root.solution ?? {}) as Record<string, unknown>;
  const fasi: Array<Record<string, unknown>> = [];
  for (const [commessa, jobRaw] of Object.entries(inner)) {
    if (!jobRaw || typeof jobRaw !== 'object') continue;
    const job = jobRaw as Record<string, unknown>;
    const ritardoJob = typeof job.ritardo_min === 'number' ? job.ritardo_min : 0;
    const deadlineJob = typeof job.scadenza_min === 'number' ? job.scadenza_min : undefined;
    const jobFasi = Array.isArray(job.fasi) ? job.fasi : [];
    for (const f of jobFasi) {
      if (!f || typeof f !== 'object') continue;
      const fase = f as Record<string, unknown>;
      fasi.push({
        ...fase,
        commessa,
        ritardo_min: ritardoJob,
        ...(deadlineJob !== undefined ? { deadline_min: deadlineJob } : {}),
      });
    }
  }
  const reason = typeof root.reason === 'string' ? root.reason : null;
  const vincoli_critici: string[] = Array.isArray(root.vincoli_critici)
    ? root.vincoli_critici.filter((v): v is string => typeof v === 'string')
    : [];
  return { status, warnings, fasi, commesse: inner, reason, vincoli_critici };
}

export function toNumberMap(rec: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

export function buildAiKpis(
  backendKpis: Record<string, number>,
  envelope: Pick<AiSolutionEnvelope, 'fasi' | 'commesse'>,
): Record<string, number> {
  const out: Record<string, number> = { ...backendKpis };

  if ('makespan' in backendKpis && !('makespan_min' in out)) {
    out.makespan_min = backendKpis.makespan!;
  }

  const setup = backendKpis.costo_totale_setup;
  const operator = backendKpis.costo_totale_operatori;
  if (typeof setup === 'number' && !('setup_cost_usd' in out)) {
    out.setup_cost_usd = setup;
  }
  if (typeof operator === 'number' && !('operator_cost_usd' in out)) {
    out.operator_cost_usd = operator;
  }
  if (!('cost_usd' in out)) {
    const setupN = typeof setup === 'number' ? setup : 0;
    const opN = typeof operator === 'number' ? operator : 0;
    if (typeof setup === 'number' || typeof operator === 'number') {
      out.cost_usd = setupN + opN;
    }
  }

  const commesseCount = Object.keys(envelope.commesse).length;
  if (commesseCount > 0 && !('n_commesse' in out)) {
    out.n_commesse = commesseCount;
  }

  const fasi = envelope.fasi;
  if (fasi.length > 0) {
    let lateCount = 0;
    const lateCommesse = new Set<string>();
    for (const f of fasi) {
      const ritardo = typeof f.ritardo_min === 'number' ? f.ritardo_min : 0;
      const commessa = typeof f.commessa === 'string' ? f.commessa : '';
      if (ritardo > 0 && commessa && !lateCommesse.has(commessa)) {
        lateCommesse.add(commessa);
        lateCount++;
      }
    }
    if (!('n_in_ritardo' in out)) {
      out.n_in_ritardo = lateCount;
    }
    if (!('on_time_rate' in out) && commesseCount > 0) {
      out.on_time_rate = Math.max(0, Math.min(1, 1 - lateCount / commesseCount));
    }
  }

  return out;
}

/**
 * Solver status normalized for the header badge. Falls back through
 * top-level, `result.status`, and `solution.status` to handle template/FJSP
 * and the legacy LLM-only shape.
 */
export function extractSolverStatus(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.status === 'string') return r.status.toUpperCase();
  const result = r.result as Record<string, unknown> | undefined;
  if (result && typeof result.status === 'string') return result.status.toUpperCase();
  const solution = r.solution as Record<string, unknown> | undefined;
  if (solution && typeof solution.status === 'string') return solution.status.toUpperCase();
  return null;
}
