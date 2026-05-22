import type { Intent } from './intent-parser';
import {
  findIntent,
  type ConstraintCatalog,
  type EntityFieldDef,
  type EntityValidator,
  type IntentDef,
} from './catalog/loader';

/**
 * Wave 7 — Strategy Router (deterministic, no LLM).
 *
 * Given a parsed Intent + entities + the baseline solution, decides which
 * of three strategies the BFF should execute:
 *
 *   A. data_modification — preferred when the intent maps cleanly onto a
 *      dataset edit (e.g. add a maintenance window to machine M02). The
 *      router calls the caller-provided `tryDataModification` callback
 *      (implemented by w7-bff-orchestrator's data-modifier.ts) to ask
 *      whether the modification can actually be applied. If yes →
 *      outcome A; if no → falls through to the intent's declared
 *      fallback_strategy.
 *
 *   B. rule_addition — emits a `rules` payload that the backend solver
 *      reads from `companies/<slug>/plans/history/*.json`. The router
 *      validates entities deterministically against the baseline and
 *      builds the payload shape required by `f_apply_rules.py`. Failure
 *      to validate (missing required field, unknown id, malformed value)
 *      falls through to strategy C.
 *
 *   C. opus_translator — the Wave 4.1 fallback. The router does not call
 *      Opus directly (that's the BFF's job): it only signals that
 *      strategy C should run. Used when:
 *        - intent_id is "unknown",
 *        - intent_id is not in the catalog,
 *        - rule_addition validation failed.
 *
 *   D. unsupported — returned only when a known intent passed validation
 *      but the caller declared the modification cannot be applied AND
 *      the fallback strategy also failed. In practice this happens when
 *      the baseline does not contain the referenced machine/order at all.
 *      The BFF surfaces this as a user-visible "non applicabile" warning.
 *
 * Inversion of control: `tryDataModification` is injected by the caller
 * so this module has zero coupling to the BFF's data-modifier
 * implementation. That keeps the router unit-testable in isolation.
 */

export type StrategyKind = 'data_modification' | 'rule_addition' | 'opus_translator' | 'unsupported';

export interface BaselineFasi {
  fasi: Array<{
    commessa: string;
    macchina: string;
    operatore?: string;
    start_min: number;
    end_min: number;
  }>;
  /** Optional precomputed ids; if absent, derived from fasi[]. */
  machines?: Set<string> | string[];
  orders?: Set<string> | string[];
  operators?: Set<string> | string[];
  horizon_end_min?: number;
}

export interface StrategyOutcomeA {
  kind: 'data_modification';
  intent_id: string;
  entities: Record<string, unknown>;
  /** Marker only — the actual dataset edit is performed by the BFF's data-modifier. */
  data_modification_applied: true;
  warnings: string[];
}

export interface StrategyOutcomeB {
  kind: 'rule_addition';
  intent_id: string;
  entities: Record<string, unknown>;
  /** The `rules` payload to forward to the backend solver. */
  rules: Record<string, unknown>;
  warnings: string[];
}

export interface StrategyOutcomeC {
  kind: 'opus_translator';
  intent_id: string;
  /** Why we are falling back to the Opus translator. */
  reason: string;
  warnings: string[];
}

export interface StrategyOutcomeUnsupported {
  kind: 'unsupported';
  intent_id: string;
  reason: string;
  warnings: string[];
}

export type StrategyOutcome =
  | StrategyOutcomeA
  | StrategyOutcomeB
  | StrategyOutcomeC
  | StrategyOutcomeUnsupported;

/**
 * Callback signature provided by the BFF's data-modifier.
 *
 *   - Returns `true` if the modification can be applied against the
 *     baseline (the dataset edit will then be performed at runtime by
 *     the BFF before forwarding the solve request to the backend).
 *   - Returns `false` if the modification is conceptually applicable
 *     (intent is data_modification) but cannot be performed against
 *     this specific baseline (e.g. the machine exists but the time
 *     window collides with a frozen phase). The router falls through
 *     to the fallback strategy.
 *   - Returns `null` if the modifier has no opinion (no implementation
 *     yet for this intent). Router treats as `false` and falls through.
 */
