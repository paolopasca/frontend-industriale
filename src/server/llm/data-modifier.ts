/**
 * Wave 7 — Data modifier (Strategy A).
 *
 * Some what-if intents are best expressed as a *dataset change* rather
 * than a CP-SAT rule. The data-modifier produces `dataset_overrides`:
 * a delta payload the BFF ships to the backend (POST
 * /api/public/solve-template, optional `dataset_overrides` field). The
 * backend's `data` dict is shallow-merged with these overrides before
 * the solver runs.
 *
 * Supported intent — `deadline_change`:
 *   modifies `data["orders"][order_id]["deadline_min"]`. The backend's
 *   shallow-merge replaces the order record entirely, so we ALSO emit
 *   `rules_fallback: {deadline_changes: ...}` to preserve the order's
 *   operations and other required fields via the existing f_apply_rules
 *   consumer. The dataset_overrides path is kept for future backend
 *   evolution toward deep-merge semantics.
 *
 * Removed intent — `machine_unavailability` (team-lead 2026-05-22):
 *   the backend's `data["maintenance"]` shape is `{machine_id:
 *   [weekday_int]}` and crashes on `[{start_min, end_min}]`. Strategy A
 *   for this intent is now disabled at the data-modifier layer
 *   (canApply returns false) so the strategy-router cascades to
 *   `rule_addition` and uses `rules.unavailable_machines` — the
 *   verified-working path. The catalog YAML reflects the same change
 *   (strategy: rule_addition primary).
 *
 * Contract:
 *   - `canApply(intentId)`     → boolean (router uses this for A/B/C routing)
 *   - `apply(intentId, entities, baselineDataset?)`
 *        → { modified, dataset_overrides, rules_fallback }
 *
 * The baselineDataset is optional and currently unused — kept in the
 * signature so future overrides can deep-merge instead of full-replace
 * (e.g. shift change needs the existing shift's other fields).
 */

export interface DataModifierResult {
  modified: boolean;
  dataset_overrides: Record<string, unknown> | null;
  /**
   * Equivalent `rules` payload that the backend's existing f_apply_rules
   * consumer already understands today. The BFF sends this alongside
   * dataset_overrides so Strategy A is correct even if the backend's
   * dataset_overrides path is incomplete.
   */
  rules_fallback: Record<string, unknown> | null;
}

export interface DeadlineChangeEntities {
  order_id: string;
  new_deadline_min: number;
}

// machine_unavailability deliberately excluded — see header comment.
const SUPPORTED_INTENTS = new Set<string>([
  'deadline_change',
]);

export function canApply(intentId: string): boolean {
  return SUPPORTED_INTENTS.has(intentId);
}

function isFiniteNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * Strategy A — deadline change.
 *
 * Emits `dataset_overrides.orders.<order_id>.deadline_min` for the
 * future-compatible path AND `rules_fallback.deadline_changes` for the
 * works-today consumer. The backend uses whichever it understands; the
 * rules path is authoritative until the dataset merge is deepened.
 */
function applyDeadlineChange(
  entities: DeadlineChangeEntities,
): DataModifierResult {
  if (!isNonEmptyString(entities.order_id)) {
    return { modified: false, dataset_overrides: null, rules_fallback: null };
  }
  if (!isFiniteNonNegInt(entities.new_deadline_min)) {
    return { modified: false, dataset_overrides: null, rules_fallback: null };
  }
  return {
    modified: true,
    dataset_overrides: {
      orders: {
        [entities.order_id]: {
          deadline_min: entities.new_deadline_min,
        },
      },
    },
    rules_fallback: {
      deadline_changes: {
        [entities.order_id]: {
          new_deadline_min: entities.new_deadline_min,
        },
      },
    },
  };
}

export function apply(
  intentId: string,
  entities: Record<string, unknown>,
  _baselineDataset?: unknown,
): DataModifierResult {
  if (!canApply(intentId)) {
    return { modified: false, dataset_overrides: null, rules_fallback: null };
  }
  if (intentId === 'deadline_change') {
    return applyDeadlineChange(entities as unknown as DeadlineChangeEntities);
  }
  return { modified: false, dataset_overrides: null, rules_fallback: null };
}
