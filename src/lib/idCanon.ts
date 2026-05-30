/**
 * Wave 16.6 — Shared canonical-id resolver.
 *
 * Extracted verbatim from `strategy-router.ts` (B-W8-S-01, stress-engineer
 * 2026-05-22) so the new Haiku instruction-interpreter and the chat-manager
 * alias path can reuse the SAME deterministic id-canonicalisation that the
 * what-if strategy router already trusts. Single source of truth: a change to
 * the padding/separator probe must apply everywhere an LLM-emitted id is
 * re-validated against the closed set.
 *
 * Haiku (and managers) emit `M2`, `M-2`, `m2`, `M 2`, `M02` interchangeably
 * while the baseline canonical form is zero-padded (`M02`). This probes a few
 * canonical variants — original case, uppercase, alphanumeric-only, zero-padded
 * numeric tail, leading-zero-stripped — and returns the FIRST one present in
 * `known`. Pure-deterministic; no LLM, no cost. Returns null if nothing matches
 * so the caller falls back to the unresolved/reject path (NEVER fabricates an id).
 */
export function canonicaliseId(raw: string, known: Set<string>): string | null {
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
