/**
 * DAINO Backend API client.
 * Talks to daino-backend-definitivo via VITE_API_BASE_URL (default localhost:8001).
 */

const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:8001';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || `API error ${res.status}`);
  }
  return res.json();
}

// ── Types ────────────────────────────────────────────────────────────

export interface CompanySummary {
  slug: string;
  name: string;
  has_consultation: boolean;
  summary: string;
  data_files: string[];
}

export interface CompanyDetail {
  slug: string;
  name: string;
  consultation_md: string;
  data_files: string[];
  has_consultation: boolean;
}

export interface LLMOnlyResult {
  status: string;
  method: string;
  result: {
    piano: Array<{
      commessa: string;
      operazione: string;
      macchina: string;
      operatore: string;
      inizio: string;
      fine: string;
      setup_min: number;
      lavorazione_min: number;
    }>;
    kpi: Record<string, number>;
    narrative: string;
  };
  cost_usd: number;
}

export interface PipelineStateResponse {
  session_id: string;
  run_id: number;
  state: string;
  step?: number;
  total_steps?: number;
  step_label?: string;
  waiting_for_manager: boolean;
  manager_options: string[];
  can_undo?: boolean;
  message?: string;
}

export interface PipelineResults {
  session_id: string;
  run_id: number;
  state: string;
  narrative: string;
  solution: Record<string, unknown>;
  generated_code: string;
  timings: Record<string, number>;
  cost_usd: number;
}

// ── Auth (for pipeline/template endpoints that need JWT) ─────────────

let _token: string | null = null;

export async function login(tenantSlug: string, username: string, password: string) {
  const res = await apiFetch<{ access_token: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ tenant_slug: tenantSlug, username, password }),
  });
  _token = res.access_token;
  return res;
}

function authHeaders(): Record<string, string> {
  if (!_token) return {};
  return { Authorization: `Bearer ${_token}` };
}

// ── Public endpoints (no auth) ───────────────────────────────────────

export async function listCompanies(): Promise<CompanySummary[]> {
  return apiFetch('/api/public/companies');
}

export async function getCompany(slug: string): Promise<CompanyDetail> {
  return apiFetch(`/api/public/company/${slug}`);
}

// /api/public/solve-llm was removed from the backend on 2026-05-18.
// We redirect to /api/public/solve-template and adapt the FJSP-shaped
// response into the legacy LLMOnlyResult shape so existing callers
// (OptimizationLoader, resultAdapter.adaptLLMOnly) keep working unchanged.
// The backend supports multiple problem types (fjsp | jssp | flow_shop |
// staff_rostering | workforce); we sniff the type from the company's
// consultation.md ("## Tipo problema: <value>") and fall back to 'fjsp'.
const _PROBLEM_TYPES = ['fjsp', 'jssp', 'flow_shop', 'staff_rostering', 'workforce'] as const;
type ProblemType = typeof _PROBLEM_TYPES[number];

