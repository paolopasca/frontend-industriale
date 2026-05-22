import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  GitCompare,
  Info,
  Lock,
  Minus,
  X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const KPI_LOWER_IS_BETTER = new Set<string>([
  'makespan_min',
  'makespan',
  'makespanDays',
  'total_cost',
  'totalCost',
  'costoTotale',
  'costoOperatori',
  'costoSetup',
  'total_setup_min',
  'totalSetupTime',
  'tardiness_min',
  'totalTardiness',
  'weighted_tardiness',
  'late_orders_count',
  'ordersLate',
]);

const KPI_HIGHER_IS_BETTER = new Set<string>([
  'on_time_rate',
  'highPriorityOnTime',
  'machine_utilization_avg',
  'avgUtilization',
  'peakUtilization',
  'operator_utilization_avg',
  'throughput',
]);

type Direction = 'lower' | 'higher' | 'unknown';

function kpiDirection(name: string): Direction {
  if (KPI_LOWER_IS_BETTER.has(name)) return 'lower';
  if (KPI_HIGHER_IS_BETTER.has(name)) return 'higher';
  return 'unknown';
}

interface KpiRow {
  key: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  direction: Direction;
  improves: boolean | null;
}

// Treats missing keys, null, undefined, and non-finite values as "no data" — see DA-01 review.
function coerceKpi(map: Record<string, unknown>, key: string): number | null {
  if (!Object.prototype.hasOwnProperty.call(map, key)) return null;
  const raw = map[key];
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

const KPI_LABELS: Record<string, string> = {
  makespan_min: 'Makespan (min)',
  makespan: 'Makespan (ore)',
  makespanDays: 'Makespan (giorni)',
  total_cost: 'Costo totale',
  totalCost: 'Costo totale',
  costoTotale: 'Costo totale',
  costoOperatori: 'Costo personale',
  costoSetup: 'Costo setup',
  total_setup_min: 'Setup (min)',
  totalSetupTime: 'Setup (min)',
  tardiness_min: 'Ritardo (min)',
  totalTardiness: 'Ritardo totale (min)',
  weighted_tardiness: 'Ritardo pesato',
  late_orders_count: 'Ordini in ritardo',
  ordersLate: 'Ordini in ritardo',
  on_time_rate: 'On-time (%)',
  highPriorityOnTime: 'Alta priorità on-time (%)',
  machine_utilization_avg: 'Utilizzo macchina (%)',
  avgUtilization: 'Utilizzo medio (%)',
  peakUtilization: 'Picco utilizzo (%)',
  operator_utilization_avg: 'Utilizzo operatori (%)',
  throughput: 'Throughput',
};

const CHANGE_TYPE_LABELS: Record<string, string> = {
  // Wave 4.1 translator types
  block_machine: 'Macchina bloccata',
  force_priority: 'Priorità forzata',
  add_capacity: 'Capacità aggiunta',
  modify_deadline: 'Deadline modificata',
  shift_window: 'Finestra turno',
  unsupported: 'Non supportato',
  // Wave 7 intent catalog IDs
  machine_unavailability: 'Macchina indisponibile',
  order_priority: 'Priorità commessa',
  deadline_change: 'Deadline modificata',
  capacity_addition: 'Capacità aggiunta',
  shift_window_change: 'Finestra turno',
  // Wave 7 strategy labels (fallback when neither type nor intent_id is known)
  A: 'Modifica dataset',
  B: 'Regola da catalogo',
  C: 'Vincolo personalizzato',
};

function changeTypeLabel(type: string): string {
  return CHANGE_TYPE_LABELS[type] ?? 'Vincolo personalizzato';
}

function formatNumber(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return n.toFixed(decimals).replace('.', ',');
}

function formatDelta(delta: number | null): string {
  if (delta === null || !Number.isFinite(delta)) return '—';
  if (delta === 0) return '0';
  const sign = delta > 0 ? '+' : '−';
  return sign + formatNumber(Math.abs(delta));
}

function buildRows(
  baselineKpis: Record<string, unknown>,
  candidateKpis: Record<string, unknown>,
): KpiRow[] {
  const keys = new Set<string>([...Object.keys(baselineKpis), ...Object.keys(candidateKpis)]);
  const rows: KpiRow[] = [];
  for (const key of keys) {
    const baseline = coerceKpi(baselineKpis, key);
    const candidate = coerceKpi(candidateKpis, key);
    const direction = kpiDirection(key);
    let delta: number | null = null;
    let improves: boolean | null = null;
    if (baseline !== null && candidate !== null) {
      delta = candidate - baseline;
      if (delta === 0) {
        improves = null;
      } else if (direction === 'lower') {
        improves = delta < 0;
      } else if (direction === 'higher') {
        improves = delta > 0;
      }
    }
    rows.push({ key, baseline, candidate, delta, direction, improves });
  }
  rows.sort((a, b) => {
    const ai = a.improves === null ? 2 : a.improves ? 1 : 0;
    const bi = b.improves === null ? 2 : b.improves ? 1 : 0;
    if (ai !== bi) return ai - bi;
    return a.key.localeCompare(b.key);
  });
  return rows;
}

// F-W8-06 OPT 2 banner — Wave 8 lead decision. When the BFF retries without
// hard-lock AND the resulting plan moved a pre-cutoff consolidated phase,
// the warning marker upgrades to this double-underscore form so the UI can
// render a red, prominent "ricalcolato da zero" banner instead of the
// amber soft-relax one.
const RECOMPUTED_FROM_SCRATCH_WARNING = 'lock_relaxed_to_soft__plan_recomputed_from_scratch';

// DA-04: warnings payload from BFF is not type-checked at runtime; coerce defensively.
// Split per cl-bff contract update: `missing_kpi:<name>` items are neutral info
// ("metrica non disponibile in questo solve"), not warnings — render them apart.
// Wave 7: `lock_relaxed_to_soft` is a dedicated marker for the soft-relax
// recovery path — surfaced as a prominent banner, never as a generic warning.
// Wave 8 F-W8-06 OPT 2: the upgraded marker `lock_relaxed_to_soft__plan_recomputed_from_scratch`
// is the strict subset that ALSO triggers the red recomputed-from-scratch banner.
interface SplitWarnings {
  missingKpis: string[];
  warnings: string[];
  lockRelaxedFromWarning: boolean;
  recomputedFromScratchFromWarning: boolean;
}

function sanitizeWarnings(input: unknown): SplitWarnings {
  if (!Array.isArray(input)) {
    return {
      missingKpis: [],
      warnings: [],
      lockRelaxedFromWarning: false,
      recomputedFromScratchFromWarning: false,
    };
  }
  const missingKpis: string[] = [];
  const warnings: string[] = [];
  let lockRelaxedFromWarning = false;
  let recomputedFromScratchFromWarning = false;
  for (const w of input) {
    if (typeof w !== 'string') continue;
    const trimmed = w.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('missing_kpi:')) {
      const name = trimmed.slice('missing_kpi:'.length).trim();
      if (name) missingKpis.push(name);
    } else if (trimmed === RECOMPUTED_FROM_SCRATCH_WARNING) {
      // F-W8-06 OPT 2 — the upgraded marker implies the basic relaxation
      // also happened, so both flags fire.
      recomputedFromScratchFromWarning = true;
      lockRelaxedFromWarning = true;
    } else if (trimmed === 'lock_relaxed_to_soft') {
      lockRelaxedFromWarning = true;
    } else if (warnings.length < 5) {
      warnings.push(trimmed);
    }
  }
  return {
    missingKpis,
    warnings,
    lockRelaxedFromWarning,
    recomputedFromScratchFromWarning,
  };
}

