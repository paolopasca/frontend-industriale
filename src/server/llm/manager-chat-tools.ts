import type Anthropic from '@anthropic-ai/sdk';
import type { SolutionContext } from '@/lib/solutionContext';
import {
  resolveMachineAlias,
  resolveOrderAlias,
  resolveAgainstSet,
} from '@/lib/entityResolver';

/**
 * Manager Chat tool definitions for Haiku 4.5 agentic loop (Wave 3).
 *
 * All tools are READ-ONLY over the in-memory `solution` + `kpis` already passed
 * to the BFF session. No network calls, no mutation, no backend dispatch.
 *
 * Threat model: tool inputs are LLM-generated and may carry prompt-injection
 * fragments (e.g. "ignore previous instructions"). We never string-template
 * input into prompts; we validate identifiers as alphanumeric + "-_" only.
 */

type Json = unknown;

interface FaseRecord {
  commessa: string;
  operazione: string;
  macchina: string;
  operatore: string;
  start_min: number;
  end_min: number;
  setup_min: number;
  processing_min: number;
  ritardo_min?: number;
  deadline_min?: number;
}

interface NormalizedSolution {
  status: string;
  fasi: FaseRecord[];
  kpis: Record<string, number>;
  warnings: string[];
  reason: string | null;
  vincoli_critici: string[];
  raw: Json;
}

export interface ManagerToolContext {
  solution: Json;
  kpis: Record<string, number>;
  /** Optional pre-normalized payload to avoid re-parsing on every tool call. */
  normalized?: NormalizedSolution;
  /**
   * Closed-set view of the plan (machines[], orders[], aliases) used to
   * canonicalize loose manager input — e.g. "m2" → "M02" — via the shared
   * entityResolver. Populated by the BFF (`runManagerChat`) from the live
   * solution. When absent (older callers / tests), tools fall back to the
   * raw sanitized id and the exact-match filter is unchanged.
   */
  solutionContext?: SolutionContext;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sanitizeId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return ID_PATTERN.test(v) ? v : null;
}

/**
 * Map a *sanitized* identifier to its canonical plan id via the shared
 * entityResolver, so loose manager input ("m2", "linea 2") matches the real
 * "M02" before the exact-match filter runs.
 *
 * SECURITY: callers MUST pass the post-`sanitizeId` value — the resolver is an
 * ergonomics layer, NOT an injection guard. If `solutionContext` is absent
 * (older callers / no live plan), or the resolver finds no canonical match,
 * we return the sanitized id unchanged so the downstream filter behaves
 * exactly as before (and yields found:false on a genuine miss).
 */
function resolveId(
  sanitized: string,
  ctx: ManagerToolContext,
  resolver: (token: string, sctx: SolutionContext) => string | null,
): string {
  const sctx = ctx.solutionContext;
  if (!sctx) return sanitized;
  const canonical = resolver(sanitized, sctx);
  return canonical ?? sanitized;
}

/** Distinct operator ids present in the plan — the closed set for operator
 *  alias resolution (operators aren't carried in SolutionContext). */
