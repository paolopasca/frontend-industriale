import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  checkRateLimit,
  getClientIp,
  recordCost,
} from '@/server/llm/client';
import { translateWhatIfToConstraint } from '@/server/llm/constraint-translator';
import { parseIntent } from '@/server/llm/intent-parser';
import { routeIntent, type BaselineFasi } from '@/server/llm/strategy-router';
import { loadCatalog } from '@/server/llm/catalog/loader';
import { apply as applyDataModification, canApply as dataModifierCanApply } from '@/server/llm/data-modifier';
import { buildFrozenPhases, detectScenarioStartMin, detectScenarioPhraseMatches, type FrozenPhase } from '@/server/llm/frozen-window-builder';
import { mergeRuleSlots } from '@/lib/appliedRulesLedger';
import { resolveTemplate } from '@/lib/api';

/**
 * Wave 7 BFF route — apply a what-if scenario as a real constraint
 * change and re-solve.
 *
 * Two execution paths share the same SSE response:
 *
 *   Wave 7 (preferred, when body.managerText is set):
 *     parsing_intent → intent_parsed → routed → [solving] → solved → done
 *     The Haiku intent-parser classifies the manager utterance against
 *     the closed catalog; the strategy router picks A (data_modification)
 *     / B (rule_addition) / C (opus_translator fallback).
 *
 *   Wave 4.1 backward-compat (when body.managerText is absent):
 *     translating → translated → solving → solved → done
 *     Opus 4.7 translator builds the ConstraintChange directly from the
 *     4-section whatif markdown. This path is unchanged.
 *
 * Wave 7 adds three optional body fields:
 *   - managerText  → fed to the Haiku intent parser (raw utterance).
 *   - currentTimeMin → planning clock; cutoffMin = currentTimeMin + cushionMin.
 *   - cushionMin   → default 30, capped at 1440.
 *
 * The cutoffMin + frozen_phases (built from the baseline) are forwarded
 * to /api/public/solve-template; the backend hard-locks pre-cutoff
 * operations via `model.add(start == fp.start_min)`.
 *
 * Alternative terminal events:
 *   aborted_unsupported → done   (router/translator marked the scenario
 *                                 unsupported)
 *   aborted → done               (client disconnect)
 *   error                         (any fatal error; closes stream)
 *
 * Concurrency: per-IP AbortController guards against double-solve.
 * Rate limit: 5/h on `${ip}:apply_whatif`.
 *
 * Cost: Haiku parser + (optional) Opus translator. Both surfaces are
 * accumulated into a single cost record under surface 'whatif_apply'.
 */

const BodySchema = z.object({
  slug: z.string().min(1),
  originalSolution: z.unknown(),
  kpis: z.record(z.string(), z.number()),
  whatifText: z.string().min(3).max(20_000),
  consultationMd: z.string().optional(),
  dataSchemaMd: z.string().optional(),
  // Wave 7 — raw manager utterance for the Haiku intent parser. Falls
  // back to whatifText when absent, but the parser works better on the
  // short raw text than on the 4-section markdown.
  managerText: z.string().min(1).max(4_000).optional(),
  // Wave 7 — current planning clock (minutes from horizon start). When
  // absent, no frozen-window is computed (Wave 4.1 behaviour).
  currentTimeMin: z.number().int().min(0).max(10_000_000).optional(),
  // Wave 7 — buffer added to currentTimeMin before computing cutoff. Default
  // matches Plan §2 D1 (30-min cushion). Capped to 24h so a misconfigured
  // UI cannot push the cutoff past the planning horizon.
  cushionMin: z.number().int().min(0).max(1_440).default(30),
  // Wave 16.2 — GRAY_ZONE confirmation retry. When the UI confirms a gray-zone
  // result, it re-calls with userConfirmedGrayZone=true and the echoed
  // confirmedPayload so the extractor step is skipped and the pre-validated
  // rules go directly to the solver. forceOpusFallback skips the extractor
  // and calls Opus instead (manager chose "Usa Opus" on the confirmation modal).
  userConfirmedGrayZone: z.boolean().optional(),
  confirmedPayload: z.record(z.string(), z.unknown()).optional(),
  forceOpusFallback: z.boolean().optional(),
  // Wave 16.6 §C — cumulative applied-rules ledger. The UI folds every
  // previously-accepted rule payload (mergeLedgerRules) and threads it here
  // so the solver re-applies prior-accepted constraints together with the
  // new scenario. Merged NEW-WINS (the new scenario beats a conflicting
  // prior slot) via mergeRuleSlots before the solve. Optional so Wave 4.1
  // and pre-16.6 callers (no ledger) keep the single-rule behaviour.
  priorRules: z.record(z.string(), z.unknown()).optional(),
});

type Body = z.infer<typeof BodySchema>;

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// Mirror src/lib/api.ts:_PROBLEM_TYPES so we can detect the company's
// problem type from the consultation_md the client already supplied —
// no need to re-fetch /api/public/company/<slug>.
const PROBLEM_TYPES = ['fjsp', 'jssp', 'flow_shop', 'staff_rostering', 'workforce'] as const;
type ProblemType = (typeof PROBLEM_TYPES)[number];