export interface FrozenPhase {
  commessa: string;
  operazione: string;
  macchina: string;
  start_min: number;
  end_min: number;
}

interface SolutionDiffProps {
  baseline: { solution: unknown; kpis: Record<string, number> };
  candidate: { solution: unknown; kpis: Record<string, number>; warnings: string[] };
  changeRationale: string;
  changeType: string;
  onAccept?: () => void;
  onDiscard?: () => void;
  /** Wave 7 — hard-lock telemetry from BFF apply-whatif response. */
  lockedCount?: number;
  modifiedCount?: number;
  /**
   * Rules the backend received but did not apply (unknown machine,
   * capacity/shift routed to wrong layer, etc.). When > 0, the
   * "Regole applicate" section appends "(N ignorate)" so the manager
   * sees that some rules were silently dropped.
   */
  skippedRulesCount?: number;
  /**
   * Total phases identified as falling inside the frozen window.
   * `lockedCount` may be lower if the backend could not honour them all.
   * Drives the "Nessun lock applicato" warning: shown when frozenCount > 0
   * but lockedCount === 0.
   */
  frozenCount?: number;
  intentId?: string | null;
  /**
   * Solver strategy used by the BFF orchestrator:
   *   'A' = data modification (preferred for machine_unavailability)
   *   'B' = rule addition (catalog rules.priority_orders etc.)
   *   'C' = Opus translator fallback (Wave 4.1 path)
   *   'unsupported' = router could not map the intent
   */
  strategy?: 'A' | 'B' | 'C' | 'unsupported' | null;
  lockedPhases?: FrozenPhase[];
  /**
   * Cutoff minute used by the solver, in baseline-relative minutes.
   * Required to compute the post-cutoff machine_unavailability assertion.
   */
  cutoffMin?: number | null;
  /**
   * Target machine for `machine_unavailability` intent (e.g. "M02").
   * Used to render the "M{XX} esclusa post-cutoff" badge.
   */
  targetMachineId?: string | null;
  /**
   * Italian audit lines describing dataset overrides applied by Strategy A.
   * Empty for strategy B/C. Rendered under "Modifiche al dataset" heading.
   */
  datasetOverridesSummary?: string[];
  /**
   * True when the BFF retried without hard-lock because the original
   * frozen-phase constraint was INFEASIBLE. Renders a prominent banner
   * warning the manager to verify pre-cutoff phases manually.
   */
  lockRelaxed?: boolean;
}