async function detectProblemType(slug: string): Promise<ProblemType> {
  try {
    const detail = await getCompany(slug);
    const md = detail.consultation_md ?? '';
    const m = md.match(/^##\s*Tipo problema:\s*([a-z_]+)/im);
    if (m) {
      const t = m[1].toLowerCase();
      if ((_PROBLEM_TYPES as readonly string[]).includes(t)) return t as ProblemType;
    }
  } catch {
    // fall through to default
  }
  return 'fjsp';
}

export async function solveLLMOnly(slug: string): Promise<LLMOnlyResult> {
  const problemType = await detectProblemType(slug);
  const tpl = await solveTemplate(slug, problemType, {});
  const solution = (tpl.solution ?? {}) as Record<string, {
    fasi?: Array<{
      operazione: string;
      macchina: string;
      operatore: string;
      setup_min?: number;
      processing_min?: number;
      start_min?: number;
      end_min?: number;
      start_datetime?: string;
      end_datetime?: string;
    }>;
  }>;
  const piano: LLMOnlyResult['result']['piano'] = [];
  for (const [commessa, job] of Object.entries(solution)) {
    for (const fase of job.fasi ?? []) {
      piano.push({
        commessa,
        operazione: fase.operazione,
        macchina: fase.macchina,
        operatore: fase.operatore,
        inizio: fase.start_datetime ?? String(fase.start_min ?? 0),
        fine: fase.end_datetime ?? String(fase.end_min ?? 0),
        setup_min: fase.setup_min ?? 0,
        lavorazione_min: fase.processing_min ?? 0,
      });
    }
  }
  return {
    status: tpl.status,
    method: 'llm-only',
    result: {
      piano,
      kpi: tpl.kpis ?? {},
      narrative: '',
    },
    cost_usd: tpl.cost_usd ?? 0,
  };
}

export async function solveTemplate(slug: string, problemType?: string, rules?: Record<string, unknown>) {
  return apiFetch<{
    status: string;
    method: string;
    solution: Record<string, unknown>;
    kpis: Record<string, number>;
    objective_value: number;
    warnings: string[];
    cost_usd: number;
    // Wave 16.4 C1 — optional plan_memory handles so the dashboard can
    // call /api/analysis/{sid}/reschedule. Tolerated absent for the
    // BE rollout window where the field is not yet populated.
    session_id?: string | null;
    run_id?: number | null;
  }>('/api/public/solve-template', {
    method: 'POST',
    body: JSON.stringify({
      slug,
      problem_type: problemType ?? 'fjsp',
      ...(rules ? { rules } : {}),
    }),
  });
}

// Wave 4.1 — what-if apply path. Identical wire payload to solveTemplate
// but exposes an explicit signature where problem_type is required so the
// BFF route doesn't accidentally fall back to 'fjsp' when the caller
// already detected the company's problem type.
//
// Wave 7 extension (2026-05-22): three optional params land on the same
// /api/public/solve-template body — the backend's w7-backend-engineer
// has wired the following additive fields:
//   - cutoff_min: int   — pre-cutoff phases are hard-locked (model.Add ==)
//   - frozen_phases: list[dict] — explicit list to lock (see FrozenPhase)
//   - dataset_overrides: dict | null — merged into `data` before solve
// All three are optional with null/no-op defaults; legacy callers (no
// Wave 7 args) get identical behaviour to Wave 4.1.
export interface ResolveTemplateFrozenPhase {
  job_id: string;
  seq: number;
  start_min: number;
  end_min: number;
  machine_id: string;
  worker_id: string;
  // Debug aliases kept on the wire so backend logs are self-describing.
  commessa?: string;
  operazione?: string;
  operatore?: string;
}

/** Wave 7 envelope returned by /api/public/solve-template when any of
 * cutoff_min/frozen_phases/dataset_overrides was supplied. `null` when the
 * caller did not opt into Wave 7 — distinguish "did not run wave7" (null)
 * from "ran with zero locks" (locked_count === 0). */
export interface ResolveTemplateWave7Envelope {
  cutoff_min: number | null;
  locked_count: number;
  frozen_phases: Array<Record<string, unknown>>;
  apply_rules: Array<Record<string, unknown>>;
}

export interface ResolveTemplateResponse {
  status: string;
  method: string;
  solution: Record<string, unknown>;
  kpis: Record<string, number>;
  objective_value: number;
  warnings: string[];
  cost_usd: number;
  wave7?: ResolveTemplateWave7Envelope | null;
}

/**
 * Wave 9 F-W8-06 OPT 1: how the backend should treat `frozen_phases`.
 *   - 'hard' (default): `model.Add(start_var == fp.start_min)` — pin the
 *     phase exactly to its consolidated slot. Returns INFEASIBLE when the
 *     new constraint clashes with the lock.
 *   - 'hint': `model.AddHint(start_var, fp.start_min)` — bias the solver
 *     toward the consolidated slot but allow it to move the phase when
 *     necessary. Used by the BFF's INFEASIBLE-retry path so consolidated
 *     phases are preserved as a soft preference instead of being dropped
 *     wholesale (the Wave 8 Opt 2 fallback).
 *
 * Sent on the wire as the `frozen_lock_mode` field; omitted from the body
 * when undefined so legacy backends still receive the Wave 7 shape.
 */
export type FrozenLockMode = 'hard' | 'hint';

export async function resolveTemplate(
  slug: string,
  problemType: string,
  rules: Record<string, unknown>,
  cutoffMin?: number,
  frozenPhases?: ResolveTemplateFrozenPhase[],
  datasetOverrides?: Record<string, unknown> | null,
  frozenLockMode?: FrozenLockMode,
  forceColdStart?: boolean,
): Promise<ResolveTemplateResponse> {
  const body: Record<string, unknown> = {
    slug,
    problem_type: problemType,
    rules,
  };
  if (cutoffMin !== undefined && Number.isFinite(cutoffMin) && cutoffMin > 0) {
    body.cutoff_min = cutoffMin;
  }
  if (frozenPhases && frozenPhases.length > 0) {
    body.frozen_phases = frozenPhases;
  }
  if (datasetOverrides && Object.keys(datasetOverrides).length > 0) {
    body.dataset_overrides = datasetOverrides;
  }
  // F-W8-06 Wave 9 OPT 1: only forward `frozen_lock_mode` when the caller
  // explicitly asked for it. Legacy callers (and the first-solve path in
  // apply-whatif) keep the wire shape unchanged so the backend defaults
  // to hard-lock semantics.
  if (frozenLockMode !== undefined) {
    body.frozen_lock_mode = frozenLockMode;
  }
  // F-W10-07 — when forceColdStart=true, the backend bypasses the L2
  // warm-start loader so the previous OPTIMAL/FEASIBLE plan (saved in
  // plan_memory/last_plan.json) does NOT inject hints into this solve.
  // apply-whatif sets this on every call (first + retry) because each
  // what-if is a fresh constraint set — warm-starting from the old plan
  // can bias the search toward a now-stale schedule and slow down
  // CP-SAT or cause spurious MODEL_INVALIDs (see wave10 finding).
  if (forceColdStart) {
    body.force_cold_start = true;
  }
  return apiFetch<ResolveTemplateResponse>('/api/public/solve-template', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

// ── Pipeline endpoints (need auth) ──────────────────────────────────

export async function pipelineStart(
  companyName: string,
  description: string,
  solverMethod: string = 'compose',
): Promise<PipelineStateResponse> {
  const form = new FormData();
  form.append('company_name', companyName);
  form.append('description', description);
  form.append('solver_method', solverMethod);
  const res = await fetch(`${API_BASE}/api/analysis/start`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw new Error(`Pipeline start failed: ${res.status}`);
  return res.json();
}

export async function pipelineAdvance(sessionId: string): Promise<PipelineStateResponse> {
  return apiFetch(`/api/analysis/${sessionId}/advance`, {
    method: 'POST',
    headers: authHeaders(),
  });
}

export async function pipelineRespond(sessionId: string, answer: string): Promise<PipelineStateResponse> {
  return apiFetch(`/api/analysis/${sessionId}/respond`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ answer }),
  });
}

export async function pipelineResults(sessionId: string): Promise<PipelineResults> {
  return apiFetch(`/api/analysis/${sessionId}/results`, {
    headers: authHeaders(),
  });
}

// ── Template/deterministic endpoints (need auth) ────────────────────

export async function optimizeShifts(month: string, strategy?: string) {
  return apiFetch('/api/optimize-shifts', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ month, ...(strategy ? { strategy } : {}) }),
  });
}

