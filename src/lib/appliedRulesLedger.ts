/**
 * Wave 16.6 §C — applied-rules ledger.
 *
 * What-If and Ripianifica each re-solve from the *current* live plan, but the
 * solver itself is stateless: every call re-applies the full `rules` payload
 * from scratch against the company's base dataset. So a constraint the manager
 * already accepted ("M2 ferma il giorno 2") is forgotten the moment the next
 * What-If runs unless we carry it forward explicitly.
 *
 * This ledger is that carry. It is a slug-scoped, append-only log of the rule
 * payloads the manager has *accepted* (a candidate's "Accetta", or a
 * Ripianifica HIT). Before the next solve we fold the whole log into a single
 * `rules` object (`mergeLedgerRules`) and merge the new scenario on top
 * (`mergeRuleSlots`, new-wins). The solver then sees prior-accepted constraints
 * AND the new one together — cumulative, like the manager expects.
 *
 * Persistence: localStorage under the same `daino:<slug>:` namespace as
 * src/lib/storage.ts (so `clearSlugScoped` / the reset path wipe it too). The
 * ledger key is `applied_rules_ledger`.
 *
 * Why localStorage and not server state: the backend has no per-tenant session
 * for the deterministic-template path (TD-022), and the dashboard is a single
 * client per manager. Co-locating the ledger with the other slug-scoped UI
 * state (chat history, last run) keeps the "reset clears everything" invariant
 * trivially true.
 */

import { getSlugScoped, setSlugScoped, removeSlugScoped } from '@/lib/storage';

const LEDGER_KEY = 'applied_rules_ledger';

/** Where an accepted rule came from — purely for audit/debug, not behaviour. */
export type AppliedRuleSource = 'whatif' | 'reschedule' | 'manual';