interface CandidatePhase {
  commessa: string;
  operazione: string;
  macchina: string;
  start_min: number;
  end_min: number;
}

function extractCandidatePhases(solution: unknown): CandidatePhase[] {
  if (!solution || typeof solution !== 'object') return [];
  const phases: CandidatePhase[] = [];
  for (const [commessa, jobRaw] of Object.entries(solution as Record<string, unknown>)) {
    if (!jobRaw || typeof jobRaw !== 'object') continue;
    const fasi = (jobRaw as { fasi?: unknown }).fasi;
    if (!Array.isArray(fasi)) continue;
    for (const f of fasi) {
      if (!f || typeof f !== 'object') continue;
      const fase = f as Record<string, unknown>;
      const macchina = typeof fase.macchina === 'string' ? fase.macchina : '';
      const operazione = typeof fase.operazione === 'string' ? fase.operazione : '';
      const startRaw = Number(fase.start_min);
      const endRaw = Number(fase.end_min);
      if (!Number.isFinite(startRaw) || !Number.isFinite(endRaw)) continue;
      phases.push({
        commessa,
        operazione,
        macchina,
        start_min: startRaw,
        end_min: endRaw,
      });
    }
  }
  return phases;
}

/** Format a baseline-relative minute as "gg<D> HH:MM". */
function formatRelMin(min: number): string {
  if (!Number.isFinite(min)) return '—';
  const total = Math.max(0, Math.round(min));
  const day = Math.floor(total / 1440) + 1;
  const rem = total % 1440;
  const hh = String(Math.floor(rem / 60)).padStart(2, '0');
  const mm = String(rem % 60).padStart(2, '0');
  return `gg${day} ${hh}:${mm}`;
}

