import { useEffect, useMemo, useRef, useState, useCallback, type KeyboardEvent } from 'react';
import { useReducedMotion } from 'framer-motion';
import {
  FlaskConical,
  Send,
  Copy,
  RotateCw,
  AlertCircle,
  Lightbulb,
  Wand2,
  X as XIcon,
  Clock,
  Layers,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { sseStream, friendlyErrorMessage } from '@/lib/streamingFetch';
import { SolutionDiff, type FrozenPhase } from './SolutionDiff';
import { humanizeUnsupportedReason } from './unsupported-reason-labels';
import { WhatIfConfirmationModal } from './WhatIfConfirmationModal';
import { describeLedgerRules } from '@/lib/appliedRulesLedger';

interface WhatIfAnalysisProps {
  slug: string | null;
  solution: unknown;
  kpis: Record<string, number>;
  consultationMd?: string;
  dataSchemaMd?: string;
  // Wave 16.6 §C — the RAW live backend solution map ({ COM-001: { fasi: [] } }),
  // distinct from `solution` (the normalized AiInputs envelope used for display
  // + the /api/whatif analysis call). apply-whatif must re-solve from THIS map
  // so the solver/frozen-window builder see the real commessa→fasi shape and
  // the applied constraints carry. Falls back to `solution` when absent.
  liveSolutionMap?: unknown;
  // Wave 16.6 §C — cumulative applied-rules ledger (folded new-wins by the
  // parent). Threaded to apply-whatif as `priorRules` so prior-accepted
  // constraints are re-applied together with the new scenario.
  priorRules?: Record<string, unknown>;
  // Wave 16.4 A7 — when the manager clicks "Accetta" on a candidate diff
  // we synthesize a solve-template shaped result and hand it back to the
  // parent route so `setBackendResult` swaps the dashboard to the new plan.
  // Wave 16.6 §C — second arg carries the accepted rules so the parent can
  // append them to the ledger for the next What-If.
  onAcceptResult?: (result: unknown, acceptedRules?: Record<string, unknown>) => void;
  // Wave 16.5 A3 — the full original backend envelope (status, solution,
  // kpis, time_config, maintenance, operator_config, …). The apply-whatif
  // `solved` event only returns solution+kpis; `adaptResult` needs the rest
  // (time_config for wall-clock labels, maintenance windows, operator
  // shifts) to render the Gantt/KPI/OperationalPlan. On accept we merge the
  // candidate's solution+kpis over this so the dashboard refreshes fully.
  originalBackendResult?: unknown;
  // Wave 16.6 (Option A) — clear the cumulative applied-rules ledger so the
  // NEXT What-If/Ripianifica starts from a clean constraint slate. The parent
  // owns the ledger (clearLedger + ledgerVersion bump) so priorRules recomputes
  // to {} and the inherited-constraints panel disappears. The live plan on the
  // dashboard is left untouched — only the carry is dropped.
  onClearPriorRules?: () => void;
}

interface ChunkPayload { text: string }
interface DonePayload { cost_usd?: number; tokens_in?: number; tokens_out?: number }
interface ErrorPayload { code?: string; message: string }

type ConstraintChangeType =
  | 'block_machine'
  | 'force_priority'
  | 'add_capacity'
  | 'modify_deadline'
  | 'shift_window'
  | 'unsupported';

interface ConstraintChange {
  type: ConstraintChangeType;
  rules: Record<string, unknown>;
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
  warnings: string[];
  unsupportedReason?: string;
  // Wave 16.2 — GRAY_ZONE fields added by bff-orchestrator.
  requiresConfirmation?: boolean;
  confirmationMessage?: string;
}

interface ApplySolvedPayload {
  newSolution: Record<string, unknown>;
  newKpis: Record<string, number>;
  deltaKpis: Record<string, number>;
  warnings: string[];
  status: string;
  objective_value: number;
  // Wave 7 — hard-lock + strategy telemetry. Always present in the
  // BFF Wave 7 contract (see w7-bff-orchestrator message). Defaults
  // when fallback Wave 4.1 path is taken: strategy='C',
  // cutoff_min=undefined, frozen_count=0, locked_count=0.
  strategy?: 'A' | 'B' | 'C';
  cutoff_min?: number;
  frozen_count?: number;
  locked_count?: number;
  modified_count?: number;
  // Wave 7 — rules the backend received but did not apply (unknown
  // machine, capacity/shift routed to wrong layer). Pair with
  // modified_count to give "N applicate (M ignorate)" granularity.
  skipped_rules_count?: number;
  // Wave 7 — Italian audit lines describing the dataset overrides
  // applied by Strategy A (empty for strategy B/C).
  dataset_overrides_summary?: string[];
  // Wave 7 — detailed list of frozen phases. Entries carry both UI-legacy
  // names (commessa/operazione/macchina) and backend audit fields
  // (job_id/seq/machine_id/worker_id); we read only the UI-legacy slice.
  locked_phases?: FrozenPhase[];
  // Wave 16.6 §C — the NEW scenario's rule slot (pre-merge), appended to the
  // ledger on accept so the next What-If carries it.
  applied_rules?: Record<string, unknown>;
}

interface ApplyAbortedUnsupportedPayload {
  reason: string;
  warnings: string[];
}

// Wave 16.3 — GRAY_ZONE confirmation state.
// BFF pauses before solving and emits requires_confirmation. On confirm we
// echo confirmedPayload back so the BFF can solve without re-extracting.
interface GrayZoneConfirmationState {
  confirmationMessage: string;
  confidence?: number;
  confirmedPayload: Record<string, unknown>;
}

type ApplyingState = 'idle' | 'translating' | 'solving' | 'done' | 'unsupported' | 'error';

const MAX_SCENARIO_CHARS = 2000;

const EXAMPLES = [
  'Posso fermare la linea 2 oggi dalle 14 alle 18 per manutenzione, conviene?',
  'Cosa succede se anticipo COM-007 prima di tutte le altre?',
  'Se aggiungo una macchina M-3 secondaria, quanto recupero sul makespan?',
  'Sposto il turno serale di mercoledì al venerdì: rischio ritardi?',
];

const APPLYING_LABEL: Record<ApplyingState, string> = {
  idle: '',
  translating: 'Traduco vincolo…',
  solving: 'Calcolo nuovo piano…',
  done: 'Pronto',
  unsupported: 'Scenario non supportato',
  error: 'Errore',
};

const APPLYING_PROGRESS: Record<ApplyingState, number> = {
  idle: 0,
  translating: 30,
  solving: 70,
  done: 100,
  unsupported: 100,
  error: 100,
};

export function WhatIfAnalysis({
  slug,
  solution,
  kpis,
  consultationMd,
  dataSchemaMd,
  liveSolutionMap,
  priorRules,
  onAcceptResult,
  originalBackendResult,
  onClearPriorRules,
}: WhatIfAnalysisProps) {
  const [scenario, setScenario] = useState('');
  const [response, setResponse] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState<number | null>(null);

  // Apply-whatif state (SSE /api/apply-whatif).
  const [applying, setApplying] = useState<ApplyingState>('idle');
  const [translatorChange, setTranslatorChange] = useState<ConstraintChange | null>(null);
  // Wave 16.6 — reason surfaced when the interpreter REJECTS the scenario (entity
  // off the plan's closed set / non-catalog). That path emits aborted_unsupported
  // with NO 'translated' event, so translatorChange stays null; we render this so
  // the manager sees WHY instead of a vanishing toast.
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null);
  const [candidateSolution, setCandidateSolution] = useState<unknown>(null);
  const [candidateKpis, setCandidateKpis] = useState<Record<string, number> | null>(null);
  const [candidateWarnings, setCandidateWarnings] = useState<string[]>([]);
  // Wave 16.6 §C — the NEW scenario's rule slot echoed on `solved`. Appended
  // to the parent's ledger on "Accetta" so the next What-If carries it.
  const [appliedRules, setAppliedRules] = useState<Record<string, unknown> | null>(null);
  const [applyCostUsd, setApplyCostUsd] = useState<number | null>(null);

  // Wave 7 — telemetry from BFF Wave 7 SSE contract.
  const [lockedCount, setLockedCount] = useState<number | null>(null);
  const [modifiedCount, setModifiedCount] = useState<number | null>(null);
  const [skippedRulesCount, setSkippedRulesCount] = useState<number | null>(null);
  const [frozenCount, setFrozenCount] = useState<number | null>(null);
  const [intentId, setIntentId] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<'A' | 'B' | 'C' | 'unsupported' | null>(null);
  const [solverCutoffMin, setSolverCutoffMin] = useState<number | null>(null);
  const [targetMachineId, setTargetMachineId] = useState<string | null>(null);
  // Wave 7 — soft-relax recovery state + dataset modification audit trail.
  const [lockRelaxed, setLockRelaxed] = useState<boolean>(false);
  const [datasetOverridesSummary, setDatasetOverridesSummary] = useState<string[]>([]);
  // Wave 7 — detailed list of phases frozen by the frozen-window builder.
  // Each entry matches FrozenPhase shape (commessa, operazione, macchina,
  // start_min, end_min); BFF also includes redundant audit fields (job_id,
  // seq, machine_id, worker_id) but the UI ignores them.
  const [lockedPhases, setLockedPhases] = useState<FrozenPhase[]>([]);

  // Wave 16.2 — GRAY_ZONE: BFF requests manager confirmation before applying.
  const [grayZoneConfirmation, _setGrayZoneConfirmation] = useState<GrayZoneConfirmationState | null>(null);
  // Ref mirrors state so useCallback closures can read the current value without
  // re-declaring deps (avoids the stale-closure race documented in DRIFT-A/B).
  const grayZoneRef = useRef<GrayZoneConfirmationState | null>(null);
  const setGrayZoneConfirmation = useCallback((v: GrayZoneConfirmationState | null) => {
    grayZoneRef.current = v;
    _setGrayZoneConfirmation(v);
  }, []);

  // Wave 7 — cutoff selector: from when should the solver recompute?
  // Default +30 min cushion to avoid disturbing phases about to start.
  type CushionPreset = 0 | 30 | 60 | 'custom';
  const [cushionPreset, setCushionPreset] = useState<CushionPreset>(30);
  // Pre-computed ISO so the datetime-local input has a sane initial value
  // (now + 30 min, rounded to the local minute).
  const defaultCustomDt = useMemo(() => {
    const d = new Date(Date.now() + 30 * 60_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, []);
  const [customDatetime, setCustomDatetime] = useState<string>(defaultCustomDt);

  const abortRef = useRef<AbortController | null>(null);
  const applyAbortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const responseRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  const planReady = !!solution && Object.keys(kpis).length > 0;
  const tooLong = scenario.length > MAX_SCENARIO_CHARS;
  const tooShort = scenario.trim().length < 5;
  const applyInFlight = applying === 'translating' || applying === 'solving';
  // Show the "Esegui" CTA only when a non-empty analysis is on screen and nothing is in-flight.
  const canApply = !!response && !streaming && !error && !applyInFlight;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [scenario]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      applyAbortRef.current?.abort();
    };
  }, []);

  // Reset the apply-side state when the analysis text changes (new scenario → stale candidate).
  const resetApplyState = useCallback(() => {
    setApplying('idle');
    setTranslatorChange(null);
    setUnsupportedReason(null);
    setCandidateSolution(null);
    setCandidateKpis(null);
    setCandidateWarnings([]);
    setAppliedRules(null);
    setApplyCostUsd(null);
    setLockedCount(null);
    setModifiedCount(null);
    setSkippedRulesCount(null);
    setFrozenCount(null);
    setIntentId(null);
    setStrategy(null);
    setSolverCutoffMin(null);
    setTargetMachineId(null);
    setLockRelaxed(false);
    setDatasetOverridesSummary([]);
    setLockedPhases([]);
  }, []);

  const runWhatIf = useCallback(async () => {
    if (!planReady || tooLong || tooShort || streaming || !slug) return;

    abortRef.current?.abort();
    applyAbortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setResponse('');
    setError(null);
    setCostUsd(null);
    resetApplyState();
    setStreaming(true);

    try {
      const stream = sseStream<ChunkPayload | DonePayload | ErrorPayload>(
        '/api/whatif',
        {
          slug,
          solution,
          kpis,
          consultationMd,
          dataSchemaMd,
          scenario: scenario.trim(),
        },
        controller.signal,
      );

      for await (const { event, data } of stream) {
        if (event === 'chunk') {
          const t = (data as ChunkPayload).text;
          if (typeof t === 'string') setResponse((prev) => prev + t);
        } else if (event === 'done') {
          const d = data as DonePayload;
          if (d.cost_usd != null) setCostUsd(d.cost_usd);
        } else if (event === 'error') {
          const e = data as ErrorPayload;
          const errorObj = new Error(e.message ?? 'Errore sconosciuto dal server.') as Error & { code?: string };
          errorObj.code = e.code;
          throw errorObj;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setStreaming(false);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string })?.code;
      const friendly = friendlyErrorMessage({ code, message: msg }) ?? msg;
      setError(friendly);
      toast.error(`What-If: ${friendly}`);
    }
    setStreaming(false);
    abortRef.current = null;
  }, [slug, solution, kpis, consultationMd, dataSchemaMd, scenario, planReady, tooLong, tooShort, streaming, resetApplyState]);

  // Wave 7 — derive cutoff parameters from the current selector state.
  // `currentTimeMin` is baseline-relative ("now" expressed in minutes from
  // the planning horizon start). If `consultationMd` does not surface a
  // start datetime we fall back to 0 — the BFF can override or skip the
  // lock if `currentTimeMin === 0` (acts as a no-op cushion).
  const baselineStartMs = useMemo(() => {
    if (!consultationMd) return null;
    // Conservative regex: look for an ISO datetime under a "start" / "inizio"
    // labelled field. The fallback path (return null → currentTimeMin = 0)
    // is intentional — see plan §4 teammate notes.
    const m = consultationMd.match(
      /(?:start_dt|start_datetime|inizio[_\s]?orizzonte|horizon[_\s]?start)[^\dT]*?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/i,
    );
    if (!m) return null;
    const t = Date.parse(m[1]);
    return Number.isFinite(t) ? t : null;
  }, [consultationMd]);

  // Wave 7 BFF contract:
  //   - Now → currentTimeMin = <now>, cushionMin = 0
  //   - +30 → currentTimeMin = <now>, cushionMin = 30
  //   - +1h → currentTimeMin = <now>, cushionMin = 60
  //   - Custom → currentTimeMin = <chosen>, cushionMin = 0
  // cutoff = currentTimeMin + cushionMin (computed by BFF).
  const computeCutoffParams = useCallback((): {
    currentTimeMin: number;
    cushionMin: number;
  } => {
    const toRelMin = (ms: number): number => {
      if (baselineStartMs === null) return 0;
      return Math.max(0, Math.round((ms - baselineStartMs) / 60_000));
    };
    if (cushionPreset === 'custom') {
      const customMs = Date.parse(customDatetime);
      const targetMs = Number.isFinite(customMs) ? customMs : Date.now();
      return { currentTimeMin: toRelMin(targetMs), cushionMin: 0 };
    }
    return { currentTimeMin: toRelMin(Date.now()), cushionMin: cushionPreset };
  }, [baselineStartMs, cushionPreset, customDatetime]);

  const runApplyWhatIfWithFlags = useCallback(async (
    flags: {
      userConfirmedGrayZone?: boolean;
      confirmedPayload?: Record<string, unknown>;
      forceOpusFallback?: boolean;
    } = {},
  ) => {
    if (!canApply || !slug || !planReady) return;
    // DRIFT-A guard: block new apply calls while the GRAY_ZONE modal is open
    // (unless this is a modal-triggered retry).
    if (
      grayZoneRef.current !== null &&
      !flags.userConfirmedGrayZone &&
      !flags.forceOpusFallback
    ) return;

    applyAbortRef.current?.abort();
    const controller = new AbortController();
    applyAbortRef.current = controller;

    setApplying('translating');
    setTranslatorChange(null);
    setUnsupportedReason(null);
    setCandidateSolution(null);
    setCandidateKpis(null);
    setCandidateWarnings([]);
    setAppliedRules(null);
    setApplyCostUsd(null);
    setLockedCount(null);
    setModifiedCount(null);
    setSkippedRulesCount(null);
    setFrozenCount(null);
    setIntentId(null);
    setStrategy(null);
    setSolverCutoffMin(null);
    setTargetMachineId(null);
    setLockRelaxed(false);
    setDatasetOverridesSummary([]);
    setLockedPhases([]);

    const { currentTimeMin, cushionMin } = computeCutoffParams();
    const managerText = scenario.trim();

    try {
      const stream = sseStream<unknown>(
        '/api/apply-whatif',
        {
          slug,
          // Wave 16.6 §C — re-solve from the RAW live solution map so the
          // applied constraints carry. `solution` (the AiInputs envelope) is
          // the wrong shape for the solver baseline (the core bug fixed here);
          // fall back to it only when the live map wasn't threaded.
          originalSolution: liveSolutionMap ?? solution,
          kpis,
          whatifText: response,
          consultationMd,
          dataSchemaMd,
          // Wave 7 — raw manager utterance activates Haiku intent parser
          // path. Without it the BFF falls back to Wave 4.1 Strategy C.
          ...(managerText ? { managerText } : {}),
          // Wave 7 — cutoff window for hard-lock of pre-cutoff phases.
          currentTimeMin,
          cushionMin,
          // Wave 16.6 §C — cumulative ledger of prior-accepted constraints,
          // merged new-wins with this scenario by the BFF before the solve.
          ...(priorRules && Object.keys(priorRules).length > 0 ? { priorRules } : {}),
          // Wave 16.3 — GRAY_ZONE retry flags (accepted by BFF BodySchema).
          ...(flags.userConfirmedGrayZone ? { userConfirmedGrayZone: true } : {}),
          ...(flags.confirmedPayload ? { confirmedPayload: flags.confirmedPayload } : {}),
          ...(flags.forceOpusFallback ? { forceOpusFallback: true } : {}),
        },
        controller.signal,
      );

      for await (const { event, data } of stream) {
        if (event === 'requires_confirmation') {
          // Wave 16.3 — BFF paused before solving; manager must confirm.
          // Stream ends after this event (done follows, no solved).
          const payload = data as {
            confirmationMessage?: string;
            confidence?: 'high' | 'medium' | 'low';
            confirmedPayload?: Record<string, unknown>;
          } | null;
          setGrayZoneConfirmation({
            confirmationMessage:
              payload?.confirmationMessage ?? "Confermi l'interpretazione?",
            confidence:
              payload?.confidence === 'high' ? 0.85
              : payload?.confidence === 'medium' ? 0.55
              : payload?.confidence === 'low' ? 0.25
              : undefined,
            confirmedPayload: payload?.confirmedPayload ?? {},
          });
          setApplying('idle');
          return;
        } else if (event === 'parsing_intent') {
          // Wave 7 path activated — Haiku is classifying the intent.
          setApplying('translating');
        } else if (event === 'intent_parsed') {
          // Wave 7 — Haiku intent classification result.
          const payload = data as {
            intent_id?: string;
            entities?: { machine_id?: string; start_min?: number; end_min?: number } | null;
          } | null;
          if (payload?.intent_id) setIntentId(payload.intent_id);
          const m = payload?.entities?.machine_id;
          if (typeof m === 'string' && m.trim()) setTargetMachineId(m.trim());
        } else if (event === 'routed') {
          // Wave 7 — strategy router decision (A / B / C / unsupported).
          const payload = data as {
            strategy?: 'A' | 'B' | 'C' | 'unsupported';
            intent_id?: string;
          } | null;
          if (payload?.strategy) setStrategy(payload.strategy);
          if (payload?.intent_id && !intentId) setIntentId(payload.intent_id);
        } else if (event === 'translating') {
          // Wave 4.1 fallback path (no managerText).
          setApplying('translating');
        } else if (event === 'translated') {
          const payload = data as { change?: ConstraintChange };
          if (payload?.change) setTranslatorChange(payload.change);
        } else if (event === 'aborted_unsupported') {
          const payload = data as ApplyAbortedUnsupportedPayload;
          setApplying('unsupported');
          setUnsupportedReason(payload.reason ?? null);
          toast.warning(`Scenario non applicabile: ${humanizeUnsupportedReason(payload.reason)}`);
          // 'done' is still expected after this, but we do not transition out of 'unsupported'.
        } else if (event === 'solving') {
          // Only advance to 'solving' if we are not already in a terminal state.
          setApplying((prev) => (prev === 'translating' ? 'solving' : prev));
        } else if (event === 'lock_relaxing') {
          // Wave 7 — backend was INFEASIBLE with hard-lock; BFF is
          // retrying without the frozen phases. Surface a non-modal
          // toast so the manager knows production-pre-cutoff might move.
          const payload = data as {
            reason?: string;
            frozen_count?: number;
            attempted_locks?: number;
            attempted_rules?: number;
          } | null;
          setLockRelaxed(true);
          const frozenN = typeof payload?.frozen_count === 'number' ? payload.frozen_count : 0;
          const attemptedLocks =
            typeof payload?.attempted_locks === 'number' ? payload.attempted_locks : null;
          const attemptedRules =
            typeof payload?.attempted_rules === 'number' ? payload.attempted_rules : null;
          // Build the diagnostic suffix only when the BFF actually
          // reported the counters (backend pre-bba231a omitted them).
          let detail = '';
          if (attemptedLocks !== null || attemptedRules !== null) {
            const parts: string[] = [];
            if (attemptedLocks !== null) {
              parts.push(`${attemptedLocks} lock`);
            }
            if (attemptedLocks === null && frozenN > 0) {
              parts.push(`${frozenN} fasi`);
            }
            if (attemptedRules !== null && attemptedRules > 0) {
              parts.push(`${attemptedRules} regol${attemptedRules === 1 ? 'a' : 'e'} dinamic${attemptedRules === 1 ? 'a' : 'he'}`);
            }
            detail = parts.length > 0 ? ` (tentati ${parts.join(' + ')})` : '';
          } else if (frozenN > 0) {
            detail = ` (${frozenN} fasi)`;
          }
          toast.warning(
            `Vincolo iniziale infeasible — ritento senza lock pre-cutoff${detail}.`,
          );
        } else if (event === 'solved') {
          const payload = data as ApplySolvedPayload;
          setCandidateSolution(payload.newSolution ?? null);
          setCandidateKpis(payload.newKpis ?? null);
          setCandidateWarnings(Array.isArray(payload.warnings) ? payload.warnings : []);
          // Wave 16.6 §C — the NEW scenario's rule delta to ledger on accept.
          if (payload.applied_rules && typeof payload.applied_rules === 'object') {
            setAppliedRules(payload.applied_rules as Record<string, unknown>);
          }
          // Wave 7 telemetry on `solved` payload (per BFF contract: always present).
          if (typeof payload.locked_count === 'number') setLockedCount(payload.locked_count);
          if (typeof payload.modified_count === 'number') setModifiedCount(payload.modified_count);
          if (typeof payload.skipped_rules_count === 'number') {
            setSkippedRulesCount(payload.skipped_rules_count);
          }
          if (typeof payload.frozen_count === 'number') setFrozenCount(payload.frozen_count);
          if (typeof payload.cutoff_min === 'number') setSolverCutoffMin(payload.cutoff_min);
          if (payload.strategy) setStrategy(payload.strategy);
          if (Array.isArray(payload.dataset_overrides_summary)) {
            setDatasetOverridesSummary(payload.dataset_overrides_summary);
          }
          if (Array.isArray(payload.locked_phases)) {
            setLockedPhases(payload.locked_phases);
          }
        } else if (event === 'done') {
          const d = data as DonePayload;
          if (d.cost_usd != null) setApplyCostUsd(d.cost_usd);
          setApplying((prev) => (prev === 'unsupported' ? 'unsupported' : 'done'));
        } else if (event === 'aborted') {
          setApplying('idle');
        } else if (event === 'error') {
          const e = data as ErrorPayload;
          const errorObj = new Error(e.message ?? 'Errore sconosciuto dal server.') as Error & { code?: string };
          errorObj.code = e.code;
          throw errorObj;
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setApplying('idle');
        return;
      }
      const httpErr = err as Error & { status?: number; code?: string };
      const msg = httpErr.message ?? String(err);
      setApplying('error');
      if (httpErr.status === 429 || httpErr.code === 'rate_limited') {
        toast.error('Limite 5 ricalcoli/ora superato. Riprova fra un po’.');
      } else if (httpErr.code === 'slug_conflict') {
        toast.error(
          'Un altro manager sta gia ricalcolando il piano per questa azienda — riprova quando finisce.',
        );
      } else if (httpErr.status === 409 || httpErr.code === 'conflict') {
        toast.error('C’è già un ricalcolo in corso per questa sessione.');
      } else {
        const friendly = friendlyErrorMessage({ code: httpErr.code, message: msg }) ?? msg;
        toast.error(`Esegui: ${friendly}`);
      }
    }
    applyAbortRef.current = null;
  }, [canApply, slug, planReady, solution, liveSolutionMap, priorRules, kpis, response, scenario, consultationMd, dataSchemaMd, computeCutoffParams, intentId, setGrayZoneConfirmation]);

  const runApplyWhatIf = useCallback(() => {
    return runApplyWhatIfWithFlags();
  }, [runApplyWhatIfWithFlags]);

  // Wave 16.3 — GRAY_ZONE modal handlers.
  // BFF has paused before solving; stream has ended. Each action re-calls.
  const handleGrayZoneConfirm = useCallback(() => {
    const gz = grayZoneRef.current;
    if (!gz) return;
    setGrayZoneConfirmation(null);
    void runApplyWhatIfWithFlags({
      userConfirmedGrayZone: true,
      confirmedPayload: gz.confirmedPayload,
    });
  }, [runApplyWhatIfWithFlags, setGrayZoneConfirmation]);

  const handleGrayZoneOpus = useCallback(() => {
    if (!grayZoneRef.current) return;
    setGrayZoneConfirmation(null);
    void runApplyWhatIfWithFlags({ forceOpusFallback: true });
  }, [runApplyWhatIfWithFlags, setGrayZoneConfirmation]);

  const handleGrayZoneCancel = useCallback(() => {
    setGrayZoneConfirmation(null);
    setApplying('idle');
  }, [setGrayZoneConfirmation]);

  const cancelApply = useCallback(() => {
    applyAbortRef.current?.abort();
    applyAbortRef.current = null;
    setApplying('idle');
  }, []);

  const handleDiscardCandidate = useCallback(() => {
    resetApplyState();
  }, [resetApplyState]);

  const handleAcceptCandidate = useCallback(async () => {
    // Wave 16.5 A3 — accept the candidate as the new dashboard plan.
    //
    // The apply-whatif `solved` event only carries solution+kpis. But
    // `adaptResult` (deterministic-json path) reads time_config (wall-clock
    // labels), maintenance (down-day shading) and operator_config (operator
    // shifts) off the result root. Those live only on the ORIGINAL backend
    // envelope. So we merge the candidate's solution+kpis over the original
    // full envelope — the result is a shape `adaptResult` consumes whole,
    // and the Gantt / KPI cards / OperationalPlan all refresh to the
    // candidate (Wave 16.4 A7 fed it only solution+kpis → degraded render).
    if (!candidateSolution || !candidateKpis || !slug) {
      toast.error('Nessuna soluzione candidate da accettare.');
      return;
    }

    // Wave 16.6 §D — defence-in-depth: never swap in a phase-less candidate.
    // The §D empty-solution guard already converts a zero-phase solve into
    // aborted_unsupported (so we should never reach accept with one), but a
    // belt-and-braces check here keeps the Gantt from blanking even if a
    // future code path bypasses the guard. Counts both the nested
    // `{commessa:{fasi:[]}}` map and a flat top-level `fasi[]`.
    const countPhases = (sol: unknown): number => {
      if (!sol || typeof sol !== 'object') return 0;
      const root = sol as Record<string, unknown>;
      if (Array.isArray(root.fasi)) return root.fasi.length;
      let n = 0;
      for (const job of Object.values(root)) {
        const fasi = job && typeof job === 'object' ? (job as { fasi?: unknown }).fasi : null;
        if (Array.isArray(fasi)) n += fasi.length;
      }
      return n;
    };
    if (countPhases(candidateSolution) === 0) {
      toast.error('Soluzione candidate vuota — niente da applicare.');
      return;
    }

    const base =
      originalBackendResult && typeof originalBackendResult === 'object'
        ? (originalBackendResult as Record<string, unknown>)
        : {};
    const merged: Record<string, unknown> = {
      ...base,
      // Swap in the candidate plan; keep status OPTIMAL so the header badge
      // and adaptResult treat it as a solved plan.
      status: 'OPTIMAL',
      solution: candidateSolution,
      kpis: candidateKpis,
      warnings: candidateWarnings,
    };

    // Hand the merged plan to the parent FIRST so the dashboard refreshes
    // even if the audit echo below fails (the candidate is already valid).
    // Wave 16.6 §C — pass the NEW scenario's rule delta so the parent appends
    // it to the ledger; the next What-If then re-applies it.
    onAcceptResult?.(merged, appliedRules ?? undefined);
    resetApplyState();
    toast.success('Piano aggiornato con il candidate.');

    // Fire-and-forget audit echo to the BFF (telemetry parity with
    // apply-whatif). A failure here must NOT roll back the dashboard.
    try {
      await fetch('/api/accept-candidate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug,
          candidateSolution,
          candidateKpis,
          warnings: candidateWarnings,
          intentId: intentId ?? undefined,
          strategy: strategy === 'A' || strategy === 'B' || strategy === 'C' ? strategy : undefined,
        }),
      });
    } catch {
      // Audit-only; swallow. The plan already updated client-side.
    }
  }, [
    slug,
    candidateSolution,
    candidateKpis,
    candidateWarnings,
    appliedRules,
    intentId,
    strategy,
    onAcceptResult,
    originalBackendResult,
    resetApplyState,
  ]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void runWhatIf();
    }
  };

  const handleCopy = useCallback(() => {
    if (!response) return;
    void navigator.clipboard.writeText(response)
      .then(() => toast.success('Copiato'))
      .catch(() => toast.error('Impossibile copiare'));
  }, [response]);

  const handleRetry = useCallback(() => {
    void runWhatIf();
  }, [runWhatIf]);

  const sectionAriaLabel = streaming ? 'Analisi in corso' : 'Analisi What-If';
  const applyProgress = APPLYING_PROGRESS[applying];
  const applyLabel = APPLYING_LABEL[applying];

  if (!planReady) {
    return null;
  }

  const showCandidateDiff =
    applying === 'done' &&
    candidateSolution !== null &&
    candidateKpis !== null;

  const confidence = translatorChange?.confidence ?? null;
  const showLowConfidenceBanner =
    confidence !== null && confidence !== 'high' && showCandidateDiff;

  // Wave 16.6 (Option A) — the constraints carried in from prior accepted
  // reschedules/what-ifs (the ledger). Surfacing them removes the "why did
  // everything slide to the next day?" surprise: the manager sees exactly
  // which previously-accepted rules are re-applied on top of this scenario.
  const inheritedConstraints = useMemo(() => describeLedgerRules(priorRules), [priorRules]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-5 w-5 text-primary" aria-hidden />
          Analisi What-If
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Scrivi uno scenario in italiano. Il sistema AI analizza impatti, trade-off e dà una raccomandazione.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {inheritedConstraints.length > 0 && (
          <div
            role="region"
            aria-label="Vincoli ereditati dal piano corrente"
            data-testid="whatif-inherited-constraints"
            className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 space-y-2"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                <Layers className="h-3.5 w-3.5" aria-hidden />
                Vincoli ereditati dal piano corrente ({inheritedConstraints.length})
              </div>
              {onClearPriorRules && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="whatif-clear-inherited"
                  onClick={onClearPriorRules}
                  disabled={applyInFlight}
                >
                  Azzera
                </Button>
              )}
            </div>
            <ul className="flex flex-wrap gap-1.5" aria-label="Elenco vincoli ereditati">
              {inheritedConstraints.map((c) => (
                <li
                  key={c}
                  className="rounded border bg-background/70 px-1.5 py-0.5 text-[11px] text-foreground"
                >
                  {c}
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-muted-foreground leading-snug">
              Questi vincoli, gia accettati in precedenza, vengono ri-applicati a questo scenario. Azzera per esplorare dal piano pulito.
            </p>
          </div>
        )}
        <div
          role="region"
          aria-label="Cutoff temporale per il ricalcolo"
          className="rounded-md border bg-muted/20 p-3 space-y-2"
          data-testid="whatif-cutoff-selector"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium">
            <Clock className="h-3.5 w-3.5 text-primary" aria-hidden />
            Da quando ricalcolare:
          </div>
          <div
            role="radiogroup"
            aria-label="Cushion temporale prima del cutoff"
            className="flex flex-wrap gap-1.5"
          >
            <Button
              type="button"
              size="sm"
              variant={cushionPreset === 0 ? 'default' : 'outline'}
              role="radio"
              aria-checked={cushionPreset === 0}
              data-testid="whatif-cutoff-now"
              onClick={() => setCushionPreset(0)}
              disabled={applyInFlight}
            >
              Adesso
            </Button>
            <Button
              type="button"
              size="sm"
              variant={cushionPreset === 30 ? 'default' : 'outline'}
              role="radio"
              aria-checked={cushionPreset === 30}
              data-testid="whatif-cutoff-30m"
              onClick={() => setCushionPreset(30)}
              disabled={applyInFlight}
            >
              +30 min
            </Button>
            <Button
              type="button"
              size="sm"
              variant={cushionPreset === 60 ? 'default' : 'outline'}
              role="radio"
              aria-checked={cushionPreset === 60}
              data-testid="whatif-cutoff-1h"
              onClick={() => setCushionPreset(60)}
              disabled={applyInFlight}
            >
              +1 h
            </Button>
            <Button
              type="button"
              size="sm"
              variant={cushionPreset === 'custom' ? 'default' : 'outline'}
              role="radio"
              aria-checked={cushionPreset === 'custom'}
              data-testid="whatif-cutoff-custom"
              onClick={() => setCushionPreset('custom')}
              disabled={applyInFlight}
            >
              Personalizza
            </Button>
          </div>
          {cushionPreset === 'custom' && (
            <div className="flex items-center gap-2">
              <label
                htmlFor="whatif-cutoff-input"
                className="text-xs text-muted-foreground shrink-0"
              >
                Cutoff:
              </label>
              <input
                id="whatif-cutoff-input"
                type="datetime-local"
                value={customDatetime}
                onChange={(e) => setCustomDatetime(e.target.value)}
                disabled={applyInFlight}
                data-testid="whatif-cutoff-input"
                aria-label="Data e ora cutoff personalizzato"
                className="flex-1 rounded-md border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
              />
            </div>
          )}
          <p className="text-[10px] text-muted-foreground leading-snug">
            Le fasi gia in produzione prima del cutoff restano invariate (lock duro).
          </p>
        </div>

        <div>
          <textarea
            ref={textareaRef}
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Esempio: 'Posso fermare la linea 2 oggi dalle 14 alle 18, conviene?'"
            disabled={streaming}
            rows={3}
            maxLength={MAX_SCENARIO_CHARS + 50}
            aria-label="Scenario What-If"
            className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
          />
          <div className="mt-1.5 flex items-center justify-between text-xs">
            <span className={tooLong ? 'text-destructive font-medium' : 'text-muted-foreground'} aria-live="polite">
              {scenario.length}/{MAX_SCENARIO_CHARS}
              {tooLong && ' — troppo lungo'}
            </span>
            <Button
              size="sm"
              onClick={() => void runWhatIf()}
              disabled={streaming || tooLong || tooShort}
              data-testid="whatif-analyze"
            >
              <Send className="h-3.5 w-3.5 mr-1.5" aria-hidden />
              {streaming ? 'Analisi…' : 'Analizza scenario'}
            </Button>
          </div>
        </div>

        {!response && !streaming && !error && (
          <div className="rounded-md border border-dashed bg-muted/30 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Lightbulb className="h-3.5 w-3.5" aria-hidden />
              Scenari di esempio
            </div>
            <ul className="text-xs space-y-1">
              {EXAMPLES.map((ex, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => setScenario(ex)}
                    disabled={streaming}
                    className="text-left text-primary hover:underline disabled:opacity-50"
                  >
                    {ex}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(streaming || response || error) && (
          <div
            role="region"
            aria-label={sectionAriaLabel}
            aria-live="polite"
            className="rounded-md border bg-muted/20"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <span className="text-xs font-medium">
                {streaming ? '🧠 Il sistema AI sta analizzando…' : 'Analisi'}
              </span>
              <div className="flex items-center gap-1">
                {!streaming && response && (
                  <>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleCopy} aria-label="Copia">
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleRetry} aria-label="Rigenera">
                      <RotateCw className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </>
                )}
              </div>
            </div>
            <ScrollArea className="h-[480px]">
              <div ref={responseRef} className="p-3 text-sm whitespace-pre-wrap break-words leading-relaxed">
                {response || (streaming ? '' : '')}
                {streaming && (
                  reducedMotion ? null : <span className="ml-0.5 inline-block animate-pulse">▋</span>
                )}
                {error && (
                  <div role="alert" className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
                    <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" aria-hidden />
                    <span className="text-xs">{error}</span>
                  </div>
                )}
              </div>
            </ScrollArea>
            {!streaming && costUsd != null && (
              <div className="px-3 py-2 border-t text-[10px] text-muted-foreground">
                Costo: ${costUsd.toFixed(4)}
              </div>
            )}
          </div>
        )}

        {canApply && (
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              onClick={() => void runApplyWhatIf()}
              data-testid="whatif-apply"
              className="bg-primary hover:bg-primary/90"
            >
              <Wand2 className="h-3.5 w-3.5 mr-1.5" aria-hidden />
              Esegui ottimizzazione con questo vincolo
            </Button>
          </div>
        )}

        {(applyInFlight || applying === 'done' || applying === 'unsupported' || applying === 'error') && (
          <div
            className="rounded-md border bg-muted/20 p-3 space-y-2"
            data-testid="whatif-apply-status"
            data-state={applying}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium" aria-live="polite">
                {applyLabel}
              </span>
              {applyInFlight && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={cancelApply}
                  data-testid="whatif-apply-cancel"
                  aria-label="Annulla esecuzione"
                >
                  <XIcon className="h-3.5 w-3.5 mr-1" aria-hidden />
                  Annulla
                </Button>
              )}
            </div>
            <Progress
              value={applyProgress}
              role="progressbar"
              aria-valuenow={applyProgress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={applyLabel || 'Stato esecuzione what-if'}
            />
            {applying === 'unsupported' && (translatorChange?.unsupportedReason ?? unsupportedReason) && (
              <div
                className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-900 dark:text-amber-200"
                data-testid="whatif-apply-unsupported-reason"
              >
                <strong>Motivo:</strong>{' '}
                {humanizeUnsupportedReason(translatorChange?.unsupportedReason ?? unsupportedReason ?? '')}
              </div>
            )}
            {applyCostUsd != null && applying !== 'translating' && applying !== 'solving' && (
              <div className="text-[10px] text-muted-foreground">
                Costo esecuzione: ${applyCostUsd.toFixed(4)}
              </div>
            )}
          </div>
        )}

        {showLowConfidenceBanner && (
          <div
            role="note"
            className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2"
            data-testid="whatif-confidence-warning"
          >
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden />
            <span>
              Confidenza traduzione: <strong>{confidence}</strong>. Verifica il vincolo prima di accettare la nuova soluzione.
            </span>
          </div>
        )}

        {showCandidateDiff && (
          <SolutionDiff
            baseline={{ solution, kpis }}
            candidate={{
              solution: candidateSolution,
              kpis: candidateKpis ?? {},
              warnings: candidateWarnings,
            }}
            changeRationale={translatorChange?.rationale ?? ''}
            changeType={translatorChange?.type ?? intentId ?? strategy ?? 'unsupported'}
            onAccept={handleAcceptCandidate}
            onDiscard={handleDiscardCandidate}
            lockedCount={lockedCount ?? undefined}
            modifiedCount={modifiedCount ?? undefined}
            skippedRulesCount={skippedRulesCount ?? undefined}
            frozenCount={frozenCount ?? undefined}
            intentId={intentId}
            strategy={strategy}
            lockedPhases={lockedPhases}
            cutoffMin={solverCutoffMin}
            targetMachineId={targetMachineId}
            datasetOverridesSummary={datasetOverridesSummary}
            lockRelaxed={lockRelaxed}
          />
        )}
      </CardContent>

      {/* Wave 16.2 — GRAY_ZONE confirmation modal */}
      {grayZoneConfirmation && (
        <WhatIfConfirmationModal
          open={!!grayZoneConfirmation}
          confirmationMessage={grayZoneConfirmation.confirmationMessage}
          confidence={grayZoneConfirmation.confidence}
          onConfirm={handleGrayZoneConfirm}
          onUseOpus={handleGrayZoneOpus}
          onCancel={handleGrayZoneCancel}
          showRiformula={true}
        />
      )}
    </Card>
  );
}

// Default export removed — index.tsx imports the named export.