export interface AppliedRule {
  /** Stable id (ts-based) so a future "undo last" can target one entry. */
  id: string;
  /** Epoch ms when accepted. Folding order is by array position == ts order. */
  ts: number;
  source: AppliedRuleSource;
  /** The solver `rules` slot that was accepted (unavailable_machines, …). */
  rules: Record<string, unknown>;
  /** The cutoff used when this rule was applied, if any (audit only). */
  cutoffMin?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ── slot mergers ────────────────────────────────────────────────────
// Each known rule slot has its own combine semantics. The guiding rule
// is NEW-WINS: when `b` (the newer payload) and `a` (the accumulated
// prior) both touch the same logical key, the value from `b` is the one
// that survives. This matches the manager's mental model: re-issuing a
// constraint for the same target replaces the earlier window, it does
// not stack a second one.

// unavailable_machines: { machineId: [{start_min,end_min,...}, ...] }.
// Key-union across machines. Within the SAME machine the two window lists are
// reconciled per-window (devil-advocate M-1, Wave 16.6):
//   - a NEW window that temporally OVERLAPS a prior one REPLACES it — the
//     manager re-issued/corrected that downtime (e.g. "M2 ferma 0-480" then
//     "M2 ferma 0-600"); stacking two overlapping bans would double-count.
//   - a NEW window DISJOINT from every prior one is APPENDED — two separate
//     downtimes ("M2 ferma giorno 2" AND "M2 ferma giorno 4") must BOTH
//     survive; the ledger exists to accumulate exactly this. Silently dropping
//     the earlier one loses an accepted constraint (the failure class this
//     wave fixes).
//   - identical windows dedup (no-op re-issue).
// Different machines always accumulate.
interface Window { start_min?: unknown; end_min?: unknown; [k: string]: unknown }

function winBounds(w: unknown): { s: number; e: number } | null {
  if (!w || typeof w !== 'object') return null;
  const ww = w as Window;
  const s = typeof ww.start_min === 'number' ? ww.start_min : null;
  const e = typeof ww.end_min === 'number' ? ww.end_min : null;
  if (s === null || e === null) return null;
  return { s, e };
}

// Half-open overlap test: [s1,e1) intersects [s2,e2). Touching at an endpoint
// (e1 === s2) is NOT an overlap — back-to-back bans are distinct downtimes.
function windowsOverlap(a: unknown, b: unknown): boolean {
  const wa = winBounds(a);
  const wb = winBounds(b);
  if (!wa || !wb) return false; // windows without numeric bounds never "overlap".
  return wa.s < wb.e && wb.s < wa.e;
}

function sameWindow(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeWindowLists(prior: unknown, next: unknown): unknown[] {
  const priorArr = Array.isArray(prior) ? [...prior] : [];
  const nextArr = Array.isArray(next) ? next : [];
  // Start from prior, then fold each new window in.
  const out: unknown[] = [...priorArr];
  for (const nw of nextArr) {
    if (out.some((w) => sameWindow(w, nw))) continue; // dedup identical.
    // Drop any prior window that overlaps the new one (new corrects it),
    // then append the new window.
    for (let i = out.length - 1; i >= 0; i--) {
      if (windowsOverlap(out[i], nw)) out.splice(i, 1);
    }
    out.push(nw);
  }
  return out;
}

function mergeUnavailableMachines(a: unknown, b: unknown): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (isObject(a)) Object.assign(out, a);
  if (isObject(b)) {
    for (const [machineId, nextWindows] of Object.entries(b)) {
      const priorWindows = out[machineId];
      if (priorWindows === undefined) {
        out[machineId] = nextWindows; // new machine.
      } else {
        out[machineId] = mergeWindowLists(priorWindows, nextWindows);
      }
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// priority_orders: string[]. Dedup-union, preserving order with the
// PRIOR ids first then any new ids not already present. (Order in this
// slot is not load-bearing for the solver — it's a set — but a stable
// order keeps audit diffs readable.)
function mergePriorityOrders(a: unknown, b: unknown): string[] | undefined {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (arr: unknown) => {
    if (!Array.isArray(arr)) return;
    for (const v of arr) {
      if (typeof v === 'string' && v.trim() && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  };
  push(a);
  push(b);
  return out.length > 0 ? out : undefined;
}

// deadline_changes: { orderId: {...} }. Last-write per order key — the
// newer deadline for an order replaces the prior one. Other orders carry
// forward.
// shift_changes follows the same per-key last-write shape when expressed
// as an object. When it arrives as an ARRAY (the other accepted shape,
// see hasMeaningfulShiftChanges in apply-whatif), we cannot key by id
// generically, so new-wins means "the newer array replaces the older"
// (a non-empty b array wins wholesale; else keep a).
function mergeKeyedLastWrite(a: unknown, b: unknown): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (isObject(a)) Object.assign(out, a);
  if (isObject(b)) Object.assign(out, b); // new-wins per order/shift key.
  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeArrayOrKeyed(a: unknown, b: unknown): unknown {
  // Arrays: a non-empty newer array replaces the older wholesale.
  if (Array.isArray(a) || Array.isArray(b)) {
    if (Array.isArray(b) && b.length > 0) return b;
    if (Array.isArray(a) && a.length > 0) return a;
    return Array.isArray(b) ? b : a;
  }
  return mergeKeyedLastWrite(a, b);
}

/**
 * Merge two solver-`rules` payloads with NEW-WINS semantics (`b` is the
 * newer). Known slots get type-aware combine; any unknown slot falls back
 * to a shallow new-wins overwrite so a future rule kind still carries.
 *
 * Pure — does not mutate either input.
 */
export function mergeRuleSlots(
  a: Record<string, unknown> | null | undefined,
  b: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const prior = isObject(a) ? a : {};
  const next = isObject(b) ? b : {};
  const out: Record<string, unknown> = {};

  // Start from the union of keys so unknown slots survive too.
  const keys = new Set<string>([...Object.keys(prior), ...Object.keys(next)]);

  for (const key of keys) {
    const av = prior[key];
    const bv = next[key];
    switch (key) {
      case 'unavailable_machines': {
        const merged = mergeUnavailableMachines(av, bv);
        if (merged !== undefined) out[key] = merged;
        break;
      }
      case 'priority_orders': {
        const merged = mergePriorityOrders(av, bv);
        if (merged !== undefined) out[key] = merged;
        break;
      }
      case 'deadline_changes': {
        const merged = mergeKeyedLastWrite(av, bv);
        if (merged !== undefined) out[key] = merged;
        break;
      }
      case 'shift_changes':
      case 'operator_unavailability':
      case 'extra_capacity': {
        // These arrive as array-or-object across the extractor/translator
        // paths; combine accordingly with new-wins.
        const merged = mergeArrayOrKeyed(av, bv);
        if (merged !== undefined) out[key] = merged;
        break;
      }
      default: {
        // Unknown slot: prefer the newer value when present, else the prior.
        out[key] = bv !== undefined ? bv : av;
      }
    }
  }
  return out;
}

// ── persistence ─────────────────────────────────────────────────────

/**
 * Read the full ledger for a slug (oldest-first). Returns [] on any
 * parse/availability failure or when slug is null.
 */
export function loadLedger(slug: string | null): AppliedRule[] {
  if (!slug) return [];
  const raw = getSlugScoped(LEDGER_KEY, slug);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive filter: only keep entries that carry a rules object.
    return parsed.filter(
      (e): e is AppliedRule =>
        isObject(e) && isObject((e as { rules?: unknown }).rules),
    );
  } catch {
    return [];
  }
}

function writeLedger(slug: string, entries: AppliedRule[]): void {
  try {
    setSlugScoped(LEDGER_KEY, slug, JSON.stringify(entries));
  } catch {
    // storage.ts already swallows quota errors; this catch covers
    // JSON.stringify on a pathological rules object.
  }
}

/**
 * Append one accepted rule payload to the ledger and return the new
 * ledger. No-op (returns current ledger) when slug is null or the rules
 * object is empty — an empty payload would add nothing to the fold and
 * just bloat the log.
 */
export function appendRule(
  slug: string | null,
  rule: { source: AppliedRuleSource; rules: Record<string, unknown>; cutoffMin?: number },
): AppliedRule[] {
  if (!slug) return [];
  if (!isObject(rule.rules) || Object.keys(rule.rules).length === 0) {
    return loadLedger(slug);
  }
  const ts = Date.now();
  const entry: AppliedRule = {
    id: `ar-${ts}-${Math.random().toString(36).slice(2, 8)}`,
    ts,
    source: rule.source,
    rules: rule.rules,
    ...(rule.cutoffMin !== undefined ? { cutoffMin: rule.cutoffMin } : {}),
  };
  const next = [...loadLedger(slug), entry];
  writeLedger(slug, next);
  return next;
}

/** Drop the entire ledger for a slug (called on dashboard reset). */
export function clearLedger(slug: string | null): void {
  if (!slug) return;
  removeSlugScoped(LEDGER_KEY, slug);
}

const META_KEYS = new Set(['day_anchor', 'status']);

/**
 * Wave 16.7 — remove ONE carried constraint from the ledger, rewriting every
 * entry. Powers the What-If panel's per-chip "×" so the manager can drop a
 * single stale constraint (e.g. an "M03 ferma" they didn't mean to keep)
 * WITHOUT clearing everything (that is what `clearLedger` is for).
 *
 *   - keyed slots (`unavailable_machines`, `deadline_changes`): drop `key`.
 *   - `priority_orders`: drop the order id `key` from the array.
 *   - any other slot (panel passes `key === '*'`): drop the whole slot.
 *
 * Entries left with only meta keys (day_anchor/status) or nothing are pruned.
 */
export function removeConstraintFromLedger(
  slug: string | null,
  slot: string,
  key: string,
): void {
  if (!slug) return;
  const entries = loadLedger(slug);
  if (entries.length === 0) return;
  const next: AppliedRule[] = [];
  for (const entry of entries) {
    const rules: Record<string, unknown> = isObject(entry.rules) ? { ...entry.rules } : {};
    const slotVal = rules[slot];
    if (slot === 'priority_orders') {
      if (Array.isArray(slotVal)) {
        const filtered = slotVal.filter((v) => v !== key);
        if (filtered.length > 0) rules[slot] = filtered;
        else delete rules[slot];
      }
    } else if (slot === 'unavailable_machines' || slot === 'deadline_changes') {
      if (isObject(slotVal)) {
        const copy = { ...slotVal };
        delete copy[key];
        if (Object.keys(copy).length > 0) rules[slot] = copy;
        else delete rules[slot];
      }
    } else {
      // Non-keyed slot (panel passes key='*') → drop the whole slot.
      delete rules[slot];
    }
    // Keep the entry only if it still carries a real (non-meta) rule slot.
    const meaningful = Object.keys(rules).filter((k) => !META_KEYS.has(k));
    if (meaningful.length > 0) next.push({ ...entry, rules });
  }
  if (next.length > 0) writeLedger(slug, next);
  else clearLedger(slug);
}

/**
 * Fold the ledger (or an explicit entry list) into a single cumulative
 * `rules` payload, applying each entry in chronological order with
 * new-wins semantics. The most-recently-accepted rule therefore takes
 * precedence on any conflicting slot.
 *
 * Accepts either a slug (loads the ledger) or a pre-loaded AppliedRule[]
 * so callers that already hold the array don't re-read localStorage.
 */
export function mergeLedgerRules(
  source: string | null | AppliedRule[],
): Record<string, unknown> {
  const entries = Array.isArray(source) ? source : loadLedger(source);
  let acc: Record<string, unknown> = {};
  for (const entry of entries) {
    acc = mergeRuleSlots(acc, entry.rules);
  }
  return acc;
}

// ── skipped-rule presentation (Wave 17 H1/M2) ───────────────────────
// Single source of truth for turning a BE/BFF skipped-rule audit entry
// (`{type, reason?, machine_id?|operator_id?|job_id?|shift_id?}`) into a
// manager-facing Italian line. Shared by the apply-whatif BFF rollup and the
// ReplanModal reschedule path so both surface IDENTICAL wording (anti-drift).
// Fail-OPEN: an unmapped reason falls back to the raw reason string — never
// hidden, so a new BE reason still surfaces something truthful.
export const SKIP_REASON_IT: Record<string, string> = {
  'machine_id not in current dataset': 'macchina non presente nel piano corrente',
  already_blocked_by_window_or_maintenance: 'già bloccata da una finestra o manutenzione esistente',
  dual_resource_disabled: 'gestione operatori non attiva su questo dataset',
  time_config_day_length_missing: 'durata giornata non configurata',
  missing_or_sentinel_operator_id: 'operatore non identificato',
  operator_id_not_in_dataset: 'operatore non presente nel piano corrente',
  invalid_time_window: 'finestra oraria non valida',
  missing_date: 'data mancante',
  date_not_parseable_or_start_date_missing: 'data non interpretabile',
  window_after_horizon: "finestra oltre l'orizzonte di pianificazione",
  window_clipped_to_empty: 'finestra ridotta a vuoto',
  overlaps_already_applied_window_same_operator: 'finestra già coperta per lo stesso operatore',
  'job_id not in current dataset': 'commessa non presente nel piano corrente',
  dataset_not_dual_resource: 'dataset senza doppia risorsa (capacità extra non applicabile)',
  missing_shift_id: 'turno non specificato',
  unknown_shift_id: 'turno non riconosciuto',
  invalid_extra_operators: 'numero operatori extra non valido',
  no_shift_types_in_dataset: 'nessun tipo di turno definito nel dataset',
  // Wave 17 #3 — the remaining shift_change_skipped reasons (f_apply_rules.py
  // 1004-1061), previously fail-open to English for Italian managers.
  shift_entry_not_dict: 'formato del turno non valido',
  no_bounds_provided: 'nessun orario di inizio o fine indicato',
  invalid_range: 'intervallo orario non valido (fine prima o uguale all\'inizio)',
  end_exceeds_day_length: 'orario di fine oltre la durata della giornata',
};

export function skipKindLabel(type: string): string {
  if (type.startsWith('unavailable_machine')) return 'Blocco macchina';
  if (type.startsWith('operator_unavailable')) return 'Indisponibilità operatore';
  if (type.startsWith('priority_order')) return 'Priorità commessa';
  if (type.startsWith('deadline_change')) return 'Cambio scadenza';
  if (type.startsWith('extra_capacity')) return 'Capacità extra';
  if (type.startsWith('shift_change')) return 'Cambio turno';
  return 'Regola';
}

export function skipRuleTarget(entry: Record<string, unknown>): string | undefined {
  for (const key of ['machine_id', 'operator_id', 'job_id', 'shift_id', 'id'] as const) {
    const v = entry[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** One manager-facing skipped-rule line. */
export function formatSkippedRule(entry: { type?: unknown; reason?: unknown; [k: string]: unknown }): string {
  const type = typeof entry.type === 'string' ? entry.type : '';
  const target = skipRuleTarget(entry as Record<string, unknown>);
  const rawReason = typeof entry.reason === 'string' && entry.reason.trim()
    ? entry.reason
    : 'motivo non specificato';
  const reasonIt = SKIP_REASON_IT[rawReason] ?? rawReason;
  const kind = skipKindLabel(type);
  return target ? `${kind} ${target} ignorata: ${reasonIt}.` : `${kind} ignorata: ${reasonIt}.`;
}

/** A rolled-up skipped-rule entry (type + target + reason + manager message). */
export interface SkippedRule {
  type: string;
  target?: string;
  reason: string;
  message: string;
}

// A backend wave7.apply_rules entry is a "skip" (not an applied/effective entry)
// when its type marks it skipped/failed/passthrough. `_noop` is included: the
// rule was accepted but had ZERO effect (e.g. machine already blocked), which
// the manager should still see rather than count as applied.
export function isSkippedRuleEntry(type: string): boolean {
  return (
    type.endsWith('_skipped')
    || type.endsWith('_noop')
    || type.endsWith('_data_layer_passthrough')
    || type === 'apply_rules_failed'
  );
}

/**
 * Build the manager-facing per-rule reason rollup from a backend
 * wave7.apply_rules audit log. Shared by the apply-whatif BFF route and the
 * reschedule-fresh route so both surfaces render IDENTICAL skip wording
 * (anti-drift, Wave 17 M2/B-2). Returns [] when nothing was skipped.
 */
export function buildSkippedRulesRollup(
  applyRules: Array<Record<string, unknown>>,
): SkippedRule[] {
  const out: SkippedRule[] = [];
  if (!Array.isArray(applyRules)) return out;
  for (const entry of applyRules) {
    if (!entry || typeof entry !== 'object') continue;
    const type = typeof entry.type === 'string' ? entry.type : '';
    if (!type || !isSkippedRuleEntry(type)) continue;
    const target = skipRuleTarget(entry);
    const rawReason = typeof entry.reason === 'string' && entry.reason.trim()
      ? entry.reason
      : 'motivo non specificato';
    out.push({
      type,
      ...(target ? { target } : {}),
      reason: rawReason,
      message: formatSkippedRule(entry),
    });
  }
  return out;
}

// ── presentation ────────────────────────────────────────────────────
// Wave 16.6 (Option A) — a human-readable summary of the cumulative
// priorRules carried into the next What-If, so the manager SEES which
// previously-accepted constraints are still being re-applied. This is the
// fix for the "everything slid to the next day" surprise: a stale
// "M01 ferma giorno 1" + "COM-012 prioritaria" from earlier experiments
// were folded into "anticipo COM-007" invisibly, which (M01 down all day 1
// + COM-012 forced first) pushed every other order to day 2. The carry is
// intentional (sequential replanning); making it visible removes the
// surprise. Pure + presentation-only — the solver never reads this.

// Legacy fallback when the real working-day length is unknown (a calendar
// day). The actual day length is data-dependent (demo-commesse uses 960, a
// 06:00–22:00 working day) and passed in via opts.dayLengthMin.
const DAY_MIN = 1440;

/** One carried constraint for the panel: human label + the (slot,key) needed
 *  to remove just this one via removeConstraintFromLedger. */
export interface LedgerConstraintLabel {
  label: string;
  slot: string;
  /** machine/order id for keyed slots, or '*' for whole-slot constraints. */
  key: string;
}

// Format minutes-since-midnight as HH:MM (e.g. 600 → "10:00", 1320 → "22:00").
// The input is wrapped into [0,1440) so a clock that overflows 24h stays correct
// on a hypothetical night-shift plant whose working day crosses midnight (start
// 22:00, +5h → "03:00", not "27:00"). Unreachable with today's data model
// (company_end ≤ 1439, so company_start_hour*60 + day_length_min < 1440) but the
// wrap costs nothing and keeps the label honest if such a plant is onboarded
// (devil-advocate F-1; aligns with the scale-to-any-plant requirement).
function fmtClock(minFromMidnight: number): string {
  const m = ((minFromMidnight % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// "giorno N" from a window. Uses the REAL working-day length when known
// (dayLengthMin) — the hard-coded 1440 mislabelled demo windows (day=960) as
// "giorno 1-2" instead of "giorno 2". Falls back to an explicit `date` field,
// then to the calendar-day guess.
//
// Wave 16.9 — a PARTIAL-day window (not aligned to day boundaries) additionally
// shows the wall-clock ("giorno 1 · 06:00–10:00") so the manager sees it is NOT
// a whole-day stop. The clock needs `companyStartHour` to map solver minutes
// (minute 0 = day 1 at company_start) back to the clock; without it we keep the
// day-only label rather than render a wrong time. Whole-day windows stay
// "giorno N" (no redundant 06:00–22:00).
function describeWindow(
  w: unknown,
  dayLengthMin?: number,
  companyStartHour?: number,
): string | null {
  const b = winBounds(w);
  if (b) {
    const L = typeof dayLengthMin === 'number' && dayLengthMin > 0 ? dayLengthMin : DAY_MIN;
    const startDay = Math.floor(b.s / L) + 1;
    // end is exclusive: [960,1920) with L=960 reads "giorno 2", not "2-3".
    const endDay = Math.floor(Math.max(b.s, b.e - 1) / L) + 1;
    const dayLabel = startDay === endDay ? `giorno ${startDay}` : `giorno ${startDay}-${endDay}`;

    // Whole-day(s) block (both bounds land on a day boundary) → day label only.
    // Otherwise it is a partial window: when it sits within a single day AND we
    // know the plant's start hour, append the clock.
    const isWholeDays = b.s % L === 0 && b.e % L === 0;
    const csh =
      typeof companyStartHour === 'number' && companyStartHour >= 0 ? companyStartHour : null;
    if (!isWholeDays && startDay === endDay && csh !== null) {
      const startWithin = b.s % L;
      // end is exclusive: end_min on a day boundary means "end of day", not the
      // next day's open — map 0 back to L so {120,960} reads 08:00–22:00.
      const endWithin = b.e % L === 0 ? L : b.e % L;
      const clockStart = fmtClock(csh * 60 + startWithin);
      const clockEnd = fmtClock(csh * 60 + endWithin);
      return `${dayLabel} · ${clockStart}–${clockEnd}`;
    }
    return dayLabel;
  }
  // No numeric bounds: fall back to an explicit `date` field if present.
  if (isObject(w) && typeof w.date === 'string' && w.date.trim()) return w.date.trim();
  return null;
}

function slotHasContent(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (isObject(v)) return Object.keys(v).length > 0;
  return false;
}

/**
 * Turn a folded `rules` payload into per-constraint labels for display, each
 * tagged with the (slot,key) needed to remove it individually. Returns [] when
 * there is nothing meaningful to show. Non-rule/meta keys (day_anchor, status,
 * …) are ignored so the panel only lists real constraints.
 *
 * `opts.dayLengthMin` (from time_config.day_length_min) makes the "giorno N"
 * label correct for the company's working-day length. `opts.companyStartHour`
 * (time_config.company_start_hour) lets partial-day windows show the wall-clock
 * ("giorno 1 · 06:00–10:00") instead of an all-day-looking "giorno 1".
 */
export function describeLedgerRules(
  rules: Record<string, unknown> | null | undefined,
  opts?: { dayLengthMin?: number; companyStartHour?: number },
): LedgerConstraintLabel[] {
  if (!isObject(rules)) return [];
  const dayLengthMin = opts?.dayLengthMin;
  const companyStartHour = opts?.companyStartHour;
  const out: LedgerConstraintLabel[] = [];

  const um = rules.unavailable_machines;
  if (isObject(um)) {
    for (const machine of Object.keys(um).sort()) {
      const wins = um[machine];
      const labels = Array.isArray(wins)
        ? wins
            .map((w) => describeWindow(w, dayLengthMin, companyStartHour))
            .filter((x): x is string => x !== null)
        : [];
      out.push({
        label: labels.length > 0 ? `${machine} ferma (${labels.join(', ')})` : `${machine} ferma`,
        slot: 'unavailable_machines',
        key: machine,
      });
    }
  }

  const po = rules.priority_orders;
  if (Array.isArray(po)) {
    for (const id of po) {
      if (typeof id === 'string' && id.trim()) {
        out.push({ label: `${id} prioritaria`, slot: 'priority_orders', key: id });
      }
    }
  }

  const dc = rules.deadline_changes;
  if (isObject(dc)) {
    for (const id of Object.keys(dc)) {
      out.push({ label: `scadenza ${id} modificata`, slot: 'deadline_changes', key: id });
    }
  }

  if (slotHasContent(rules.shift_changes)) {
    out.push({ label: 'turni modificati', slot: 'shift_changes', key: '*' });
  }
  if (slotHasContent(rules.extra_capacity)) {
    out.push({ label: 'capacità extra', slot: 'extra_capacity', key: '*' });
  }
  if (slotHasContent(rules.operator_unavailability)) {
    out.push({ label: 'operatore non disponibile', slot: 'operator_unavailability', key: '*' });
  }

  return out;
}