export function SolutionDiff({
  baseline,
  candidate,
  changeRationale,
  changeType,
  onAccept,
  onDiscard,
  lockedCount,
  modifiedCount,
  skippedRulesCount,
  frozenCount,
  intentId,
  strategy,
  lockedPhases,
  cutoffMin,
  targetMachineId,
  datasetOverridesSummary,
  lockRelaxed,
}: SolutionDiffProps) {
  const rows = useMemo(
    () => buildRows(
      (baseline.kpis ?? {}) as Record<string, unknown>,
      (candidate.kpis ?? {}) as Record<string, unknown>,
    ),
    [baseline.kpis, candidate.kpis],
  );

  const { warnings, missingKpis, lockRelaxedFromWarning, recomputedFromScratchFromWarning } = useMemo(
    () => sanitizeWarnings(candidate.warnings),
    [candidate.warnings],
  );
  const changeLabel = changeTypeLabel(changeType);
  // F-W8-06 OPT 2 — red banner takes precedence over the amber lock-relaxed
  // banner. We still keep `showLockRelaxedBanner` truthy in that case so the
  // existing accordion still renders the "lock rilassato" caveat on the
  // consolidated phase list — but the standalone amber banner is suppressed
  // because the red one already conveys the same information with stronger
  // wording.
  const showRecomputedFromScratchBanner = recomputedFromScratchFromWarning;
  // Lock-relaxed banner shows when either signal is present: the SSE event
  // (caught live via lockRelaxed prop) or the marker in solved.warnings
  // (caught even if the event was missed, e.g. user opened a stale page).
  // It is suppressed when the stronger red banner is on screen — no
  // duplicate "lock rilassato" message in two flavours.
  const showLockRelaxedBanner =
    (lockRelaxed === true || lockRelaxedFromWarning) && !showRecomputedFromScratchBanner;
  const showDatasetOverrides =
    strategy === 'A' &&
    Array.isArray(datasetOverridesSummary) &&
    datasetOverridesSummary.length > 0;

  const hasLockTelemetry =
    typeof lockedCount === 'number' ||
    typeof modifiedCount === 'number' ||
    typeof frozenCount === 'number' ||
    strategy !== undefined && strategy !== null;
  const lockedPhasesList = Array.isArray(lockedPhases) ? lockedPhases : [];
  const showLockedAccordion = lockedPhasesList.length > 0;
  const [lockedExpanded, setLockedExpanded] = useState(false);
  const lockedPreview = lockedPhasesList.slice(0, 5);
  const hasMoreLocked = lockedPhasesList.length > lockedPreview.length;

  // Per BFF contract: "Nessun lock applicato" is the case where the
  // frozen-window builder DID identify phases to lock (frozen_count > 0)
  // but the solver dropped them (locked_count === 0). frozen_count === 0
  // is the legitimate no-cutoff case and must NOT trigger the warning.
  const showNoLockBanner =
    typeof lockedCount === 'number' &&
    typeof frozenCount === 'number' &&
    lockedCount === 0 &&
    frozenCount > 0;

  // F-W8-06 OPT 2 — when the red banner fires, the manager must see which
  // consolidated phases actually moved (baseline pre-cutoff phase had a
  // different start_min in the candidate). Restricted to pre-cutoff phases
  // because the whole point of the consolidated set is "production we
  // assumed was already done".
  interface MovedPhase {
    commessa: string;
    operazione: string;
    baseline_start: number;
    candidate_start: number;
    macchina_baseline: string;
    macchina_candidate: string;
  }
  const movedConsolidatedPhases = useMemo<MovedPhase[]>(() => {
    if (!showRecomputedFromScratchBanner) return [];
    if (cutoffMin === null || cutoffMin === undefined) return [];
    const baselinePhases = extractCandidatePhases(baseline.solution);
    const candidatePhases = extractCandidatePhases(candidate.solution);
    // Key by commessa+operazione (idx within commessa not exposed; operazione
    // is unique per commessa in the demo fixture, and the BFF preserves
    // operazione identity across re-solves).
    const candByKey = new Map<string, CandidatePhase>();
    for (const p of candidatePhases) {
      candByKey.set(`${p.commessa}#${p.operazione}`, p);
    }
    const moved: MovedPhase[] = [];
    for (const b of baselinePhases) {
      if (b.end_min > cutoffMin) continue;
      const c = candByKey.get(`${b.commessa}#${b.operazione}`);
      if (!c) {
        moved.push({
          commessa: b.commessa,
          operazione: b.operazione,
          baseline_start: b.start_min,
          candidate_start: Number.NaN,
          macchina_baseline: b.macchina,
          macchina_candidate: '—',
        });
        continue;
      }
      if (c.start_min !== b.start_min || c.macchina !== b.macchina) {
        moved.push({
          commessa: b.commessa,
          operazione: b.operazione,
          baseline_start: b.start_min,
          candidate_start: c.start_min,
          macchina_baseline: b.macchina,
          macchina_candidate: c.macchina,
        });
      }
    }
    return moved;
  }, [showRecomputedFromScratchBanner, cutoffMin, baseline.solution, candidate.solution]);

  // Wave 7 — verify the candidate solution does not assign `targetMachineId`
  // to any phase whose start lies at or after the cutoff. This is the
  // operational truth-check that the wave-7 hard-lock + rules pipeline
  // actually had an effect on the candidate.
  const machineExclusionStatus = useMemo(() => {
    if (
      intentId !== 'machine_unavailability' ||
      !targetMachineId ||
      cutoffMin === null ||
      cutoffMin === undefined
    ) {
      return null;
    }
    const phases = extractCandidatePhases(candidate.solution);
    const targetNorm = targetMachineId.trim().toUpperCase();
    const offending = phases.filter((p) => {
      if (p.macchina.trim().toUpperCase() !== targetNorm) return false;
      return p.start_min >= cutoffMin;
    });
    return { offending, count: offending.length };
  }, [intentId, targetMachineId, cutoffMin, candidate.solution]);

  // "Vincolo applicato" badge — generic constraint-respected verdict.
  // Per BFF contract the verdict is implicit: strategy='unsupported' means
  // no constraint was applied; otherwise the constraint was applied
  // (and the machine-exclusion badge does the UI truth-check for
  // machine_unavailability specifically). The badge is hidden when no
  // strategy info is available (Wave 4.1 fallback).
  const violatedConstraint: boolean | null = useMemo(() => {
    if (strategy === 'unsupported') return true;
    if (strategy === 'A' || strategy === 'B' || strategy === 'C') return false;
    return null;
  }, [strategy]);

  return (
    <Card
      role="region"
      aria-label="Confronto soluzione baseline vs candidate"
      data-testid="solution-diff"
      className="border-primary/30"
    >
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <GitCompare className="h-5 w-5 text-primary" aria-hidden />
          Confronto soluzioni
          <Badge variant="secondary" className="ml-1">
            {changeLabel}
          </Badge>
        </CardTitle>
        {changeRationale && (
          <p className="text-xs text-muted-foreground line-clamp-2">{changeRationale}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {showRecomputedFromScratchBanner && (
          // F-W8-06 OPT 2 banner — Wave 8 lead decision. The BFF retry
          // without hard-lock produced a plan that moved one or more
          // pre-cutoff consolidated phases; the manager must verify
          // production-floor reality against the new schedule.
          <div
            role="alert"
            aria-label="Piano ricalcolato da zero — fasi consolidate potrebbero essere state spostate"
            data-testid="solution-diff-recomputed-from-scratch-banner"
            className="rounded-md border border-destructive/60 bg-destructive/10 p-3"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="h-4 w-4 text-destructive mt-0.5 shrink-0"
                aria-hidden
              />
              <div className="text-xs text-destructive-foreground leading-snug space-y-2">
                <p className="text-destructive font-medium">
                  ATTENZIONE: il piano e stato ricalcolato da zero, fasi
                  consolidate potrebbero essersi spostate.
                </p>
                {movedConsolidatedPhases.length > 0 && (
                  <ul
                    className="text-[11px] font-mono space-y-0.5"
                    data-testid="solution-diff-recomputed-moved-list"
                  >
                    {movedConsolidatedPhases.slice(0, 8).map((p, i) => (
                      <li
                        key={`${p.commessa}-${p.operazione}-${i}`}
                        data-testid={`solution-diff-recomputed-moved-row-${i}`}
                        className="text-destructive"
                      >
                        <span className="font-semibold">{p.commessa}</span>
                        <span className="mx-1">·</span>
                        <span>{p.operazione}</span>
                        <span className="mx-1">·</span>
                        <span>{p.macchina_baseline}</span>
                        <span className="mx-1">spostata da</span>
                        <span>{formatRelMin(p.baseline_start)}</span>
                        <span className="mx-1">→</span>
                        <span>{
                          Number.isFinite(p.candidate_start)
                            ? formatRelMin(p.candidate_start)
                            : 'fase rimossa'
                        }</span>
                        {p.macchina_baseline !== p.macchina_candidate && (
                          <>
                            <span className="mx-1">su</span>
                            <span>{p.macchina_candidate}</span>
                          </>
                        )}
                      </li>
                    ))}
                    {movedConsolidatedPhases.length > 8 && (
                      <li className="text-[10px] text-destructive/80 pt-0.5">
                        +{movedConsolidatedPhases.length - 8} altre fasi consolidate spostate non mostrate.
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </div>
          </div>
        )}
        {showLockRelaxedBanner && (
          <div
            role="alert"
            aria-label="Lock di produzione invariata rilassato"
            data-testid="solution-diff-lock-relaxed-banner"
            className="rounded-md border border-amber-500/50 bg-amber-500/15 p-3"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle
                className="h-4 w-4 text-amber-700 dark:text-amber-400 mt-0.5 shrink-0"
                aria-hidden
              />
              <div className="text-xs text-amber-900 dark:text-amber-200 leading-snug">
                <strong>Attenzione:</strong> il lock di produzione invariata e stato
                rilassato per trovare una soluzione fattibile. Verifica manuale
                delle fasi pre-cutoff consigliata.
              </div>
            </div>
          </div>
        )}

        {hasLockTelemetry && (
          <div
            role="region"
            aria-label="Stato applicazione vincolo Wave 7"
            className="flex flex-wrap items-center gap-2"
          >
            {violatedConstraint === true ? (
              <Badge
                variant="destructive"
                className="gap-1.5"
                data-testid="solution-diff-violation-badge"
                data-violated="true"
                aria-label="Vincolo non applicato dal solver"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
                Vincolo NON applicato
                <span className="sr-only"> — il solver non ha rispettato il vincolo richiesto</span>
              </Badge>
            ) : violatedConstraint === false ? (
              <Badge
                variant="default"
                className="gap-1.5 bg-emerald-600 hover:bg-emerald-600/90 text-white"
                data-testid="solution-diff-violation-badge"
                data-violated="false"
                aria-label="Vincolo applicato correttamente dal solver"
              >
                <Check className="h-3.5 w-3.5" aria-hidden />
                Vincolo applicato
                <span className="sr-only"> — il solver ha rispettato il vincolo richiesto</span>
              </Badge>
            ) : null}

            {machineExclusionStatus && targetMachineId && (
              machineExclusionStatus.count === 0 ? (
                <Badge
                  variant="default"
                  className="gap-1.5 bg-emerald-600 hover:bg-emerald-600/90 text-white"
                  data-testid="solution-diff-machine-exclusion-badge"
                  data-machine-excluded="true"
                  aria-label={`${targetMachineId} esclusa correttamente dopo il cutoff`}
                >
                  <Check className="h-3.5 w-3.5" aria-hidden />
                  {targetMachineId} esclusa post-cutoff
                  <span className="sr-only"> — vincolo di indisponibilita macchina rispettato</span>
                </Badge>
              ) : (
                <Badge
                  variant="destructive"
                  className="gap-1.5"
                  data-testid="solution-diff-machine-exclusion-badge"
                  data-machine-excluded="false"
                  data-offending-count={machineExclusionStatus.count}
                  aria-label={`${targetMachineId} ancora assegnata a ${machineExclusionStatus.count} fasi post-cutoff`}
                >
                  <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
                  {targetMachineId} ancora presente! ({machineExclusionStatus.count})
                  <span className="sr-only"> — vincolo di indisponibilita macchina non rispettato dal solver</span>
                </Badge>
              )
            )}
          </div>
        )}

        {showNoLockBanner && (
          <div
            role="alert"
            aria-label="Nessun lock applicato"
            data-testid="solution-diff-no-lock-banner"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3"
          >
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-700 dark:text-amber-400 mt-0.5 shrink-0" aria-hidden />
              <div className="text-xs text-amber-900 dark:text-amber-200 leading-snug">
                <strong>Nessun lock applicato</strong> — il piano e stato ricalcolato da zero.
                La produzione passata potrebbe essere stata modificata.
              </div>
            </div>
          </div>
        )}

        {showLockedAccordion && (
          <div
            role="region"
            aria-label="Fasi consolidate (invariate)"
            data-testid="solution-diff-locked-section"
            className="rounded-md border bg-muted/20"
          >
            <button
              type="button"
              onClick={() => setLockedExpanded((v) => !v)}
              aria-expanded={lockedExpanded}
              aria-controls="solution-diff-locked-list"
              data-testid="solution-diff-locked-toggle"
              data-soft-relaxed={showLockRelaxedBanner ? 'true' : 'false'}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-inset rounded-md"
            >
              <span className="inline-flex items-center gap-2 text-xs font-medium">
                <Lock
                  className={`h-3.5 w-3.5 ${
                    showLockRelaxedBanner
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                  }`}
                  aria-hidden
                />
                {showLockRelaxedBanner
                  ? 'Fasi originariamente previste (lock rilassato)'
                  : 'Fasi consolidate (invariate)'}
                <Badge variant="secondary" data-testid="solution-diff-locked-count">
                  {lockedCount ?? lockedPhasesList.length}
                </Badge>
              </span>
              {lockedExpanded ? (
                <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden />
              ) : (
                <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
              )}
            </button>
            {lockedExpanded && (
              <div
                id="solution-diff-locked-list"
                className="border-t px-3 py-2 space-y-1"
                data-testid="solution-diff-locked-list"
              >
                {showLockRelaxedBanner && (
                  <p className="text-[10px] text-amber-700 dark:text-amber-400 italic pb-1">
                    * Lock rilassato per infeasibility — queste fasi potrebbero essere state spostate dal solver.
                  </p>
                )}
                <ul className="text-xs space-y-1 font-mono">
                  {lockedPreview.map((p, i) => (
                    <li
                      key={`${p.commessa}-${p.operazione}-${i}`}
                      className="flex items-center justify-between gap-2 text-muted-foreground"
                      data-testid={`solution-diff-locked-row-${i}`}
                    >
                      <span className="truncate">
                        <span className="text-foreground">{p.commessa}</span>
                        <span className="mx-1 text-muted-foreground">·</span>
                        <span>{p.operazione}</span>
                        <span className="mx-1 text-muted-foreground">·</span>
                        <span>{p.macchina}</span>
                      </span>
                      <span className="tabular-nums shrink-0">
                        {formatRelMin(p.start_min)} → {formatRelMin(p.end_min)}
                      </span>
                    </li>
                  ))}
                </ul>
                {hasMoreLocked && (
                  <p className="text-[10px] text-muted-foreground pt-1">
                    +{lockedPhasesList.length - lockedPreview.length} altre fasi consolidate non mostrate.
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {((typeof modifiedCount === 'number' && modifiedCount > 0) ||
          (typeof skippedRulesCount === 'number' && skippedRulesCount > 0)) && (
          <div
            role="region"
            aria-label="Regole dinamiche applicate dal solver"
            data-testid="solution-diff-modified-section"
            data-skipped-count={skippedRulesCount ?? 0}
            className="rounded-md border bg-muted/20 px-3 py-2"
          >
            <div className="flex items-center gap-2 text-xs font-medium flex-wrap">
              <GitCompare className="h-3.5 w-3.5 text-primary" aria-hidden />
              Regole applicate
              <Badge variant="secondary" data-testid="solution-diff-modified-count">
                {modifiedCount ?? 0}
              </Badge>
              {typeof skippedRulesCount === 'number' && skippedRulesCount > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-amber-700 dark:text-amber-400 inline-flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" aria-hidden />
                    {skippedRulesCount} ignorat{skippedRulesCount === 1 ? 'a' : 'e'}
                    <Badge
                      variant="outline"
                      className="ml-1 border-amber-500/50 text-amber-700 dark:text-amber-400"
                      data-testid="solution-diff-skipped-rules-count"
                    >
                      {skippedRulesCount}
                    </Badge>
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {showDatasetOverrides && (
          <div
            role="region"
            aria-label="Modifiche al dataset"
            data-testid="solution-diff-dataset-overrides"
            className="rounded-md border bg-muted/20 px-3 py-2 space-y-1.5"
          >
            <div className="flex items-center gap-2 text-xs font-medium">
              <Info className="h-3.5 w-3.5 text-primary" aria-hidden />
              Modifiche al dataset
              <Badge variant="secondary" data-testid="solution-diff-dataset-overrides-count">
                {datasetOverridesSummary?.length ?? 0}
              </Badge>
            </div>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {datasetOverridesSummary?.map((line, i) => (
                <li
                  key={i}
                  className="leading-snug"
                  data-testid={`solution-diff-dataset-overrides-row-${i}`}
                >
                  • {line}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="rounded-md border overflow-hidden">
          <table className="w-full text-sm" data-testid="solution-diff-table">
            <thead className="bg-muted/40">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  KPI
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Baseline
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Candidate
                </th>
                <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Δ
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-xs text-muted-foreground">
                    Nessun KPI disponibile per il confronto.
                  </td>
                </tr>
              )}
              {rows.map((row) => {
                const label = KPI_LABELS[row.key] ?? row.key;
                const deltaTxt = formatDelta(row.delta);
                let deltaClass = 'text-muted-foreground';
                let Arrow: typeof ArrowUp | null = null;
                let srLabel = '';
                const hasDelta = row.delta !== null && Number.isFinite(row.delta);
                if (row.improves === true && row.delta !== null) {
                  deltaClass = 'text-emerald-600 dark:text-emerald-400 font-semibold';
                  Arrow = row.delta < 0 ? ArrowDown : ArrowUp;
                  srLabel = ' (migliora)';
                } else if (row.improves === false && row.delta !== null) {
                  deltaClass = 'text-destructive font-semibold';
                  Arrow = row.delta < 0 ? ArrowDown : ArrowUp;
                  srLabel = ' (peggiora)';
                } else if (hasDelta && row.delta !== 0) {
                  Arrow = Minus;
                  srLabel = ' (variazione, direzione non nota)';
                } else if (!hasDelta) {
                  srLabel = ' (dato non disponibile)';
                }
                return (
                  <tr
                    key={row.key}
                    className="border-t"
                    data-testid={`solution-diff-row-${row.key}`}
                  >
                    <td className="px-3 py-2 text-foreground">{label}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                      {formatNumber(row.baseline)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums">
                      {formatNumber(row.candidate)}
                    </td>
                    <td className={`px-3 py-2 text-right font-mono tabular-nums ${deltaClass}`}>
                      <span className="inline-flex items-center justify-end gap-1">
                        {Arrow && <Arrow className="h-3 w-3" aria-hidden />}
                        <span>{deltaTxt}</span>
                        {srLabel && <span className="sr-only">{srLabel}</span>}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {missingKpis.length > 0 && (
          <div
            className="rounded-md border bg-muted/30 p-2.5"
            data-testid="solution-diff-missing-kpis"
          >
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground mb-1">
              <Info className="h-3.5 w-3.5" aria-hidden />
              Metriche non confrontabili ({missingKpis.length})
            </div>
            <p className="text-xs text-muted-foreground leading-snug">
              {missingKpis.join(', ')} — non disponibili in entrambe le soluzioni.
            </p>
          </div>
        )}

        {warnings.length > 0 && (
          <div
            className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5"
            data-testid="solution-diff-warnings"
          >
            <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400 mb-1">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
              Avvertenze ({warnings.length})
            </div>
            <ul className="space-y-1 text-xs text-amber-900 dark:text-amber-200">
              {warnings.map((w, i) => (
                <li key={i} className="leading-snug">
                  • {w}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onDiscard}
            data-testid="solution-diff-discard"
          >
            <X className="h-3.5 w-3.5 mr-1.5" aria-hidden />
            Scarta
          </Button>
          <Button size="sm" onClick={onAccept} data-testid="solution-diff-accept">
            <Check className="h-3.5 w-3.5 mr-1.5" aria-hidden />
            Accetta
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