function operatorIdsOf(fasi: FaseRecord[]): string[] {
  const seen = new Set<string>();
  for (const f of fasi) if (f.operatore) seen.add(f.operatore);
  return [...seen];
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function asPositiveInt(v: unknown, fallback: number, max: number): number {
  const n = asFiniteNumber(v);
  if (n === null || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function pickFasiArray(container: Record<string, unknown>): unknown[] | null {
  for (const key of ['fasi', 'schedule', 'tasks', 'phases', 'assignments', 'piano']) {
    const v = container[key];
    if (Array.isArray(v)) return v;
  }
  return null;
}

function coerceFase(raw: unknown): FaseRecord | null {
  if (!isObject(raw)) return null;
  const commessa = asString(
    raw.commessa ?? raw.order ?? raw.job ?? raw.id ?? raw.commessa_id,
  );
  if (!commessa) return null;
  return {
    commessa,
    operazione: asString(raw.operazione ?? raw.operation ?? raw.fase ?? raw.task, ''),
    macchina: asString(raw.macchina ?? raw.machine ?? raw.machine_id, ''),
    operatore: asString(raw.operatore ?? raw.operator ?? raw.operator_id, ''),
    start_min: asFiniteNumber(raw.start_min ?? raw.start) ?? 0,
    end_min: asFiniteNumber(raw.end_min ?? raw.end) ?? 0,
    setup_min: asFiniteNumber(raw.setup_min ?? raw.setup) ?? 0,
    processing_min: asFiniteNumber(raw.processing_min ?? raw.processing) ?? 0,
    ritardo_min: asFiniteNumber(raw.ritardo_min ?? raw.delay_min) ?? undefined,
    deadline_min: asFiniteNumber(raw.deadline_min ?? raw.deadline) ?? undefined,
  };
}

function pickKpiContainer(root: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  const candidates: unknown[] = [root.kpis, root.kpi];
  if (isObject(root.result)) {
    const r = root.result;
    candidates.push(r.kpis, r.kpi);
  }
  if (isObject(root.solution)) {
    candidates.push((root.solution as Record<string, unknown>).kpis);
  }
  for (const c of candidates) {
    if (!isObject(c)) continue;
    for (const [k, v] of Object.entries(c)) {
      const n = asFiniteNumber(v);
      if (n !== null && !(k in out)) out[k] = n;
    }
  }
  return out;
}

/**
 * Extract a uniform `{ status, fasi, kpis, warnings, ... }` from either of the
 * two backend shapes we currently handle:
 *  - Template/FJSP: `{ slug, solution: { status, fasi[], warnings?, ... }, kpis }`
 *  - Legacy LLM:    `{ result: { piano[], kpi }, ... }` or solution at root.
 */
export function normalizeForTools(
  raw: Json,
  kpisOverride?: Record<string, number>,
): NormalizedSolution {
  const root = isObject(raw) ? raw : {};
  // The inner `solution` object (template shape) or fall back to root itself.
  const innerSolution = isObject(root.solution) ? root.solution : null;
  const legacyResult = isObject(root.result) ? root.result : null;

  const containerForFasi: Record<string, unknown> =
    innerSolution ?? legacyResult ?? root;
  const fasiRaw = pickFasiArray(containerForFasi) ?? [];
  const fasi: FaseRecord[] = [];
  for (const f of fasiRaw) {
    const coerced = coerceFase(f);
    if (coerced) fasi.push(coerced);
  }

  const statusContainer = innerSolution ?? legacyResult ?? root;
  const status = asString(
    statusContainer['status'] ?? root['status'],
    fasi.length > 0 ? 'FEASIBLE' : 'UNKNOWN',
  ).toUpperCase();

  const warnings: string[] = [];
  for (const src of [innerSolution, legacyResult, root]) {
    if (!src) continue;
    const w = src['warnings'];
    if (Array.isArray(w)) {
      for (const item of w) if (typeof item === 'string') warnings.push(item);
    }
  }

  const reasonContainer = innerSolution ?? legacyResult ?? root;
  const reasonValue = reasonContainer['reason'] ?? reasonContainer['motivo'];
  const reason = typeof reasonValue === 'string' ? reasonValue : null;

  const vincoli: string[] = [];
  const vc = reasonContainer['vincoli_critici'];
  if (Array.isArray(vc)) {
    for (const item of vc) if (typeof item === 'string') vincoli.push(item);
  }

  let kpis = kpisOverride ?? pickKpiContainer(root);
  if (Object.keys(kpis).length === 0 && kpisOverride === undefined) {
    kpis = pickKpiContainer(root);
  }

  return {
    status,
    fasi,
    kpis,
    warnings,
    reason,
    vincoli_critici: vincoli,
    raw,
  };
}

function ensureNormalized(ctx: ManagerToolContext): NormalizedSolution {
  if (ctx.normalized) return ctx.normalized;
  const norm = normalizeForTools(ctx.solution, ctx.kpis);
  ctx.normalized = norm;
  return norm;
}

const KPI_SUMMARY_KEYS = [
  'makespan_min',
  'on_time_rate',
  'cost_usd',
  'max_machine_util',
  'n_commesse',
  'n_in_ritardo',
  'saturation_avg',
] as const;

function pickKpiSummary(kpis: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of KPI_SUMMARY_KEYS) if (k in kpis) out[k] = kpis[k]!;
  return out;
}

interface OrderSummary {
  commessa: string;
  fasi: number;
  start_min: number;
  end_min: number;
  duration_min: number;
  deadline_min: number | null;
  ritardo_min: number;
  status: 'on_time' | 'late';
  macchine: string[];
  macchine_overflow?: number;
  operatori: string[];
  operatori_overflow?: number;
}

function summarizeOrders(fasi: FaseRecord[]): OrderSummary[] {
  const byOrder = new Map<string, FaseRecord[]>();
  for (const f of fasi) {
    const list = byOrder.get(f.commessa);
    if (list) list.push(f);
    else byOrder.set(f.commessa, [f]);
  }
  const orders: OrderSummary[] = [];
  for (const [commessa, list] of byOrder) {
    list.sort((a, b) => a.start_min - b.start_min);
    const start_min = list[0]!.start_min;
    const end_min = list.reduce((m, f) => Math.max(m, f.end_min), 0);
    const ritardo_min = list.reduce(
      (m, f) => Math.max(m, f.ritardo_min ?? 0),
      0,
    );
    const deadline_min =
      list.find((f) => f.deadline_min !== undefined)?.deadline_min ?? null;
    const allMacchine = Array.from(
      new Set(list.map((f) => f.macchina).filter((m) => m.length > 0)),
    );
    const allOperatori = Array.from(
      new Set(list.map((f) => f.operatore).filter((o) => o.length > 0)),
    );
    const mCap = capIds(allMacchine);
    const oCap = capIds(allOperatori);
    orders.push({
      commessa,
      fasi: list.length,
      start_min,
      end_min,
      duration_min: end_min - start_min,
      deadline_min,
      ritardo_min,
      status: ritardo_min > 0 ? 'late' : 'on_time',
      macchine: mCap.items,
      ...(mCap.overflow > 0 ? { macchine_overflow: mCap.overflow } : {}),
      operatori: oCap.items,
      ...(oCap.overflow > 0 ? { operatori_overflow: oCap.overflow } : {}),
    });
  }
  orders.sort((a, b) => a.start_min - b.start_min);
  return orders;
}

interface MachineStatus {
  machine_id: string;
  n_fasi: number;
  n_commesse: number;
  busy_min: number;
  setup_min: number;
  util_ratio: number | null;
  commesse: string[];
  commesse_overflow?: number;
}

function summarizeMachines(
  fasi: FaseRecord[],
  filter?: string | null,
): MachineStatus[] {
  const horizon = fasi.reduce((m, f) => Math.max(m, f.end_min), 0);
  const filterLc = filter ? filter.toLowerCase() : null;
  const byMachine = new Map<string, FaseRecord[]>();
  for (const f of fasi) {
    if (!f.macchina) continue;
    if (filterLc && f.macchina.toLowerCase() !== filterLc) continue;
    const list = byMachine.get(f.macchina);
    if (list) list.push(f);
    else byMachine.set(f.macchina, [f]);
  }
  const out: MachineStatus[] = [];
  for (const [machine_id, list] of byMachine) {
    const busy_min = list.reduce(
      (s, f) => s + (f.end_min - f.start_min),
      0,
    );
    const setup_min = list.reduce((s, f) => s + f.setup_min, 0);
    const allCommesse = Array.from(new Set(list.map((f) => f.commessa)));
    const capped = capIds(allCommesse);
    out.push({
      machine_id,
      n_fasi: list.length,
      n_commesse: allCommesse.length,
      busy_min,
      setup_min,
      util_ratio: horizon > 0 ? Math.round((busy_min / horizon) * 1000) / 1000 : null,
      commesse: capped.items,
      ...(capped.overflow > 0 ? { commesse_overflow: capped.overflow } : {}),
    });
  }
  out.sort((a, b) => (b.util_ratio ?? 0) - (a.util_ratio ?? 0));
  return out;
}

interface OperatorAssignment {
  operator_id: string;
  n_fasi: number;
  n_commesse: number;
  busy_min: number;
  macchine: string[];
  macchine_overflow?: number;
  commesse: string[];
  commesse_overflow?: number;
}

function summarizeOperators(
  fasi: FaseRecord[],
  filter?: string | null,
): OperatorAssignment[] {
  const filterLc = filter ? filter.toLowerCase() : null;
  const byOp = new Map<string, FaseRecord[]>();
  for (const f of fasi) {
    if (!f.operatore) continue;
    if (filterLc && f.operatore.toLowerCase() !== filterLc) continue;
    const list = byOp.get(f.operatore);
    if (list) list.push(f);
    else byOp.set(f.operatore, [f]);
  }
  const out: OperatorAssignment[] = [];
  for (const [operator_id, list] of byOp) {
    const busy_min = list.reduce(
      (s, f) => s + (f.end_min - f.start_min),
      0,
    );
    const allCommesse = Array.from(new Set(list.map((f) => f.commessa)));
    const allMacchine = Array.from(
      new Set(list.map((f) => f.macchina).filter((m) => m.length > 0)),
    );
    const cCap = capIds(allCommesse);
    const mCap = capIds(allMacchine);
    out.push({
      operator_id,
      n_fasi: list.length,
      n_commesse: allCommesse.length,
      busy_min,
      macchine: mCap.items,
      ...(mCap.overflow > 0 ? { macchine_overflow: mCap.overflow } : {}),
      commesse: cCap.items,
      ...(cCap.overflow > 0 ? { commesse_overflow: cCap.overflow } : {}),
    });
  }
  out.sort((a, b) => b.busy_min - a.busy_min);
  return out;
}

const MINUTES_PER_DAY = 24 * 60;
const MAX_LIST_ITEMS = 50;
const MAX_INT_INPUT = 10_000;
const MAX_INNER_IDS = 20;

function capIds(ids: string[]): { items: string[]; overflow: number } {
  if (ids.length <= MAX_INNER_IDS) return { items: ids, overflow: 0 };
  return { items: ids.slice(0, MAX_INNER_IDS), overflow: ids.length - MAX_INNER_IDS };
}

function planAnchorMin(fasi: FaseRecord[]): number {
  let anchor = Number.POSITIVE_INFINITY;
  for (const f of fasi) if (f.start_min < anchor) anchor = f.start_min;
  return Number.isFinite(anchor) ? anchor : 0;
}

export const MANAGER_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_kpi_summary',
    description:
      'Restituisce i KPI principali della pianificazione corrente (makespan, on-time rate, costo totale, max utilizzo macchine, numero commesse, ritardi, saturazione media). Usare per domande generali sullo stato del piano.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'list_orders',
    description:
      'Elenca le commesse pianificate con durata, deadline (se nota), eventuale ritardo, macchine e operatori coinvolti. Usare per domande come "quali commesse abbiamo?", "mostra commesse in ritardo", ecc.',
    input_schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['on_time', 'late', 'all'],
          description: "Filtra per stato di puntualità. Default 'all'.",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_LIST_ITEMS,
          description: `Numero massimo di commesse da restituire (default ${MAX_LIST_ITEMS}).`,
        },
      },
      required: [],
    },
  },
  {
    name: 'get_machine_status',
    description:
      'Restituisce utilizzo e fasi assegnate per una macchina specifica (se machine_id fornito) o per tutte le macchine. Mostra n_fasi, n_commesse, busy_min, setup_min, util_ratio sull\'orizzonte.',
    input_schema: {
      type: 'object',
      properties: {
        machine_id: {
          type: 'string',
          description:
            "Identificativo macchina alfanumerico (es. 'M02'). Puoi passare la forma usata dal manager ('m2', 'M-2', 'linea 2'): viene normalizzata all'id reale del piano prima della ricerca. Omettere per lista completa.",
        },
      },
      required: [],
    },
  },
  {
    name: 'get_operator_assignments',
    description:
      "Restituisce assegnazioni per operatore (singolo se operator_id fornito, altrimenti tutti): minuti di lavoro, fasi totali, commesse e macchine assegnate. Usare per workload operatori.",
    input_schema: {
      type: 'object',
      properties: {
        operator_id: {
          type: 'string',
          description:
            "Identificativo operatore alfanumerico (es. 'OP-02'). Puoi passare la forma usata dal manager ('o2', 'O-2', 'operatore 2'): viene normalizzata all'id reale del piano prima della ricerca. Omettere per lista completa.",
        },
      },
      required: [],
    },
  },
  {
    name: 'get_next_deadlines',
    description:
      'Restituisce le commesse con deadline entro N giorni a partire dall\'inizio della pianificazione. Utile per domande del tipo "cosa scade questa settimana?". Solo commesse con deadline_min noto.',
    input_schema: {
      type: 'object',
      properties: {
        within_days: {
          type: 'integer',
          minimum: 1,
          maximum: 365,
          description: 'Finestra in giorni rispetto al makespan_start (default 7).',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_late_orders',
    description:
      'Restituisce solo le commesse in ritardo con il delta in minuti rispetto alla deadline. Lista vuota se tutto on-time.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_bottleneck_machines',
    description:
      'Restituisce le top_n macchine più sature (per util_ratio sull\'orizzonte). Usare per identificare colli di bottiglia. Default top_n=3.',
    input_schema: {
      type: 'object',
      properties: {
        top_n: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Numero di macchine da restituire (default 3).',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_phase',
    description:
      'Restituisce tutte le fasi di una commessa specifica con timing (start_min, end_min, setup_min, processing_min), macchina e operatore. Usare per domande del tipo "dimmi le fasi di COM-007".',
    input_schema: {
      type: 'object',
      properties: {
        commessa: {
          type: 'string',
          description:
            "Identificativo commessa alfanumerico (es. 'COM-007'). Puoi passare la forma usata dal manager ('com7', 'commessa 7'): viene normalizzata all'id reale del piano prima della ricerca.",
        },
      },
      required: ['commessa'],
    },
  },
  {
    name: 'get_cost_breakdown',
    description:
      "Restituisce il dettaglio del costo per categoria (setup, operatori, totale) ricavato dai KPI. Solo categorie effettivamente presenti.",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_status_diagnosis',
    description:
      "Restituisce lo status del solver (OPTIMAL/FEASIBLE/INFEASIBLE/UNKNOWN), eventuali warning, motivo (se INFEASIBLE) e vincoli critici. Usare quando il manager chiede 'cosa non va?' o 'perché è infeasible?'.",
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

const MAX_ENUM_HINT_IDS = 30;

function enumHint(label: string, ids: string[]): string {
  if (ids.length === 0) return '';
  const shown = ids.slice(0, MAX_ENUM_HINT_IDS);
  const suffix = ids.length > shown.length ? ', …' : '';
  return ` ${label} disponibili nel piano corrente: ${shown.join(', ')}${suffix}.`;
}

/**
 * Build the manager tool list with the real plan ids inlined into the
 * machine_id / commessa descriptions, so Haiku self-corrects toward valid
 * identifiers ("la M02 esiste, la M99 no"). Falls back to the static
 * {@link MANAGER_TOOLS} when no ids are known.
 *
 * The injected ids ARE per-plan volatile data — the BFF must keep the prompt
 * cache breakpoint OFF this list (or downstream of it) to avoid busting the
 * cache every request. See `runManagerChat`.
 */
export function buildManagerTools(closedSet?: {
  machines?: string[];
  orders?: string[];
  operators?: string[];
}): Anthropic.Tool[] {
  const machines = closedSet?.machines ?? [];
  const orders = closedSet?.orders ?? [];
  const operators = closedSet?.operators ?? [];
  if (machines.length === 0 && orders.length === 0 && operators.length === 0) {
    return MANAGER_TOOLS;
  }
  const machineHint = enumHint('Macchine', machines);
  const orderHint = enumHint('Commesse', orders);
  const operatorHint = enumHint('Operatori', operators);
  return MANAGER_TOOLS.map((tool) => {
    if (machineHint && tool.name === 'get_machine_status') {
      return { ...tool, description: tool.description + machineHint };
    }
    if (orderHint && tool.name === 'query_phase') {
      return { ...tool, description: tool.description + orderHint };
    }
    if (operatorHint && tool.name === 'get_operator_assignments') {
      return { ...tool, description: tool.description + operatorHint };
    }
    return tool;
  });
}

export type ToolExecutor = (
  name: string,
  input: unknown,
  ctx: ManagerToolContext,
) => Promise<Json>;

export const executeManagerTool: ToolExecutor = async (name, input, ctx) => {
  const args = isObject(input) ? input : {};
  const norm = ensureNormalized(ctx);

  switch (name) {
    case 'get_kpi_summary': {
      return {
        status: norm.status,
        kpis: pickKpiSummary(norm.kpis),
        n_fasi: norm.fasi.length,
        n_commesse: new Set(norm.fasi.map((f) => f.commessa)).size,
      };
    }

    case 'list_orders': {
      const statusFilter = (() => {
        const s = asString(args.status, 'all');
        return s === 'on_time' || s === 'late' || s === 'all' ? s : 'all';
      })();
      const limit = asPositiveInt(args.limit, MAX_LIST_ITEMS, MAX_LIST_ITEMS);
      const all = summarizeOrders(norm.fasi);
      const filtered =
        statusFilter === 'all' ? all : all.filter((o) => o.status === statusFilter);
      return {
        total: filtered.length,
        returned: Math.min(filtered.length, limit),
        truncated: filtered.length > limit,
        orders: filtered.slice(0, limit),
      };
    }

    case 'get_machine_status': {
      const machineId = sanitizeId(args.machine_id);
      if (args.machine_id !== undefined && machineId === null) {
        return {
          error:
            "machine_id non valido: deve essere alfanumerico (lettere, cifre, '-', '_').",
        };
      }
      // Canonicalize AFTER the injection guard: "m2" → "M02" before filtering.
      const resolvedMachineId =
        machineId === null ? null : resolveId(machineId, ctx, resolveMachineAlias);
      const machines = summarizeMachines(norm.fasi, resolvedMachineId);
      if (resolvedMachineId && machines.length === 0) {
        return { machine_id: resolvedMachineId, found: false, machines: [] };
      }
      return { machines, total: machines.length };
    }

    case 'get_operator_assignments': {
      const opId = sanitizeId(args.operator_id);
      if (args.operator_id !== undefined && opId === null) {
        return {
          error:
            "operator_id non valido: deve essere alfanumerico (lettere, cifre, '-', '_').",
        };
      }
      // Operators aren't in SolutionContext, so canonicalize "o2" → "OP-02"
      // against the operator set derived from the live plan, reusing the shared
      // resolver primitive (no bespoke alias logic). Only when a live plan is
      // present (solutionContext set), mirroring the machine/order gating.
      const resolvedOpId =
        opId !== null && ctx.solutionContext
          ? resolveAgainstSet(opId, operatorIdsOf(norm.fasi)) ?? opId
          : opId;
      const operators = summarizeOperators(norm.fasi, resolvedOpId);
      if (resolvedOpId && operators.length === 0) {
        return { operator_id: resolvedOpId, found: false, operators: [] };
      }
      return { operators, total: operators.length };
    }

    case 'get_next_deadlines': {
      const days = asPositiveInt(args.within_days, 7, 365);
      const anchor = planAnchorMin(norm.fasi);
      const cutoffMin = anchor + days * MINUTES_PER_DAY;
      const orders = summarizeOrders(norm.fasi).filter(
        (o) => o.deadline_min !== null && o.deadline_min <= cutoffMin,
      );
      orders.sort(
        (a, b) => (a.deadline_min ?? Infinity) - (b.deadline_min ?? Infinity),
      );
      const hasAnyDeadline = norm.fasi.some((f) => f.deadline_min !== undefined);
      return {
        within_days: days,
        anchor_min: anchor,
        cutoff_min: cutoffMin,
        total: orders.length,
        orders: orders.slice(0, MAX_LIST_ITEMS),
        truncated: orders.length > MAX_LIST_ITEMS,
        note:
          orders.length === 0 && !hasAnyDeadline
            ? 'Nessun deadline_min nelle fasi: deadline non incluse nella soluzione.'
            : undefined,
      };
    }

    case 'get_late_orders': {
      const lateOrders = summarizeOrders(norm.fasi).filter(
        (o) => o.status === 'late',
      );
      lateOrders.sort((a, b) => b.ritardo_min - a.ritardo_min);
      const totale_ritardo_min = lateOrders.reduce(
        (s, o) => s + o.ritardo_min,
        0,
      );
      return {
        total: lateOrders.length,
        totale_ritardo_min,
        orders: lateOrders.slice(0, MAX_LIST_ITEMS),
        truncated: lateOrders.length > MAX_LIST_ITEMS,
      };
    }

    case 'get_bottleneck_machines': {
      const topN = asPositiveInt(args.top_n, 3, 20);
      const machines = summarizeMachines(norm.fasi);
      return {
        top_n: topN,
        machines: machines.slice(0, topN),
      };
    }

    case 'query_phase': {
      const commessa = sanitizeId(args.commessa);
      if (!commessa) {
        return {
          error:
            "commessa mancante o non valida: deve essere alfanumerica (lettere, cifre, '-', '_').",
        };
      }
      // Canonicalize AFTER the injection guard: "com7" → "COM-007" before filtering.
      const resolvedCommessa = resolveId(commessa, ctx, resolveOrderAlias);
      const needleLc = resolvedCommessa.toLowerCase();
      const fasi = norm.fasi.filter((f) => f.commessa.toLowerCase() === needleLc);
      if (fasi.length === 0) {
        return { commessa: resolvedCommessa, found: false, fasi: [] };
      }
      fasi.sort((a, b) => a.start_min - b.start_min);
      const totalDuration = fasi.reduce(
        (s, f) => s + (f.end_min - f.start_min),
        0,
      );
      const totalSetup = fasi.reduce((s, f) => s + f.setup_min, 0);
      const ritardo = fasi.reduce(
        (m, f) => Math.max(m, f.ritardo_min ?? 0),
        0,
      );
      return {
        commessa: resolvedCommessa,
        found: true,
        n_fasi: fasi.length,
        start_min: fasi[0]!.start_min,
        end_min: fasi[fasi.length - 1]!.end_min,
        total_duration_min: totalDuration,
        total_setup_min: totalSetup,
        ritardo_min: ritardo,
        fasi,
      };
    }

    case 'get_cost_breakdown': {
      const out: Record<string, number> = {};
      const breakdownKeys = [
        'setup_cost_usd',
        'operator_cost_usd',
        'machine_cost_usd',
        'overtime_cost_usd',
        'penalty_cost_usd',
        'cost_usd',
      ];
      for (const k of breakdownKeys) if (k in norm.kpis) out[k] = norm.kpis[k]!;
      return {
        breakdown: out,
        keys_available: Object.keys(out),
        note:
          Object.keys(out).length === 0
            ? 'Nessuna voce di costo presente nei KPI.'
            : undefined,
      };
    }

    case 'get_status_diagnosis': {
      return {
        status: norm.status,
        warnings: norm.warnings,
        reason: norm.reason,
        vincoli_critici: norm.vincoli_critici,
        has_plan: norm.fasi.length > 0,
        n_fasi: norm.fasi.length,
      };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
};

// Convenience re-exports for the BFF route (Task #2).
export type { NormalizedSolution, FaseRecord };
export { MAX_LIST_ITEMS, MAX_INT_INPUT };