function detectProblemTypeFromMd(md: string | undefined): ProblemType {
  if (!md) return 'fjsp';
  const m = md.match(/^##\s*Tipo problema:\s*([a-z_]+)/im);
  if (!m) return 'fjsp';
  const t = m[1].toLowerCase();
  return (PROBLEM_TYPES as readonly string[]).includes(t) ? (t as ProblemType) : 'fjsp';
}

// DA-22: only emit a delta for KPIs present in BOTH baseline and next.
// Emitting `-baseline` or `+next` for one-sided keys (DA-21 pre-fix) would
// have suggested the KPI moved to/from zero, which is misleading. One-sided
// keys instead surface as `missing_kpi:<name>` warnings the UI can render
// as "metric unavailable" rather than "metric crashed to 0".
function diffKpis(
  baseline: Record<string, number>,
  next: Record<string, number>,
): { delta: Record<string, number>; warnings: string[] } {
  const delta: Record<string, number> = {};
  const warnings: string[] = [];
  const keys = new Set<string>([...Object.keys(baseline), ...Object.keys(next)]);
  for (const k of keys) {
    const a = baseline[k];
    const b = next[k];
    if (typeof a === 'number' && typeof b === 'number') {
      delta[k] = Math.round((b - a) * 1_000_000) / 1_000_000;
    } else {
      warnings.push(`missing_kpi:${k}`);
    }
  }
  return { delta, warnings };
}

// Wave 16.4 A4 — estimate the max end_min across the baseline solution so
// the cutoff auto-detect path can warn when the detected scenario start
// falls past the planning horizon. Devil-advocate LOW-5 (2026-05-27).
// Scans both nested `{commessa:{fasi:[]}}` and flat `{fasi:[]}` shapes
// since both are accepted upstream by buildBaselineForRouter.
function estimateHorizonMaxEndMin(originalSolution: unknown): number {
  if (!originalSolution || typeof originalSolution !== 'object') return 0;
  let maxEnd = 0;
  const visit = (fase: unknown): void => {
    if (!fase || typeof fase !== 'object') return;
    const f = fase as { end_min?: unknown };
    if (typeof f.end_min === 'number' && Number.isFinite(f.end_min) && f.end_min > maxEnd) {
      maxEnd = f.end_min;
    }
  };
  const root = originalSolution as Record<string, unknown>;
  if (Array.isArray(root.fasi)) {
    for (const fase of root.fasi) visit(fase);
  } else {
    for (const [, jobRaw] of Object.entries(root)) {
      if (!jobRaw || typeof jobRaw !== 'object') continue;
      const fasi = (jobRaw as { fasi?: unknown }).fasi;
      if (Array.isArray(fasi)) for (const fase of fasi) visit(fase);
    }
  }
  return maxEnd;
}

// Wave 16.6 §D — empty-solution guard (the Gantt-not-updating fix).
// The dashboard's adaptFJSP (resultAdapter.ts) builds machines/operators/
// operations by iterating `solution[commessa].fasi[]`. The apply-whatif
// `solved` event updates the KPI cards from `newKpis`, but if the backend
// returns a solution map with NO job carrying a non-empty fasi[] (a
// degenerate/empty solve — e.g. a rule that the solver applied to an empty
// model, or a backend that echoed `{}`), the KPIs change but the Gantt /
// OperationalPlan render blank. The manager sees numbers move while the
// visual plan stays empty — indistinguishable from a frozen Gantt. We
// detect that here and emit aborted_unsupported(empty_solution_after_solve)
// instead of a misleading `solved`. Tolerant to both the nested
// `{commessa:{fasi:[]}}` shape (the real solver output) and a flat
// top-level `fasi[]` (legacy fixtures).
function countSolutionPhases(solution: unknown): number {
  if (!solution || typeof solution !== 'object') return 0;
  const root = solution as Record<string, unknown>;
  if (Array.isArray(root.fasi)) return root.fasi.length;
  let total = 0;
  for (const [, jobRaw] of Object.entries(root)) {
    if (!jobRaw || typeof jobRaw !== 'object') continue;
    const fasi = (jobRaw as { fasi?: unknown }).fasi;
    if (Array.isArray(fasi)) total += fasi.length;
  }
  return total;
}

// Wave 16.6 §E — explicit clock-time start anchor with no enforcing slot.
// Utterances like "anticipa COM-007 a domani alle 8" or "fai partire COM-001
// il giorno 2 dalle 14" carry BOTH a day anchor (handled by the frozen-window
// cutoff) AND an explicit wall-clock start time. The solver has NO release-time
// constraint slot: f_apply_rules.py applies unavailable_machines / priority /
// deadline / shift / capacity, but nothing that forces a given operation to
// START at a given clock minute. So the start-time half of such an utterance is
// silently dropped — the solver may schedule the order anywhere the day-anchor
// freeze allows. We surface an amber `time_window_start_unsupported` warning so
// the manager knows the time-of-day was not hard-enforced (the day-level freeze
// still applies). NON-blocking: the solve proceeds.
//
// Detection is deliberately narrow to avoid false positives: a clock time
// ("alle 14", "dalle 8:30", "alle ore 9") AND a day anchor ("domani",
// "dopodomani", "giorno N", "fra N giorni") must BOTH be present. A bare "ferma
// M-3 dalle 14 alle 18" (machine downtime window) is NOT flagged — that maps to
// unavailable_machines which IS enforced; the guard only fires when the clock
// time is attached to a day-shifted order anchor the solver can't pin.
const RE_CLOCK_TIME = /\b(?:alle|dalle)\s+(?:ore\s+)?\d{1,2}(?:[:.]\d{2})?\b/;

function hasExplicitTimeWindowStart(text: string | undefined): boolean {
  if (typeof text !== 'string' || text.trim().length === 0) return false;
  const t = text.toLowerCase();
  if (!RE_CLOCK_TIME.test(t)) return false;
  // Reuse the frozen-window detector's vocabulary: a non-null scenario start
  // means a day anchor (domani/dopodomani/giorno N/fra N giorni) is present.
  return detectScenarioStartMin(t) !== null;
}

// Wave 16.4 A3 — empty-dict guard. A rules payload like
// `{deadline_changes: {COM-001: {}}}` or `{unavailable_machines: {M01: []}}`
// looks structurally valid to the solver client but degenerates to a
// silent no-op once the backend applies it: the order/machine entry has
// no actionable field, so the schedule comes back unchanged and the
// manager sees a "solved" state with zero delta — same failure class as
// F-W10-01. Reject before hitting the wire so the UI surfaces a clear
// "incomplete rule" toast and the manager can re-issue with a proper
// quantity / window.
//
// Structured as OR-of-predicates so combined rules with one empty + one
// meaningful key still pass the guard. The Opus translator (Strategy C)
// can emit multi-key payloads where an early-return per-branch would
// reject a payload like `{unavailable_machines: {}, priority_orders: ['COM-001']}`
// even though the priority_orders entry is actionable. Devil-advocate
// MEDIUM-1 (2026-05-27).
function hasMeaningfulMachineUnavail(um: unknown): boolean {
  if (!um || typeof um !== 'object' || Array.isArray(um)) return false;
  const entries = Object.entries(um as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.some(
    ([, windows]) => Array.isArray(windows) && windows.length > 0,
  );
}

// D1 contract (be-extractor-extender 2026-05-27): operator_unavailability
// ships as an ARRAY of entries `[{operator_id, start_min, end_min, date}, ...]`.
// Sentinel "?" must NOT count as meaningful — A2 early-return should have
// converted it to unsupported, but if for any reason that path was skipped,
// A3 acts as defense-in-depth and rejects it as not meaningful.
function hasMeaningfulOperatorUnavail(ou: unknown): boolean {
  if (!Array.isArray(ou)) return false;
  return ou.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as Record<string, unknown>;
    const hasId =
      typeof e.operator_id === 'string'
      && e.operator_id.length > 0
      && e.operator_id !== '?';
    const hasWindow = e.start_min !== undefined || e.end_min !== undefined;
    return hasId && hasWindow;
  });
}

