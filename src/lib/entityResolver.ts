import { canonicaliseId } from './idCanon';
import { buildMachineAliases, type SolutionContext } from './solutionContext';

/**
 * Wave 16.6 — Shared entity resolver (deterministic, no LLM).
 *
 * Maps a manager-written token ("m2", "linea 2", "M-02", "COM-7") to the
 * CANONICAL id of the current plan's closed set (ctx.machines / ctx.orders /
 * ctx.shifts). This is the single resolution primitive shared by:
 *   - the Haiku instruction-interpreter gate (re-validate enum picks),
 *   - the chat-manager alias path (B-W16.6, m2 → M02 before a tool call).
 *
 * HARD anti-hallucination contract:
 *   - The returned id is ALWAYS a member of the closed set, or `null`.
 *   - It NEVER fabricates an id. An off-set token ("M99", "linea 42") → null.
 *   - AMBIGUOUS tokens → null. If a token could map to two different members
 *     of the set (e.g. an alias collision), we refuse rather than guess.
 *     A null (caller surfaces "?"/clarify) is always safer than a wrong id
 *     that silently no-ops or, worse, edits the wrong machine.
 *
 * Resolution order (first definite hit wins; ties at the SAME stage = null):
 *   1. exact membership (already canonical),
 *   2. canonicaliseId padding/separator probe against the closed set,
 *   3. collision-safe alias map (lowercase, "m1", "m-1", "linea N", "macchina N").
 */

function isPresent(token: string): token is string {
  return typeof token === 'string' && token.trim().length > 0;
}

/**
 * Resolve `token` against an explicit closed set + a precomputed alias map.
 * Generic core used by the machine/order/shift helpers below.
 *
 * @param closedSet canonical ids of the current plan (the ONLY valid outputs)
 * @param aliases   optional collision-safe alias→canonical map (machines only)
 */
export function resolveAgainstSet(
  token: string,
  closedSet: readonly string[],
  aliases?: Record<string, string>,
): string | null {
  if (!isPresent(token)) return null;
  if (closedSet.length === 0) return null;
  const trimmed = token.trim();
  const known = new Set(closedSet);

  // 1. Exact (already canonical) — cheapest, unambiguous.
  if (known.has(trimmed)) return trimmed;

  // 2. Deterministic padding/separator canonicalisation (m2/M-2/M02 → M02).
  //    canonicaliseId only ever returns a member of `known`, never a fabrication.
  const canon = canonicaliseId(trimmed, known);
  if (canon !== null) return canon;

  // 3. Collision-safe alias map. buildMachineAliases already DROPS any alias
  //    key that two canonical ids would both claim, so a hit here is by
  //    construction unambiguous. Match case-insensitively / whitespace-folded
  //    to mirror how the backend extractor looks up aliases.
  if (aliases) {
    const key = trimmed.toLowerCase().replace(/\s+/g, ' ');
    const hit = aliases[key];
    if (hit !== undefined && known.has(hit)) return hit;
  }

  return null;
}

/**
 * Resolve a machine token to a canonical machine id from the plan, or null.
 * Uses ctx.machine_aliases when present, else rebuilds the collision-safe
 * alias map from ctx.machines (so callers that only carry the id list still
 * get "linea 2"/"m2" coverage).
 */
export function resolveMachineAlias(token: string, ctx: SolutionContext): string | null {
  const aliases =
    ctx.machine_aliases && Object.keys(ctx.machine_aliases).length > 0
      ? ctx.machine_aliases
      : buildMachineAliases(ctx.machines);
  return resolveAgainstSet(token, ctx.machines, aliases);
}

/**
 * Resolve an order/commessa token to a canonical order id from the plan, or null.
 * Orders have no NL alias map (managers cite the id, e.g. "COM-7"); padding/
 * separator canonicalisation handles "COM7" / "com-007" → "COM-007".
 */
export function resolveOrderAlias(token: string, ctx: SolutionContext): string | null {
  return resolveAgainstSet(token, ctx.orders, undefined);
}

/**
 * Resolve a shift token to a canonical shift id/name from the plan, or null.
 * Accepts the canonical "turno_mattina" form, the bare "mattina" form, and
 * case variants. Refuses (null) when the plan exposes no shift_types (the
 * closed set is empty → nothing to resolve against).
 */
export function resolveShiftAlias(token: string, ctx: SolutionContext): string | null {
  if (!isPresent(token)) return null;
  if (ctx.shifts.length === 0) return null;
  const trimmed = token.trim();
  const known = new Set(ctx.shifts);
  if (known.has(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  // Build a collision-safe alias map: canonical shift id + a "turno_"-stripped
  // bare form. Drop any bare alias two shifts would both claim.
  const proposals = new Map<string, string>();
  const ambiguous = new Set<string>();
  const add = (k: string, canonical: string) => {
    if (ambiguous.has(k)) return;
    const existing = proposals.get(k);
    if (existing !== undefined && existing !== canonical) {
      proposals.delete(k);
      ambiguous.add(k);
      return;
    }
    proposals.set(k, canonical);
  };
  for (const s of ctx.shifts) {
    const sl = s.toLowerCase();
    if (sl !== s) add(sl, s);
    const bare = sl.replace(/^turno[_\s-]*/, '');
    if (bare && bare !== sl) add(bare, s);
  }
  const hit = proposals.get(lower);
  return hit !== undefined && known.has(hit) ? hit : null;
}
