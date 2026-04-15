/**
 * DAINO Backend API client.
 * Talks to daino-backend-cp running on localhost:8001.
 */

const API_BASE = 'http://localhost:8001';

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

export async function solveLLMOnly(slug: string): Promise<LLMOnlyResult> {
  return apiFetch('/api/public/solve-llm', {
    method: 'POST',
    body: JSON.stringify({ slug }),
  });
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
  }>('/api/public/solve-template', {
    method: 'POST',
    body: JSON.stringify({
      slug,
      problem_type: problemType ?? 'fjsp',
      ...(rules ? { rules } : {}),
    }),
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

// ── Health ───────────────────────────────────────────────────────────

export async function healthCheck(): Promise<boolean> {
  try {
    await apiFetch('/api/health');
    return true;
  } catch {
    return false;
  }
}
