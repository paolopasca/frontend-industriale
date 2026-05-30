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

  // TIER 1 — "exact tier": the token as the manager wrote it, modulo trivial
  // case folding and separator stripping. A hit here means the manager typed a
  // real id (or its bare form); it is unambiguous by definition and takes
  // precedence over any padding-derived guess. Probed in order so the closest
  // literal form wins.
  const alnum = raw.replace(/[^a-zA-Z0-9]/g, '');
  const exactTier: string[] = [];
  const pushExact = (s: string) => {
    if (s && !exactTier.includes(s)) exactTier.push(s);
  };
  pushExact(raw);
  pushExact(raw.toUpperCase());
  pushExact(alnum);
  pushExact(alnum.toUpperCase());
  for (const cand of exactTier) {
    if (known.has(cand)) return cand;
  }

  // TIER 2 — "derived tier": zero-pad / strip numeric tail / re-separate.
  // Matches "m2"→"M02", "COM7"→"COM-007", etc. This tier GUESSES at the
  // canonical width/separator, so it CAN map one token onto two different real
  // ids when a plan mixes padded + unpadded forms for the same number
  // (e.g. known={"M1","M-001"} and token "m001" → both "M1" and "M-001").
  // M-3 (devil-advocate Wave 16.6, 2026-05-30): the pre-fix code returned the
  // FIRST such match by push-order, silently resolving to the WRONG real
  // machine (high confidence, no gray) — a breach of the resolver's
  // ambiguous→null contract (not a hallucination: always a real member, just
  // the wrong one). Fix: collect ALL distinct derived members and return the
  // single match, or null on >1 so the caller surfaces a clarify ("?") instead
  // of editing the wrong resource.
  const derived: string[] = [];
  const pushDerived = (s: string) => {
    if (s && !derived.includes(s)) derived.push(s);
  };
  const m = alnum.match(/^([A-Za-z]+)(\d+)$/);
  if (m) {
    const prefix = m[1].toUpperCase();
    const num = parseInt(m[2], 10);
    if (Number.isFinite(num)) {
      for (const width of [2, 3, 4]) {
        pushDerived(`${prefix}${String(num).padStart(width, '0')}`);
      }
      pushDerived(`${prefix}${num}`);
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
        pushDerived(`${prefix}-${String(num).padStart(width, '0')}`);
      }
      pushDerived(`${prefix}-${num}`);
    }
  }
  const derivedMatches = new Set<string>();
  for (const cand of derived) {
    if (known.has(cand)) derivedMatches.add(cand);
  }
  if (derivedMatches.size === 1) return [...derivedMatches][0];
  // 0 matches → unresolved; >1 → ambiguous. Both → null (never guess).
  return null;
}