function hasMeaningfulDeadlineChanges(dc: unknown): boolean {
  if (!dc || typeof dc !== 'object' || Array.isArray(dc)) return false;
  const entries = Object.entries(dc as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.some(([, body]) => {
    if (!body || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    return (
      b.new_deadline_min !== undefined
      || b.delta_min !== undefined
      || b.advance_days !== undefined
      || b.delay_days !== undefined
      || b.iso_datetime !== undefined
    );
  });
}

function hasMeaningfulPriorityOrders(po: unknown): boolean {
  if (!Array.isArray(po)) return false;
  return po.some((id) => typeof id === 'string' && id.trim().length > 0);
}

function hasMeaningfulExtraCapacity(ec: unknown): boolean {
  if (!ec || typeof ec !== 'object') return false;
  if (Array.isArray(ec)) {
    return ec.some(
      (v) =>
        v
        && typeof v === 'object'
        && 'operator_count' in (v as Record<string, unknown>),
    );
  }
  const ecObj = ec as Record<string, unknown>;
  return (
    ecObj.operators !== undefined
    || ecObj.operator_count !== undefined
    || ecObj.shift !== undefined
    || ecObj.duration_min !== undefined
  );
}

function hasMeaningfulShiftChanges(sc: unknown): boolean {
  if (!sc) return false;
  if (Array.isArray(sc)) {
    return sc.some((v) => {
      if (!v || typeof v !== 'object') return false;
      const o = v as Record<string, unknown>;
      return (
        'shift_id' in o
        && (o.new_start_min !== undefined
          || o.new_end_min !== undefined
          || o.delta_min !== undefined
          || o.start_min !== undefined
          || o.end_min !== undefined)
      );
    });
  }
  if (typeof sc !== 'object') return false;
  const entries = Object.entries(sc as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.some(([, body]) => {
    if (!body || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    return (
      b.start_min !== undefined
      || b.end_min !== undefined
      || b.new_start_min !== undefined
      || b.new_end_min !== undefined
      || b.delta_min !== undefined
    );
  });
}

function hasMeaningfulRules(rules: Record<string, unknown>): boolean {
  if (!rules || typeof rules !== 'object') return false;
  if (Object.keys(rules).length === 0) return false;
  return (
    hasMeaningfulMachineUnavail((rules as { unavailable_machines?: unknown }).unavailable_machines)
    || hasMeaningfulOperatorUnavail((rules as { operator_unavailability?: unknown }).operator_unavailability)
    || hasMeaningfulDeadlineChanges((rules as { deadline_changes?: unknown }).deadline_changes)
    || hasMeaningfulPriorityOrders((rules as { priority_orders?: unknown }).priority_orders)
    || hasMeaningfulExtraCapacity((rules as { extra_capacity?: unknown }).extra_capacity)
    || hasMeaningfulShiftChanges((rules as { shift_changes?: unknown }).shift_changes)
  );
}

// F-W7-08 — describe the user-facing effect of a Wave 7 intent in short
// Italian strings the SolutionDiff renders as an audit trail. The text
// is about WHAT changed in the plan (the manager's mental model), not
// which wire channel carries the payload. So it fires for both Strategy
// A (data_modification) and Strategy B (rule_addition) variants of the
// supported intents — the manager doesn't care about the routing detail.
function describeIntentEffect(
  intentId: string,
  entities: Record<string, unknown>,
): string[] {
  if (intentId === 'machine_unavailability') {
    const machineId = String(entities.machine_id ?? '');
    const start = Number(entities.start_min);
    const end = entities.end_min !== undefined ? Number(entities.end_min) : null;
    const window = end !== null && Number.isFinite(end)
      ? `[${start}, ${end}]`
      : `[${start}, fine orizzonte]`;
    return [`Bloccata macchina ${machineId} in finestra ${window} min`];
  }
  if (intentId === 'deadline_change') {
    const orderId = String(entities.order_id ?? '');
    const newDeadline = Number(entities.new_deadline_min);
    return [`Aggiornata scadenza commessa ${orderId} → ${newDeadline} min`];
  }
  return [];
}

// Per-IP in-flight guard. Solve is expensive (Opus + backend CPU); a
// second concurrent request from the same client almost always indicates
// a runaway UI or a misclick — fail fast with 409 rather than double-pay.
const _inFlight = new Map<string, AbortController>();

// Per-slug in-flight guard (F-W7-04). Two managers on different IPs
// can otherwise race on `companies/<slug>/plans/history` (warm-start
// memory) and corrupt the persisted plan. The lock is scoped to the
// company slug so unrelated tenants stay independent.
const _inFlightBySlug = new Map<string, AbortController>();

// Wave 7 — coerce the solution payload (which can be top-level fasi[]
// or `{commessa: {fasi: []}}`) into the BaselineFasi shape the strategy
// router expects. Tolerant to legacy fixtures that ship a flat fasi[]
// at the root.
function buildBaselineForRouter(originalSolution: unknown): BaselineFasi {
  if (!originalSolution || typeof originalSolution !== 'object') {
    return { fasi: [] };
  }
  const root = originalSolution as Record<string, unknown>;
  const flatFasi = Array.isArray(root.fasi)
    ? (root.fasi as Array<Record<string, unknown>>)
    : null;
  const machines = Array.isArray(root.machines) ? (root.machines as string[]) : undefined;
  const orders = Array.isArray(root.orders) ? (root.orders as string[]) : undefined;
  const operators = Array.isArray(root.operators) ? (root.operators as string[]) : undefined;
  const fasi: BaselineFasi['fasi'] = [];

  if (flatFasi) {
    for (const f of flatFasi) {
      const commessa = typeof f.commessa === 'string' ? f.commessa : '';
      const macchina = typeof f.macchina === 'string'
        ? f.macchina
        : typeof f.machine_id === 'string'
          ? (f.machine_id as string)
          : '';
      const operatore = typeof f.operatore === 'string' ? f.operatore : undefined;
      const start_min = typeof f.start_min === 'number' ? f.start_min : 0;
      const end_min = typeof f.end_min === 'number' ? f.end_min : 0;
      if (commessa && macchina) {
        fasi.push({ commessa, macchina, operatore, start_min, end_min });
      }
    }
  } else {
    // Nested shape `{commessa: {fasi: [...]}}` — flatten into the router's fasi[].
    for (const [commessa, jobRaw] of Object.entries(root)) {
      if (!jobRaw || typeof jobRaw !== 'object') continue;
      const jobFasi = (jobRaw as { fasi?: unknown }).fasi;
      if (!Array.isArray(jobFasi)) continue;
      for (const f of jobFasi as Array<Record<string, unknown>>) {
        const macchina = typeof f.macchina === 'string'
          ? f.macchina
          : typeof f.machine_id === 'string'
            ? (f.machine_id as string)
            : '';
        const operatore = typeof f.operatore === 'string' ? f.operatore : undefined;
        const start_min = typeof f.start_min === 'number' ? f.start_min : 0;
        const end_min = typeof f.end_min === 'number' ? f.end_min : 0;
        if (macchina) {
          fasi.push({ commessa, macchina, operatore, start_min, end_min });
        }
      }
    }
  }
  return { fasi, machines, orders, operators };
}

const SOLVE_TIMEOUT_MS = 60_000;
// Apply-whatif is the most expensive surface (Opus translator + backend
// re-solve). Cap below the shared default so even if the global env var
// raises the others, apply-whatif stays at 5/h.
const APPLY_WHATIF_LIMIT_PER_HOUR = 5;

export const Route = createFileRoute('/api/apply-whatif')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ip = getClientIp(request);
        const rl = checkRateLimit(`${ip}:apply_whatif`, APPLY_WHATIF_LIMIT_PER_HOUR);
        if (!rl.ok) {
          return jsonError(
            429,
            'rate_limited',
            `Limite di ${rl.limit} richieste/ora superato per apply-whatif.`,
          );
        }

        const contentLength = Number(request.headers.get('content-length') || '0');
        if (contentLength > 256_000) {
          return jsonError(413, 'payload_too_large', 'Body massimo 256 KB.');
        }

        let raw: unknown;
        try {
          raw = await request.json();
        } catch {
          return jsonError(400, 'invalid_json', 'Body non e JSON valido.');
        }

        const parsed = BodySchema.safeParse(raw);
        if (!parsed.success) {
          return jsonError(
            400,
            'invalid_body',
            parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          );
        }
        const input: Body = parsed.data;

        if (_inFlight.has(ip)) {
          return jsonError(
            409,
            'conflict',
            'Un apply-whatif e gia in corso per questo client. Aspetta la conclusione.',
          );
        }
        if (_inFlightBySlug.has(input.slug)) {
          return jsonError(
            409,
            'slug_conflict',
            `Un apply-whatif e gia in corso per ${input.slug}. Un altro manager sta ricalcolando il piano per questa azienda; riprova quando finisce.`,
          );
        }

        const abort = new AbortController();
        _inFlight.set(ip, abort);
        _inFlightBySlug.set(input.slug, abort);
        if (request.signal.aborted) {
          abort.abort(request.signal.reason);
        } else {
          request.signal.addEventListener(
            'abort',
            () => abort.abort(request.signal.reason),
            { once: true },
          );
        }

        let lastUsage: {
          cost_usd: number;
          tokens_in: number;
          tokens_out: number;
          cache_read_tokens?: number;
          cache_write_tokens?: number;
        } | null = null;
        let costRecorded = false;
        const flushCost = () => {
          if (costRecorded || !lastUsage) return;
          costRecorded = true;
          recordCost({
            ts: Date.now(),
            surface: 'whatif_apply',
            cost_usd: lastUsage.cost_usd,
            tokens_in: lastUsage.tokens_in,
            tokens_out: lastUsage.tokens_out,
            cache_read_tokens: lastUsage.cache_read_tokens,
            cache_write_tokens: lastUsage.cache_write_tokens,
          });
        };

        // Watchdog (w7-tester finding 2026-05-22): the stream's `cancel()`
        // callback is NOT guaranteed to fire on every client disconnect —
        // vite dev SSR and some runtimes drop the response without
        // triggering cancel(). Without a watchdog, the in-flight maps
        // leak the slug + IP entries forever and every subsequent
        // request gets a 409 until the process restarts.
        //
        // Budget covers BOTH the first solve AND the F-W7-02 INFEASIBLE
        // retry (each capped at SOLVE_TIMEOUT_MS) plus 30s grace for the
        // SSE final flush. The earlier cap (SOLVE_TIMEOUT_MS + 30s = 90s)
        // could fire mid-retry on a borderline INFEASIBLE/retry case (devils
        // F-W8-05 2026-05-22): first solve 55s INFEASIBLE → retry 50s →
        // 105s total > 90s → spurious slug-lock release + abort_signal
        // mid-stream. Two solve budgets + grace = 150s removes the gap.
        const WATCHDOG_MS = SOLVE_TIMEOUT_MS * 2 + 30_000;
        let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
        const clearWatchdog = () => {
          if (watchdogTimer !== null) {
            clearTimeout(watchdogTimer);
            watchdogTimer = null;
          }
        };
        const cleanup = () => {
          if (_inFlight.get(ip) === abort) _inFlight.delete(ip);
          if (_inFlightBySlug.get(input.slug) === abort) _inFlightBySlug.delete(input.slug);
          clearWatchdog();
        };
        watchdogTimer = setTimeout(() => {
          // Identity check: only release if our specific abort instance is
          // still the lock holder. A later, legitimate request that took
          // ownership must not be dropped by our stale watchdog.
          if (_inFlight.get(ip) === abort) _inFlight.delete(ip);
          if (_inFlightBySlug.get(input.slug) === abort) _inFlightBySlug.delete(input.slug);
          // Also abort the still-pending controller so the (likely orphaned)
          // stream stops doing work.
          if (!abort.signal.aborted) abort.abort('watchdog_timeout');
        }, WATCHDOG_MS);

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const write = (event: string, data: unknown) => {
              try { controller.enqueue(encoder.encode(sseEvent(event, data))); }
              catch { /* closed */ }
            };

            // Accumulator for the cost stats emitted by either the
            // intent-parser (Haiku) or the Opus translator. Both call
            // recordCost via flushCost() at the end of the stream.
            const accumulateUsage = (u: {
              cost_usd: number;
              tokens_in: number;
              tokens_out: number;
              cache_read_tokens?: number;
              cache_write_tokens?: number;
            }) => {
              if (!lastUsage) {
                lastUsage = { ...u };
              } else {
                lastUsage.cost_usd += u.cost_usd;
                lastUsage.tokens_in += u.tokens_in;
                lastUsage.tokens_out += u.tokens_out;
                if (u.cache_read_tokens) {
                  lastUsage.cache_read_tokens = (lastUsage.cache_read_tokens ?? 0) + u.cache_read_tokens;
                }
                if (u.cache_write_tokens) {
                  lastUsage.cache_write_tokens = (lastUsage.cache_write_tokens ?? 0) + u.cache_write_tokens;
                }
              }
            };

            try {
              const problemType = detectProblemTypeFromMd(input.consultationMd);

              // wave7Warnings is declared BEFORE the cutoff so the A4 path
              // can append warnings (ambiguous temporal phrase, horizon
              // overshoot) without forward-referencing a later const.
              const wave7Warnings: string[] = [];

              // Wave 7 — frozen-window cutoff. Only computed when the
              // caller passes currentTimeMin (Wave 4.1 callers omit this
              // and get the legacy soft-hint behaviour).
              //
              // Wave 16.4 A4 — when the manager utterance describes a future
              // point in time ("domani", "giorno N", "dopodomani", "fra N
              // giorni"), prefer that boundary over `currentTimeMin +
              // cushionMin`. Manager intent: "freeze the schedule up to the
              // scenario start, replan around the constraint from there".
              // The 30-min cushion is correct for "ferma adesso", not for a
              // tomorrow-shaped constraint.
              //
              // Clamp pattern (devil-advocate MEDIUM-1 2026-05-27): the
              // detected scenario start MUST never push the cutoff below
              // `currentTimeMin + cushionMin` — manager-elapsed time is
              // sacred. A "domani" utterance from someone already on day 3
              // cannot retroactively unfreeze phases that have run today.
              // So we take the max of (detected, legacy) when both exist.
              const textForCutoff = input.managerText ?? input.whatifText;
              const detectedScenarioStart = detectScenarioStartMin(textForCutoff);
              const phraseMatches = detectScenarioPhraseMatches(textForCutoff);
              const legacyCutoff = input.currentTimeMin !== undefined
                ? input.currentTimeMin + input.cushionMin
                : undefined;
              const cutoffMin =
                detectedScenarioStart !== null && detectedScenarioStart > 0
                  ? (legacyCutoff !== undefined
                      ? Math.max(detectedScenarioStart, legacyCutoff)
                      : detectedScenarioStart)
                  : legacyCutoff;

              // Devil-advocate MEDIUM-2: ambiguous temporal phrases (manager
              // said both "dopodomani" and "giorno 5") are silently resolved
              // by priority. Surface a marker so the UI can render "you said
              // both X and Y — used X" instead of letting the manager assume
              // their second phrase won.
              if (phraseMatches.length > 1 && detectedScenarioStart !== null && detectedScenarioStart > 0) {
                wave7Warnings.push(`a4_ambiguous_temporal_picked_${phraseMatches[0]}`);
              }
              // Devil-advocate MEDIUM-1: clamp event surfaced for audit. The
              // manager-elapsed clock won over the detected phrase — they
              // should know the cutoff isn't where their utterance pointed.
              if (
                detectedScenarioStart !== null
                && detectedScenarioStart > 0
                && legacyCutoff !== undefined
                && legacyCutoff > detectedScenarioStart
              ) {
                wave7Warnings.push('a4_cutoff_clamped_to_currentTime');
              }
              // Devil-advocate LOW-5: scenario start beyond the planning
              // horizon would freeze every phase in the baseline (silent
              // no-op illusion at the solver). Warn the manager so they
              // can re-issue a sensible window.
              const horizonMaxEnd = estimateHorizonMaxEndMin(input.originalSolution);
              if (
                cutoffMin !== undefined
                && horizonMaxEnd > 0
                && cutoffMin > horizonMaxEnd
              ) {
                wave7Warnings.push(`a4_cutoff_beyond_horizon:${cutoffMin}_max_${horizonMaxEnd}`);
              }

              // Wave 16.6 §E — explicit clock start-time on a day-anchored
              // order has no enforcing slot in the solver (f_apply_rules.py has
              // no release-time constraint). The day-level freeze still applies,
              // but the time-of-day is not pinned — warn so the manager isn't
              // misled into thinking "alle 8" was honoured. Amber, non-blocking.
              if (hasExplicitTimeWindowStart(textForCutoff)) {
                wave7Warnings.push('time_window_start_unsupported');
              }

              const frozenPhases: FrozenPhase[] = cutoffMin !== undefined
                ? buildFrozenPhases(input.originalSolution, cutoffMin)
                : [];

              // ── Wave 7 path ────────────────────────────────────────
              // When the caller passes managerText (the raw utterance) we
              // run the Haiku intent parser + strategy router. Otherwise
              // we keep the Wave 4.1 path (translator only).
              let rulesForSolve: Record<string, unknown> = {};
              let datasetOverrides: Record<string, unknown> | null = null;
              let strategyKind: 'A' | 'B' | 'C' | 'unsupported' = 'C';
              let unsupportedReason: string | null = null;
              // F-W7-08 — audit trail for Strategy A. Manager must see in
              // the UI what was changed at the dataset level (e.g.
              // "Aggiunta finestra manutenzione: M02 [2160,2520]") rather
              // than just "constraint applied".
              const datasetOverridesSummary: string[] = [];

              // Wave 16.6 §A WIRING STUB — interpreter-resolver (Task #1) is
              // building `interpretInstruction` (closed-set enum intent +
              // shared entity resolver + deterministic gate). Once it publishes
              // and ACKs its contract, the `parseIntent(...)` call below is
              // replaced by `interpretInstruction(...)`. Until then we keep the
              // shipped Haiku intent-parser path so apply-whatif stays
              // functional. Everything else in this route (ledger merge,
              // empty-solution guard, time-anchor flag) is independent of that
              // swap. DO NOT wire the interpreter before the ACK.
              if (input.managerText) {
                write('parsing_intent', { phase: 'parsing_intent', model: 'haiku-4.5' });
                const parsed = await parseIntent(input.managerText, {
                  signal: abort.signal,
                  onUsage: (u) => { accumulateUsage(u); },
                });
                if (abort.signal.aborted || parsed.aborted) {
                  flushCost();
                  write('aborted', { reason: 'client_disconnect' });
                  write('done', {
                    cost_usd: lastUsage?.cost_usd ?? 0,
                    tokens_in: lastUsage?.tokens_in ?? 0,
                    tokens_out: lastUsage?.tokens_out ?? 0,
                  });
                  return;
                }
                write('intent_parsed', {
                  intent_id: parsed.intent.intent_id,
                  entities: parsed.intent.entities,
                  confidence: parsed.intent.confidence,
                  fallback_reasoning: parsed.intent.fallback_reasoning,
                });

                // F-W8-07 — low confidence classification warning. When
                // Haiku says confidence='low' it has classified an intent
                // but with multiple assumptions; the manager must be told
                // the result may not match their intent. Continue the
                // normal flow (do NOT short-circuit) so the constraint is
                // still applied, but tag wave7Warnings so the UI renders
                // a yellow banner. NB: this is DIFFERENT from B-W8-S-04
                // short-circuit which fires only on (unknown + high).
                //
                // intent_id='unknown' + low is INCLUDED here. It does not
                // short-circuit (B-W8-S-04 fires only on unknown+high); it
                // cascades to the Strategy C Opus translator, and when that
                // rescues the utterance into an applied solve the manager
                // must still see the low-confidence banner. The earlier
                // F-W9-04 guard (`&& intent_id !== 'unknown'`) excluded it on
                // the theory that unknown always ends in aborted_unsupported
                // ("low confidence on a result that didn't apply anyway") —
                // but that premise is false for the Strategy C rescue→solved
                // path, and the banner ONLY ever renders from solved.warnings
                // (the aborted_unsupported handler ignores warnings, see
                // WhatIfAnalysis.tsx). So there was never a contradictory
                // banner to avoid; the guard merely silenced F-W8-07's
                // legitimate warning on the rescued path.
                if (parsed.intent.confidence === 'low') {
                  wave7Warnings.push('low_confidence_classification');
                  console.warn(
                    '[apply-whatif] low_confidence_classification',
                    {
                      intent_id: parsed.intent.intent_id,
                      fallback_reasoning: parsed.intent.fallback_reasoning,
                      manager_text: input.managerText?.slice(0, 200),
                    },
                  );
                }

                // B-W8-S-04 — short-circuit the Opus cascade when Haiku
                // confidently classified the utterance as out-of-catalog.
                // Previously the router returned `opus_translator` for
                // every `intent_id === 'unknown'` (strategy-router.ts:452),
                // which fired the Opus 4.7 translator only to have it
                // also return `unsupported`. Cost: $0.20 per stress
                // cycle × 5 = $1.00 wasted per stress run.
                //
                // When Haiku says "definitely outside the 5 catalog
                // intents" (intent_id=unknown + confidence=high), trust
                // it and emit aborted_unsupported directly. We still
                // run the cascade for confidence=medium/low so the
                // Opus translator can rescue ambiguous classifications.
                if (
                  parsed.intent.intent_id === 'unknown'
                  && parsed.intent.confidence === 'high'
                ) {
                  strategyKind = 'unsupported';
                  const reason = parsed.intent.fallback_reasoning
                    ?? 'haiku_classified_unknown_high_confidence';
                  wave7Warnings.push('haiku_unknown_high_no_cascade');
                  write('routed', {
                    strategy: 'unsupported',
                    intent_id: 'unknown',
                    warnings: ['haiku_unknown_high_no_cascade'],
                  });
                  flushCost();
                  write('aborted_unsupported', {
                    reason,
                    warnings: wave7Warnings,
                  });
                  write('done', {
                    cost_usd: lastUsage?.cost_usd ?? 0,
                    tokens_in: lastUsage?.tokens_in ?? 0,
                    tokens_out: lastUsage?.tokens_out ?? 0,
                    cache_read_tokens: lastUsage?.cache_read_tokens,
                    cache_write_tokens: lastUsage?.cache_write_tokens,
                  });
                  return;
                }

                const baselineForRouter = buildBaselineForRouter(input.originalSolution);
                const catalog = loadCatalog();
                const outcome = routeIntent({
                  intent: parsed.intent,
                  baseline: baselineForRouter,
                  catalog,
                  tryDataModification: (intentId, entities) =>
                    dataModifierCanApply(intentId)
                      ? applyDataModification(intentId, entities).modified
                      : null,
                });

                if (outcome.kind === 'data_modification') {
                  strategyKind = 'A';
                  const modRes = applyDataModification(outcome.intent_id, outcome.entities);
                  if (modRes.modified) {
                    datasetOverrides = modRes.dataset_overrides;
                    if (modRes.rules_fallback) {
                      // Pure Strategy A path uses rules_fallback because
                      // the backend's dataset-merge is not deep enough
                      // for the orders shape today.
                      rulesForSolve = modRes.rules_fallback;
                      wave7Warnings.push('strategy_a_via_rule_fallback');
                    }
                    datasetOverridesSummary.push(
                      ...describeIntentEffect(outcome.intent_id, outcome.entities),
                    );
                  } else {
                    // Router promised A but modifier rejected — fall back
                    // to the Opus translator path. Warn but don't fail.
                    strategyKind = 'C';
                    wave7Warnings.push('data_modifier_rejected_post_route');
                  }
                  wave7Warnings.push(...outcome.warnings);
                } else if (outcome.kind === 'rule_addition') {
                  strategyKind = 'B';
                  rulesForSolve = outcome.rules;
                  wave7Warnings.push(...outcome.warnings);
                  // F-W7-08 — emit audit summary for Strategy B too. The
                  // manager sees what changed regardless of whether the
                  // intent routed through data_modification or
                  // rule_addition (machine_unavailability lives here now
                  // per team-lead 2026-05-22 directive).
                  datasetOverridesSummary.push(
                    ...describeIntentEffect(outcome.intent_id, outcome.entities),
                  );
                } else if (outcome.kind === 'unsupported') {
                  strategyKind = 'unsupported';
                  unsupportedReason = outcome.reason;
                  wave7Warnings.push(...outcome.warnings);
                } else {
                  strategyKind = 'C';
                  wave7Warnings.push(...outcome.warnings);
                  wave7Warnings.push(`route_reason:${outcome.reason}`);
                }
                write('routed', {
                  strategy: strategyKind,
                  intent_id: parsed.intent.intent_id,
                  warnings: outcome.warnings,
                });

                if (strategyKind === 'unsupported') {
                  flushCost();
                  write('aborted_unsupported', {
                    reason: unsupportedReason ?? 'unsupported',
                    warnings: wave7Warnings,
                  });
                  write('done', {
                    cost_usd: lastUsage?.cost_usd ?? 0,
                    tokens_in: lastUsage?.tokens_in ?? 0,
                    tokens_out: lastUsage?.tokens_out ?? 0,
                  });
                  return;
                }
              }

              // Strategy C path — also taken when managerText is absent
              // (Wave 4.1 backward-compat) or when the router asked for
              // the Opus translator.
              if (!input.managerText || strategyKind === 'C') {
                // Wave 16.2 — fast path: manager already confirmed a GRAY_ZONE
                // payload. Skip the extractor+translator entirely; use the
                // echoed confirmedPayload as the rules for the solver directly.
                if (input.userConfirmedGrayZone && input.confirmedPayload) {
                  // Wave 16.3 CRITICAL-1 — reject sentinel "?" in
                  // unavailable_machines: backend extractor emits this key
                  // when the manager's target ("linea 99", "macchina", a
                  // typo) cannot be mapped to a canonical machine_id. If we
                  // pass it through to the solver, _apply_unavailable_machines
                  // logs and skips, the solver returns the baseline schedule
                  // unchanged, and the UI shows a "solved" state with no
                  // delta — manager thinks the constraint was applied when
                  // it silently no-op'd. Same class as F-W10-01. Abort with
                  // aborted_unsupported so the manager sees a clear message
                  // and can re-issue via Opus translator.
                  const unavail = (input.confirmedPayload as { unavailable_machines?: Record<string, unknown> })
                    .unavailable_machines;
                  if (unavail && typeof unavail === 'object' && '?' in unavail) {
                    flushCost();
                    write('aborted_unsupported', {
                      reason: 'unresolved_machine_target',
                      warnings: [
                        ...wave7Warnings,
                        'gray_zone_sentinel_target',
                        'use_opus_fallback_to_disambiguate',
                      ],
                    });
                    write('done', {
                      cost_usd: lastUsage?.cost_usd ?? 0,
                      tokens_in: lastUsage?.tokens_in ?? 0,
                      tokens_out: lastUsage?.tokens_out ?? 0,
                    });
                    return;
                  }
                  rulesForSolve = input.confirmedPayload;
                  wave7Warnings.push('gray_zone_confirmed_by_manager');
                } else {
                  write('translating', { phase: 'translating' });
                  const tr = await translateWhatIfToConstraint(
                    {
                      whatifText: input.whatifText,
                      originalSolution: input.originalSolution,
                      kpis: input.kpis,
                      consultationMd: input.consultationMd,
                      forceOpusFallback: input.forceOpusFallback,
                    },
                    {
                      signal: abort.signal,
                      onUsage: (u) => { accumulateUsage(u); },
                    },
                  );
                  write('translated', { change: tr.change });

                  if (abort.signal.aborted || tr.aborted) {
                    flushCost();
                    write('aborted', { reason: 'client_disconnect' });
                    write('done', {
                      cost_usd: lastUsage?.cost_usd ?? 0,
                      tokens_in: lastUsage?.tokens_in ?? 0,
                      tokens_out: lastUsage?.tokens_out ?? 0,
                    });
                    return;
                  }
                  if (tr.change.type === 'unsupported') {
                    flushCost();
                    write('aborted_unsupported', {
                      reason: tr.change.unsupportedReason ?? 'unsupported',
                      warnings: [...wave7Warnings, ...tr.change.warnings],
                    });
                    write('done', {
                      cost_usd: lastUsage?.cost_usd ?? 0,
                      tokens_in: lastUsage?.tokens_in ?? 0,
                      tokens_out: lastUsage?.tokens_out ?? 0,
                    });
                    return;
                  }
                  // Wave 16.2 — GRAY_ZONE pause: emit requires_confirmation and
                  // close the stream. The UI shows the modal and re-calls with
                  // userConfirmedGrayZone=true+confirmedPayload OR forceOpusFallback=true.
                  // This makes the safety gate real — no solve happens until confirmed.
                  if (tr.change.requiresConfirmation) {
                    flushCost();
                    write('requires_confirmation', {
                      confirmationMessage: tr.change.confirmationMessage,
                      confidence: tr.change.confidence,
                      confirmedPayload: tr.change.rules,
                    });
                    write('done', {
                      cost_usd: lastUsage?.cost_usd ?? 0,
                      tokens_in: lastUsage?.tokens_in ?? 0,
                      tokens_out: lastUsage?.tokens_out ?? 0,
                    });
                    return;
                  }
                  rulesForSolve = tr.change.rules;
                  wave7Warnings.push(...(tr.change.warnings ?? []));
                }
              }

              // Wave 16.6 §C — fold the cumulative ledger UNDER the new
              // scenario (NEW-WINS). priorRules carries every previously-
              // accepted constraint (the UI built it via mergeLedgerRules);
              // merging it here means the solver re-applies "M2 ferma il
              // giorno 2" together with the manager's new what-if, while a
              // conflicting newer slot beats the prior one. When no ledger was
              // sent (Wave 4.1 / pre-16.6 callers) this is a no-op identity.
              //
              // Note: this only carries the dynamic `rules` slots. Strategy A's
              // dataset_overrides are not part of the ledger contract today
              // (the ledger stores rule payloads, not dataset mutations); when
              // datasetOverrides is set, rulesForSolve typically holds the
              // rules_fallback which still merges correctly.
              const mergedRules = mergeRuleSlots(input.priorRules, rulesForSolve);

              // Wave 16.4 A3 — empty-dict guard. Reject underspecified rules
              // BEFORE the solver call so the manager gets a clear toast
              // instead of a silent no-op "solved" with zero delta. Skip the
              // guard when the change goes through dataset_overrides (Strategy A)
              // since the rules object can legitimately be empty in that path.
              // Run it on the MERGED payload: a new scenario that is itself
              // empty but rides on a non-empty ledger is still actionable.
              if (
                !datasetOverrides
                && !hasMeaningfulRules(mergedRules)
              ) {
                flushCost();
                write('aborted_unsupported', {
                  reason: 'empty_or_underspecified_rules',
                  warnings: [...wave7Warnings, 'empty_or_underspecified_rules'],
                });
                write('done', {
                  cost_usd: lastUsage?.cost_usd ?? 0,
                  tokens_in: lastUsage?.tokens_in ?? 0,
                  tokens_out: lastUsage?.tokens_out ?? 0,
                });
                return;
              }

              // Phase 2: solve. No additional LLM cost here.
              write('solving', { phase: 'solving', strategy: strategyKind });

              // Race the backend call against a 60s timeout that also
              // listens to the client's abort signal so the BFF doesn't
              // hold the SSE open forever if daino-backend-definitivo
              // stalls.
              // Devils F-W8-04 fix (2026-05-22): an `abort` listener added
              // to an already-aborted AbortSignal does NOT fire (verified via
              // node repl). If the client disconnects between awaiting and
              // arming this race, the setTimeout would tick for the full
              // SOLVE_TIMEOUT_MS before reject — 60s of stalled SSE. Wrap the
              // race in a helper that rejects synchronously when the signal
              // is already aborted, and the listener-arm is guarded by a
              // second check after the listener registers.
              const raceWithTimeout = <T>(work: Promise<T>): Promise<T> => {
                if (abort.signal.aborted) {
                  return Promise.reject(new Error('aborted'));
                }
                const timeoutPromise = new Promise<never>((_, reject) => {
                  const t = setTimeout(
                    () => reject(new Error('solve_timeout: il backend non ha risposto entro 60 secondi.')),
                    SOLVE_TIMEOUT_MS,
                  );
                  const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
                  abort.signal.addEventListener('abort', onAbort, { once: true });
                  // Re-check after addEventListener: if the signal aborted
                  // synchronously between the entry check and the listener
                  // attachment, onAbort never fires. Reject now.
                  if (abort.signal.aborted) onAbort();
                });
                return Promise.race([work, timeoutPromise]);
              };

              let solveResult = await raceWithTimeout(
                resolveTemplate(
                  input.slug,
                  problemType,
                  mergedRules,
                  cutoffMin,
                  frozenPhases,
                  datasetOverrides,
                  undefined, // frozenLockMode: first call uses backend default 'hard'.
                  true, // F-W10-07 forceColdStart: never warm-start apply-whatif.
                ),
              );

              // F-W7-02 — INFEASIBLE recovery (plan §2 D2: "lock duro +
              // fallback soft"). If the hard-lock on pre-cutoff phases
              // made the model infeasible (e.g. the new constraint clashes
              // with the frozen window), re-solve once in HINT mode so
              // the solver biases toward the consolidated slots but is
              // not pinned to them. The manager sees a warning so they
              // know the production-invariant guarantee was relaxed.
              if (
                solveResult.status === 'INFEASIBLE'
                && frozenPhases.length > 0
                && !abort.signal.aborted
              ) {
                // Backend (commit bba231a) populates wave7.apply_rules even on
                // INFEASIBLE responses, so the manager/UI can see *which* rules
                // the solver tried to honour before declaring infeasibility.
                // Surface that on the lock_relaxing event for a richer toast.
                //
                // F-W8-06 Wave 9 OPT 1 (w9-backend-lock-mode 2026-05-23):
                // backend now accepts `frozen_lock_mode: 'hint'`. The retry
                // re-submits the SAME frozen_phases list but with the
                // soft-preference mode, so the consolidated set is
                // preserved as `model.AddHint` instead of being dropped
                // wholesale (the Wave 8 Opt 2 fallback). The emitted
                // warning marker changes from `__plan_recomputed_from_scratch`
                // (which triggered a red banner) to
                // `__consolidated_preserved_as_hint` (which keeps the
                // banner amber).
                const failedAttempt = solveResult.wave7 ?? null;
                write('lock_relaxing', {
                  reason: 'infeasible_with_hard_lock',
                  frozen_count: frozenPhases.length,
                  attempted_locks: failedAttempt?.locked_count ?? 0,
                  attempted_rules: failedAttempt?.apply_rules?.length ?? 0,
                  // F-W8-06 Wave 9 honest signal: the consolidated phases
                  // are kept and re-submitted as soft hints — the plan
                  // is NOT being recomputed from scratch.
                  recompute_mode: 'frozen_phases_as_hint',
                });
                // Devils F-W8-04: explicit re-check between the SSE write and
                // the retry race. If the client aborted while we were emitting
                // lock_relaxing, the retry race would otherwise sit on a
                // 60-second setTimeout (see raceWithTimeout for the deeper
                // fix). Skip the retry and let the outer try/catch surface
                // the abort cleanly.
                if (abort.signal.aborted) {
                  throw new Error('aborted');
                }
                const relaxedResult = await raceWithTimeout(
                  resolveTemplate(
                    input.slug,
                    problemType,
                    mergedRules,
                    cutoffMin,
                    frozenPhases, // F-W8-06 Wave 9 OPT 1: full list, NOT [].
                    datasetOverrides,
                    'hint', // F-W8-06 Wave 9 OPT 1: soft preference.
                    true, // F-W10-07 forceColdStart: never warm-start apply-whatif.
                  ),
                );
                solveResult = {
                  ...relaxedResult,
                  // F-W8-06 Wave 9 OPT 1 marker. Keep the legacy
                  // `lock_relaxed_to_soft` so old UIs still light up the
                  // amber banner; add the new
                  // `__consolidated_preserved_as_hint` suffix so the UI
                  // can upgrade the copy to reflect that consolidated
                  // phases were NOT dropped.
                  warnings: [
                    'lock_relaxed_to_soft',
                    'lock_relaxed_to_soft__consolidated_preserved_as_hint',
                    ...(relaxedResult.warnings ?? []),
                  ],
                };
              }

              // Wave 16.6 §D — empty-solution guard (Gantt-not-updating fix).
              // The backend can report a SUCCESS status (OPTIMAL/FEASIBLE) yet
              // return a solution map with no schedulable phases (degenerate
              // solve, echoed `{}`, a rule that emptied the model). The KPI
              // cards would update from newKpis while the Gantt /
              // OperationalPlan render blank, which looks exactly like a frozen
              // Gantt to the manager. Convert that into an explicit
              // aborted_unsupported so the UI shows a clear "scenario non
              // applicabile" instead of a misleading half-update.
              //
              // Scope is deliberately narrow:
              //  - Only SUCCESS statuses are guarded. INFEASIBLE (incl. the
              //    both-solves-infeasible recovery case) is a legitimate
              //    terminal `solved` the UI renders as "infeasible" + the
              //    relaxation warning — an empty solution there is expected,
              //    not the bug.
              //  - Gated on the BASELINE having had phases: a problem that was
              //    legitimately empty to begin with is not flagged (nothing to
              //    render either way).
              const solveStatus = (solveResult.status ?? '').toUpperCase();
              const isSuccessStatus = solveStatus === 'OPTIMAL' || solveStatus === 'FEASIBLE';
              const solvedPhaseCount = countSolutionPhases(solveResult.solution);
              const baselinePhaseCount = countSolutionPhases(input.originalSolution);
              if (isSuccessStatus && solvedPhaseCount === 0 && baselinePhaseCount > 0) {
                flushCost();
                write('aborted_unsupported', {
                  reason: 'empty_solution_after_solve',
                  warnings: [
                    ...wave7Warnings,
                    ...(solveResult.warnings ?? []),
                    'empty_solution_after_solve',
                  ],
                });
                write('done', {
                  cost_usd: lastUsage?.cost_usd ?? 0,
                  tokens_in: lastUsage?.tokens_in ?? 0,
                  tokens_out: lastUsage?.tokens_out ?? 0,
                  cache_read_tokens: lastUsage?.cache_read_tokens,
                  cache_write_tokens: lastUsage?.cache_write_tokens,
                });
                return;
              }

              const newKpis: Record<string, number> = solveResult.kpis ?? {};
              const { delta: deltaKpis, warnings: kpiWarnings } = diffKpis(input.kpis, newKpis);

              flushCost();
              // Wave 7 — emit the full frozen-phases list on solved so
              // the UI can populate the "Fasi consolidate (invariate)"
              // accordion. Each entry already carries both the
              // backend-required field names (job_id, seq, machine_id,
              // worker_id) and the legacy-Italian aliases (commessa,
              // operazione, operatore) from `buildFrozenPhases`. We
              // also normalise `macchina` so the UI's existing
              // FrozenPhase shape `{commessa, operazione, macchina,
              // start_min, end_min}` works without remapping.
              const lockedPhasesOut = frozenPhases.map((fp) => ({
                ...fp,
                macchina: fp.machine_id,
              }));
              // Read counts from the backend's Wave 7 envelope. `wave7`
              // is `null` when no cutoff/frozen/overrides were sent
              // (Wave 4.1 backward-compat) — keep counts at 0 in that case.
              const wave7Env = solveResult.wave7 ?? null;
              const lockedCount = wave7Env?.locked_count ?? 0;
              // modified_count is the number of dynamic rules that
              // ACTUALLY took effect on the model. `apply_rules` also
              // contains skipped/passthrough entries (unknown machine,
              // extra_capacity routed to wrong layer, etc.) — those
              // would inflate the count. We split into applied vs
              // skipped/passthrough so the UI can render either total.
              const applyRules = wave7Env?.apply_rules ?? [];
              const isAppliedEntry = (entry: Record<string, unknown>): boolean => {
                const t = typeof entry.type === 'string' ? entry.type : '';
                if (t === '') return false;
                if (t.endsWith('_skipped')) return false;
                if (t === 'apply_rules_failed') return false;
                if (t.endsWith('_data_layer_passthrough')) return false;
                return true;
              };
              const modifiedCount = applyRules.filter(isAppliedEntry).length;
              const skippedRulesCount = applyRules.length - modifiedCount;
              write('solved', {
                newSolution: solveResult.solution ?? {},
                newKpis,
                deltaKpis,
                warnings: [
                  ...wave7Warnings,
                  ...(solveResult.warnings ?? []),
                  ...kpiWarnings,
                ],
                status: solveResult.status,
                objective_value: solveResult.objective_value,
                strategy: strategyKind,
                cutoff_min: cutoffMin,
                frozen_count: frozenPhases.length,
                locked_count: lockedCount,
                modified_count: modifiedCount,
                skipped_rules_count: skippedRulesCount,
                dataset_overrides_summary: datasetOverridesSummary,
                locked_phases: lockedPhasesOut,
                // Wave 16.6 §C — echo the NEW scenario's rule slot (pre-merge,
                // i.e. WITHOUT priorRules, which the ledger already holds). On
                // "Accetta" the UI appends exactly this delta so the next
                // What-If folds it in. Strategy A (dataset_overrides) carries
                // an empty rulesForSolve — the UI's append is a no-op for empty
                // payloads, which is correct (dataset mutations aren't ledgered
                // today).
                applied_rules: rulesForSolve,
                // Pass the raw backend envelope through for diagnostics
                // (devil's advocate + UI can introspect skipped entries).
                wave7: wave7Env,
              });
              write('done', {
                cost_usd: lastUsage?.cost_usd ?? 0,
                tokens_in: lastUsage?.tokens_in ?? 0,
                tokens_out: lastUsage?.tokens_out ?? 0,
                cache_read_tokens: lastUsage?.cache_read_tokens,
                cache_write_tokens: lastUsage?.cache_write_tokens,
              });
            } catch (err) {
              flushCost();
              const msg = err instanceof Error ? err.message : String(err);
              const code = abort.signal.aborted
                ? 'aborted'
                : msg.startsWith('solve_timeout')
                  ? 'solve_timeout'
                  : 'apply_failed';
              write('error', { code, message: msg });
            } finally {
              flushCost();
              cleanup();
              try { controller.close(); } catch { /* closed */ }
            }
          },
          cancel() {
            abort.abort('client_disconnect');
            flushCost();
            cleanup();
          },
        });

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'x-rate-limit-remaining': String(rl.remaining),
          },
        });
      },
    },
  },
});