export type TryDataModificationFn = (
  intentId: string,
  entities: Record<string, unknown>,
  baseline: BaselineFasi,
) => boolean | null;

interface DerivedIds {
  machines: Set<string>;
  orders: Set<string>;
  operators: Set<string>;
  horizon_end_min: number;
}

function asStringSet(v: unknown): Set<string> | null {
  if (v instanceof Set) {
    const out = new Set<string>();
    for (const x of v) if (typeof x === 'string') out.add(x);
    return out;
  }
  if (Array.isArray(v)) {
    const out = new Set<string>();
    for (const x of v) if (typeof x === 'string') out.add(x);
    return out;
  }
  return null;
}

function deriveIds(baseline: BaselineFasi): DerivedIds {
  const machines = asStringSet(baseline.machines) ?? new Set<string>();
  const orders = asStringSet(baseline.orders) ?? new Set<string>();
  const operators = asStringSet(baseline.operators) ?? new Set<string>();
  let horizon = baseline.horizon_end_min ?? 0;
  for (const fase of baseline.fasi) {
    if (fase.macchina) machines.add(fase.macchina);
    if (fase.commessa) orders.add(fase.commessa);
    if (fase.operatore) operators.add(fase.operatore);
    if (fase.end_min > horizon) horizon = fase.end_min;
  }
  return { machines, orders, operators, horizon_end_min: horizon };
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

interface ValidationFailure {
  ok: false;
  reason: string;
  warnings: string[];
}

interface ValidationSuccess {
  ok: true;
  normalised: Record<string, unknown>;
  warnings: string[];
}

type ValidationResult = ValidationFailure | ValidationSuccess;

const CANONICAL_SHIFTS = new Set(['mattina', 'pomeriggio', 'serale', 'notte']);

/**
 * B-W8-S-01 (stress-engineer 2026-05-22): Haiku emits `M2`, `M-2`, `m2`,
 * `M 2`, etc. depending on the operator's writing style, while the
 * baseline canonical form is `M02` (zero-padded). Pre-fix the strict
 * `must_exist_in_solution_machines` validator rejected those variants
 * with `unknown_machine:M2`, the router cascaded to the Opus translator
 * (Strategy C), and one Italian utterance cost ~$0.25 instead of a
 * Haiku-only $0.005 (250× overshoot, repeated 100s of times per stress
 * eval).
 *
 * The function probes a few canonical variants — original case,
 * uppercase, alphanumeric-only, zero-padded numeric tail, leading-zero
 * stripped — and returns the first one present in `known`. Pure-deterministic;
 * no Opus, no LLM, no extra cost. Returns null if nothing matches so the
 * caller falls back to the original error path.
 */
function canonicaliseId(raw: string, known: Set<string>): string | null {
  if (known.size === 0) return null;
  const candidates: string[] = [];
  const push = (s: string) => {
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  push(raw);
  push(raw.toUpperCase());
  const alnum = raw.replace(/[^a-zA-Z0-9]/g, '');
  push(alnum);
  push(alnum.toUpperCase());
  // Zero-pad / strip numeric tail. Matches "M2", "M-2", "M02", "COM-7", "COM-007".
  // Pattern: letters + optional separator + digits.
  const m = alnum.match(/^([A-Za-z]+)(\d+)$/);
  if (m) {
    const prefix = m[1].toUpperCase();
    const num = parseInt(m[2], 10);
    if (Number.isFinite(num)) {
      // Try the candidate prefix as-is (covers "M" + "2" → both M2 and M02 below)
      // and a few common widths.
      for (const width of [2, 3, 4]) {
        push(`${prefix}${String(num).padStart(width, '0')}`);
      }
      // Strip-leading-zeros variant (baseline "M2" + Haiku said "M02")
      push(`${prefix}${num}`);
    }
  }
  // COM-007 style: keep the hyphen since baselines often have hyphenated
  // order ids. Same numeric padding probe.
  const mh = raw.match(/^([A-Za-z]+)-?(\d+)$/);
  if (mh) {
    const prefix = mh[1].toUpperCase();
    const num = parseInt(mh[2], 10);
    if (Number.isFinite(num)) {
      for (const width of [2, 3, 4]) {
        push(`${prefix}-${String(num).padStart(width, '0')}`);
      }
      push(`${prefix}-${num}`);
    }
  }
  for (const cand of candidates) {
    if (known.has(cand)) return cand;
  }
  return null;
}

function validateField(
  value: unknown,
  validator: EntityValidator,
  ids: DerivedIds,
  startMinForGt?: number,
): { ok: true } | { ok: false; reason: string } {
  switch (validator) {
    case 'must_exist_in_solution_machines':
      if (typeof value !== 'string' || !value.trim()) return { ok: false, reason: 'not_a_string' };
      if (ids.machines.size > 0 && !ids.machines.has(value)) {
        return { ok: false, reason: `unknown_machine:${value}` };
      }
      return { ok: true };
    case 'must_exist_in_solution_orders':
      if (typeof value !== 'string' || !value.trim()) return { ok: false, reason: 'not_a_string' };
      if (ids.orders.size > 0 && !ids.orders.has(value)) {
        return { ok: false, reason: `unknown_order:${value}` };
      }
      return { ok: true };
    case 'each_must_exist_in_solution_orders':
      if (!Array.isArray(value) || value.length === 0) {
        return { ok: false, reason: 'not_a_non_empty_array' };
      }
      for (const id of value) {
        if (typeof id !== 'string' || !id.trim()) return { ok: false, reason: 'entry_not_a_string' };
        if (ids.orders.size > 0 && !ids.orders.has(id)) {
          return { ok: false, reason: `unknown_order:${id}` };
        }
      }
      return { ok: true };
    case 'positive_int':
      if (!isPositiveInt(value)) return { ok: false, reason: 'not_a_positive_int' };
      return { ok: true };
    case 'gt_start':
      if (!isPositiveInt(value)) return { ok: false, reason: 'not_a_positive_int' };
      if (startMinForGt !== undefined && (value as number) <= startMinForGt) {
        return { ok: false, reason: 'end_min_not_greater_than_start_min' };
      }
      return { ok: true };
    case 'iso_datetime_string':
      if (typeof value !== 'string' || value.length > 64) {
        return { ok: false, reason: 'not_a_short_string' };
      }
      return { ok: true };
    case 'short_string':
      if (typeof value !== 'string' || value.length > 200) {
        return { ok: false, reason: 'not_a_short_string' };
      }
      return { ok: true };
    case 'shift_name_enum':
      if (typeof value !== 'string' || !CANONICAL_SHIFTS.has(value)) {
        return { ok: false, reason: 'not_a_canonical_shift_name' };
      }
      return { ok: true };
    case 'shift_name_or_id':
      if (typeof value !== 'string' || !value.trim() || value.length > 64) {
        return { ok: false, reason: 'not_a_short_shift_identifier' };
      }
      return { ok: true };
  }
}

/**
 * Walk entity schema, apply defaults, validate. Returns a normalised
 * entities map ready for payload construction, or a structured failure.
 */
function validateEntities(
  intent: IntentDef,
  entities: Record<string, unknown>,
  ids: DerivedIds,
): ValidationResult {
  const warnings: string[] = [];
  const normalised: Record<string, unknown> = {};

  // Apply known defaults first so dependent validators (e.g. gt_start)
  // see the materialised value.
  const fields: Array<[string, EntityFieldDef]> = Object.entries(intent.entities);
  // First pass: copy provided values + apply defaults for missing optional.
  for (const [name, def] of fields) {
    const raw = entities[name];
    if (raw === undefined || raw === null) {
      if (def.required) {
        return {
          ok: false,
          reason: `missing_required_entity:${name}`,
          warnings,
        };
      }
      // Apply known defaults; horizon_end is the only default keyword.
      if (def.default_to === 'horizon_end' && ids.horizon_end_min > 0) {
        normalised[name] = ids.horizon_end_min;
        warnings.push(`default_applied:${name}=horizon_end(${ids.horizon_end_min})`);
      }
      continue;
    }
    // B-W8-S-01 canonicalise machine/order ids BEFORE strict validation so
    // "M2" → "M02" doesn't trigger an Opus fallback. The router runs
    // post-Haiku, so this is the latest stop before entity validation.
    if (def.validator === 'must_exist_in_solution_machines' && typeof raw === 'string') {
      const canon = canonicaliseId(raw, ids.machines);
      if (canon !== null && canon !== raw) {
        warnings.push(`canonicalised:${name}:${raw}->${canon}`);
        normalised[name] = canon;
        continue;
      }
    } else if (def.validator === 'must_exist_in_solution_orders' && typeof raw === 'string') {
      const canon = canonicaliseId(raw, ids.orders);
      if (canon !== null && canon !== raw) {
        warnings.push(`canonicalised:${name}:${raw}->${canon}`);
        normalised[name] = canon;
        continue;
      }
    } else if (def.validator === 'each_must_exist_in_solution_orders' && Array.isArray(raw)) {
      const canon: string[] = [];
      let touched = false;
      for (const v of raw) {
        if (typeof v !== 'string') { canon.push(v as never); continue; }
        const c = canonicaliseId(v, ids.orders);
        if (c !== null && c !== v) { canon.push(c); touched = true; warnings.push(`canonicalised:${name}:${v}->${c}`); }
        else canon.push(v);
      }
      if (touched) {
        normalised[name] = canon;
        continue;
      }
    }
    normalised[name] = raw;
  }

  // Second pass: validate values. Track start_min for the gt_start
  // validator (used by end_min / shift end_min).
  const startMin = isPositiveInt(normalised.start_min) ? (normalised.start_min as number) : undefined;
  for (const [name, def] of fields) {
    if (!(name in normalised)) continue;
    const v = normalised[name];
    const res = validateField(v, def.validator, ids, startMin);
    if (!res.ok) {
      return { ok: false, reason: `entity_validation_failed:${name}:${res.reason}`, warnings };
    }
  }

  return { ok: true, normalised, warnings };
}

/**
 * Map the normalised entities + intent into the rules payload shape the
 * backend solver consumes (see `daino/templates/fjsp_constraints/f_apply_rules.py`).
 * Each intent's `fallback_rule_key` selects the top-level rules field.
 */
function buildRulesPayload(intent: IntentDef, normalised: Record<string, unknown>): Record<string, unknown> {
  switch (intent.fallback_rule_key) {
    case 'unavailable_machines': {
      const machine_id = normalised.machine_id as string;
      const start_min = normalised.start_min as number;
      const end_min = (normalised.end_min as number | undefined) ?? undefined;
      const window: Record<string, unknown> = { start_min };
      if (end_min !== undefined) window.end_min = end_min;
      if (typeof normalised.label === 'string') window.label = normalised.label;
      return { unavailable_machines: { [machine_id]: [window] } };
    }
    case 'priority_orders': {
      return { priority_orders: normalised.order_ids as string[] };
    }
    case 'deadline_changes': {
      const order_id = normalised.order_id as string;
      const body: Record<string, unknown> = {
        new_deadline_min: normalised.new_deadline_min as number,
      };
      if (typeof normalised.iso_datetime === 'string') body.iso_datetime = normalised.iso_datetime;
      return { deadline_changes: { [order_id]: body } };
    }
    case 'extra_capacity': {
      const ec: Record<string, unknown> = {};
      if (normalised.operators !== undefined) ec.operators = normalised.operators;
      if (normalised.shift !== undefined) ec.shift = normalised.shift;
      if (normalised.machine_id !== undefined) ec.machine_id = normalised.machine_id;
      if (normalised.duration_min !== undefined) ec.duration_min = normalised.duration_min;
      return { extra_capacity: ec };
    }
    case 'shift_changes': {
      const shift_id = normalised.shift_id as string;
      const body: Record<string, unknown> = {};
      if (normalised.start_min !== undefined) body.start_min = normalised.start_min;
      if (normalised.end_min !== undefined) body.end_min = normalised.end_min;
      return { shift_changes: { [shift_id]: body } };
    }
    default:
      // Unknown rule_key — should be caught by catalog Zod schema, but
      // surface a clean error if a catalog evolution slips through.
      return { _unknown_rule_key: intent.fallback_rule_key };
  }
}

export interface RouteIntentArgs {
  intent: Intent;
  baseline: BaselineFasi;
  catalog: ConstraintCatalog;
  tryDataModification?: TryDataModificationFn;
}

/**
 * Route a parsed intent to one of A / B / C / unsupported.
 *
 * The function is total: it never throws. Any error condition is encoded
 * in the StrategyOutcome.
 */
export function routeIntent(args: RouteIntentArgs): StrategyOutcome {
  const { intent, baseline, catalog, tryDataModification } = args;
  const warnings: string[] = [];

  if (intent.intent_id === 'unknown') {
    return {
      kind: 'opus_translator',
      intent_id: 'unknown',
      reason: intent.fallback_reasoning ?? 'intent classified as unknown by parser',
      warnings,
    };
  }

  const def = findIntent(catalog, intent.intent_id);
  if (!def) {
    return {
      kind: 'opus_translator',
      intent_id: intent.intent_id,
      reason: `intent_id_not_in_catalog:${intent.intent_id}`,
      warnings,
    };
  }

  // F-W8-01 (devils 2026-05-22): catalog flag for intents the parser
  // recognises but the backend solver has no real consumer for. Short-
  // circuit to `unsupported` so the BFF emits aborted_unsupported instead
  // of routing to a strategy whose payload is silently ignored downstream.
  if (def.not_implemented === true) {
    return {
      kind: 'unsupported',
      intent_id: intent.intent_id,
      reason:
        "Scenario riconosciuto ma non ancora supportato: il backend non implementa "
        + 'questa modifica nel modello CP-SAT. Riprova con un vincolo del catalogo gia attivo '
        + '(es. blocco macchina, priorita commessa, cambio scadenza).',
      warnings: [`not_implemented:${intent.intent_id}`],
    };
  }

  const ids = deriveIds(baseline);
  const validation = validateEntities(def, intent.entities, ids);
  if (!validation.ok) {
    // Entity validation failed against the baseline. Fall back to the
    // Opus translator so it can re-interpret the utterance with full
    // context (it may, for instance, recognise "M2" as "M02" via fuzzy
    // matching, or extract a date the Haiku missed).
    return {
      kind: 'opus_translator',
      intent_id: intent.intent_id,
      reason: validation.reason,
      warnings: validation.warnings,
    };
  }

  warnings.push(...validation.warnings);

  // Strategy selection: try the catalog's declared primary first, then
  // fall back to the declared fallback strategy.
  if (def.strategy === 'data_modification') {
    const tryResult = tryDataModification
      ? tryDataModification(intent.intent_id, validation.normalised, baseline)
      : null;
    if (tryResult === true) {
      return {
        kind: 'data_modification',
        intent_id: intent.intent_id,
        entities: validation.normalised,
        data_modification_applied: true,
        warnings,
      };
    }
    // Data modification not applicable. Fall through to fallback.
    warnings.push(
      tryResult === null
        ? `data_modifier_no_implementation:${intent.intent_id}`
        : `data_modifier_rejected:${intent.intent_id}`,
    );
  }

  // Fallback path: build a rules payload (strategy B) using the intent's
  // fallback_rule_key.
  const fallbackStrategy = def.strategy === 'data_modification' ? def.fallback_strategy : def.strategy;
  if (fallbackStrategy === 'rule_addition') {
    const rules = buildRulesPayload(def, validation.normalised);
    return {
      kind: 'rule_addition',
      intent_id: intent.intent_id,
      entities: validation.normalised,
      rules,
      warnings,
    };
  }

  // Should be unreachable given the catalog Zod schema enforces both
  // strategies to be in StrategySchema, but guard for completeness.
  return {
    kind: 'unsupported',
    intent_id: intent.intent_id,
    reason: `no_strategy_available:${fallbackStrategy}`,
    warnings,
  };
}