export async function getRun(runId: number) {
  return apiFetch(`/api/runs/${runId}`, { headers: authHeaders() });
}

export async function autoLogin(tenantSlug: string): Promise<boolean> {
  try {
    await login(tenantSlug, 'demo', 'demo');
    return true;
  } catch {
    return false;
  }
}

// ── Smart data upload (multipart, JWT-protected) ────────────────────

export interface UploadDataResult {
  status: string;
  source?: string;
  problem_type?: string;
  preview?: unknown;
  data?: unknown;
}

// Upload a CSV/Excel for the given tenant. Always re-runs autoLogin(slug)
// because the module-level _token has no tenant identity: a stale token
// from a previous tenant would otherwise be sent and the backend (which
// derives tenant_id from the JWT, not the body) would write the file
// into the wrong tenant's run history. Backend route: POST /api/upload-data.
export async function uploadData(file: File, slug: string): Promise<UploadDataResult> {
  const ok = await autoLogin(slug);
  if (!ok) {
    throw new Error(`Login fallito per ${slug}. Impossibile caricare il file.`);
  }
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${API_BASE}/api/upload-data`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    let detail = `Upload failed (${res.status})`;
    try {
      const j = await res.json();
      if (j?.detail) detail = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch { /* ignore */ }
    throw new Error(detail);
  }
  return res.json();
}

// ── Chat reschedule (warm-start) ─────────────────────────────────────

export interface ChatRescheduleResponse {
  reply: string;
  action: 'reschedule' | 'data_query' | 'clarification' | 'infeasible' | 'error';
  status?: string;
  solution?: Record<string, unknown>;
  kpis?: Record<string, number>;
  objective_value?: number;
  warnings?: string[];
  cost_usd: number;
  rules_used?: Record<string, unknown>;
  time_config?: Record<string, unknown>;
  maintenance?: Record<string, unknown>;
  operator_config?: Record<string, unknown>;
  shift_types?: Record<string, unknown>;
  cp_sat_stats?: Record<string, unknown>;
  disruption?: { intent: string; target_id?: string; raw_message: string };
  warm_start?: Record<string, unknown>;
  trace_id?: string;
}

// /api/public/chat-reschedule was removed. The replacement is the
// authenticated /api/analysis/{session_id}/reschedule endpoint, which
// returns 501 for compose-path runs (no saved solver.py) — this is a
// known backend gap (TD-022). Callers must handle 501 gracefully.
export interface RescheduleParams {
  message: string;
  sessionId?: string | null;
  runId?: number | null;
  elapsedMin?: number;
}

export async function chatReschedule(
  slugOrParams: string | RescheduleParams,
  message?: string,
): Promise<ChatRescheduleResponse> {
  // Backward-compat: accept (slug, message) and treat slug as ignored
  // (the new endpoint scopes by JWT tenant, not by slug).
  const params: RescheduleParams = typeof slugOrParams === 'string'
    ? { message: message ?? '', sessionId: null, runId: null }
    : slugOrParams;

  // runId must be a positive integer; "0" or NaN means no usable run.
  const hasValidRun = typeof params.runId === 'number'
    && Number.isFinite(params.runId)
    && params.runId > 0;
  const hasSession = !!params.sessionId;
  if (!hasSession && !hasValidRun) {
    return {
      reply: 'Sessione non trovata. Ricarica la dashboard e riprova.',
      action: 'error',
      cost_usd: 0,
    };
  }

  // session_id is part of the URL; the endpoint accepts run_id in body
  // when no live in-memory session exists.
  const sid = params.sessionId ?? 'no-session';
  const body: Record<string, unknown> = {
    disruption: {},
    event_description: params.message,
  };
  if (hasValidRun) body.run_id = params.runId;
  if (params.elapsedMin != null) body.elapsed_min = params.elapsedMin;

  try {
    const raw = await apiFetch<Record<string, unknown>>(`/api/analysis/${sid}/reschedule`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    const err = raw.error as string | undefined;
    const status = raw.status as string | undefined;
    const action: ChatRescheduleResponse['action'] = err
      ? (status === 'INFEASIBLE' ? 'infeasible' : 'error')
      : 'reschedule';
    return {
      reply: err
        ? `Errore: ${err}`
        : `Piano ricalcolato. Stato: ${status ?? 'OK'}.`,
      action,
      status,
      solution: raw.solution as Record<string, unknown> | undefined,
      kpis: raw.kpis as Record<string, number> | undefined,
      objective_value: raw.objective_value as number | undefined,
      warnings: raw.warnings as string[] | undefined,
      cost_usd: (raw.cost_usd as number | undefined) ?? 0,
      time_config: raw.time_config as Record<string, unknown> | undefined,
      maintenance: raw.maintenance as Record<string, unknown> | undefined,
      operator_config: raw.operator_config as Record<string, unknown> | undefined,
      shift_types: raw.shift_types as Record<string, unknown> | undefined,
      cp_sat_stats: raw.cp_sat_stats as Record<string, unknown> | undefined,
      warm_start: raw.warm_start as Record<string, unknown> | undefined,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Backend returns 501 with a detail describing the gap (compose-path
    // runs have no saved solver.py). Surface a UX-friendly message.
    if (msg.includes('Reschedule non disponibile') || msg.includes('501')) {
      return {
        reply:
          'Reschedule non disponibile per questa strategia (la run è di tipo "compose": il backend '
          + 'non ha salvato il solver). Avvia una nuova ottimizzazione con strategia codegen per '
          + 'abilitare la ripianificazione, oppure rilancia un solve completo from-scratch.',
        action: 'error',
        cost_usd: 0,
      };
    }
    return { reply: `Errore: ${msg}`, action: 'error', cost_usd: 0 };
  }
}

// ── Health ───────────────────────────────────────────────────────────

export async function healthCheck(): Promise<boolean> {
  try {
    await apiFetch('/api/health');
    return true;
  } catch {
    return false;
  }
}
