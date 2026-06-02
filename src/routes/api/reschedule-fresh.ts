import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  checkRateLimit,
  getClientIp,
} from '@/server/llm/client';
import { extractConstraintFromBackend } from '@/server/llm/extract-constraint-client';
import { interpretInstruction } from '@/server/llm/instruction-interpreter';
import { buildAiSolutionEnvelope } from '@/lib/aiInputs';
import { buildSolutionContext, dayLengthMinFromBaseline } from '@/lib/solutionContext';
import {
  buildFrozenPhases,
  type FrozenPhase,
} from '@/server/llm/frozen-window-builder';
import { resolveTemplate, type ResolveTemplateFrozenPhase } from '@/lib/api';

/**
 * Wave 16.4 C4 / Wave 16.5 B1+B3 — fresh re-solve.
 *
 * Originally a fallback for /api/analysis/{sid}/reschedule session_not_found,
 * this route is now the PRIMARY ripianifica path for deterministic-template
 * plans (Wave 16.5 B1). The authenticated warm-start endpoint requires a
 * `generated_code` artifact that deterministic-template runs never emit
 * (TD-022), so its `run_id` handle is non-functional for the default product
 * path — the manager would always get "Run not found".
 *
 * Pipeline:
 *   1. Build a real SolutionContext from the baseline so the backend
 *      extract-constraint endpoint can resolve entity aliases ("m1" → "M-1").
 *      Wave 16.5 B3 fix: the old `minimalSolutionContext` produced the wrong
 *      shape (a `{slug, baseline}` wrapper) AND read `solution.machines` as a
 *      pre-flattened string[] that no real baseline carries, so every
 *      entity-referencing utterance collapsed to MISS. `buildSolutionContext`
 *      walks `solution.fasi` / `solution.solution[commessa].fasi` to recover
 *      machines + machine_aliases + orders.
 *   2. Extract a deterministic constraint payload (Wave 16.1 endpoint).
 *   3. Freeze the schedule up to a cutoff (currentTimeMin + cushion, or a
 *      future scenario boundary like "domani") via buildFrozenPhases, then
 *      re-solve from scratch (forceColdStart) against the company's current
 *      data. ~25 s but always produces a fresh plan.
 *
 * Response is solve-template shaped so the client can hand it to
 * `setBackendResult` exactly like ReplanModal's primary path.
 */

const BodySchema = z.object({
  slug: z.string().min(1),
  message: z.string().min(3).max(4_000),
  problemType: z.string().min(1).max(64).optional(),
  // Baseline solution context. Threaded by ReplanModal (Wave 16.4 HIGH-3) so
  // the extractor sees non-empty machines/orders and the frozen-window
  // builder has phases to lock. Optional so the legacy session_not_found
  // fallback (no baseline in hand) still degrades to an empty-context solve.
  baselineSolution: z.unknown().optional(),
  // Wave 16.5 B3 — planning clock for the frozen window. cutoffMin =
  // currentTimeMin + cushionMin (or a detected future scenario boundary).
  // Absent → no cutoff → full fresh solve with no frozen past.
  currentTimeMin: z.number().int().min(0).max(10_000_000).optional(),
  cushionMin: z.number().int().min(0).max(1_440).default(30),
});

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Recover the commessa-keyed baseline map ({ COM-001: { fasi: [...] } }) that
 * buildFrozenPhases expects. The baseline arrives in one of three shapes:
 *   - raw backend response: { status, solution: { COM-001: {...} }, kpis }
 *   - normalised AiSolutionEnvelope: { commesse: { COM-001: {...} }, fasi, ... }
 *   - already the commessa map (defensive).
 * buildFrozenPhases reads `entry.fasi` per commessa, so we hand it whichever
 * of these carries the per-job `fasi` arrays.
 */
function baselineCommessaMap(baseline: unknown): unknown {
  if (!baseline || typeof baseline !== 'object') return {};
  const root = baseline as Record<string, unknown>;
  if (root.solution && typeof root.solution === 'object') return root.solution;
  if (root.commesse && typeof root.commesse === 'object') return root.commesse;
  return root;
}

/**
 * Normalise the baseline into the flat-`fasi` envelope that
 * buildSolutionContext reads for machine recovery, while preserving the
 * root-level time_config / shift_types the envelope drops. Returns whatever
 * was passed unchanged when it isn't a usable object (buildSolutionContext
 * degrades to empty arrays from there).
 */
function contextInput(baseline: unknown): unknown {
  if (!baseline || typeof baseline !== 'object') return baseline;
  const root = baseline as Record<string, unknown>;
  // Already normalised (carries a flat fasi[]) → pass through.
  if (Array.isArray(root.fasi)) return root;
  const envelope = buildAiSolutionEnvelope(root);
  return {
    ...envelope,
    // Root passthrough so extractTimeConfig / extractShiftTypes still hit.
    time_config: root.time_config,
    shift_types: root.shift_types,
  };
}

// dayLengthMinFromBaseline moved to @/lib/solutionContext (Wave 16.8 — shared
// with apply-whatif so both paths source the working-day unit identically).

/**
 * Wave 16.5-RE2 — the manager's "siamo al giorno N" anchor, parsed by the
 * extractor (be-temporal #8) and carried 1-based inside `payload.day_anchor`.
 * Returns null when absent or not a positive integer. The matching
 * needs_day_clarification flag (also in payload) is read separately and
 * short-circuits BEFORE this is used (see handler).
 */
function dayAnchorFromPayload(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const n = (payload as Record<string, unknown>).day_anchor;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null;
}

export const Route = createFileRoute('/api/reschedule-fresh')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ip = getClientIp(request);
        // Cold-start solve is expensive ($/min/CP-SAT). Same 5/h bucket
        // semantics as the primary chat-reschedule path.
        const rl = checkRateLimit(`${ip}:reschedule_fresh`);
        if (!rl.ok) {
          return jsonError(429, 'rate_limited', `Limite di ${rl.limit} ricalcoli/ora superato.`);
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
        const input = parsed.data;

        // Step 1 — extract a deterministic constraint payload from the
        // manager's text. The Wave 16.1 endpoint returns a `payload` dict
        // shaped like the solver's `rules` argument when result==='hit'.
        // On miss/gray_zone we surface the rationale so the manager can
        // rephrase rather than triggering a no-op solve.
        //
        // Wave 16.5 B3 — buildSolutionContext recovers machines +
        // machine_aliases + orders from the baseline so "m1"/"linea 1"
        // resolve to the canonical machine string. Without aliases the
        // backend extractor MISSes every entity-referencing utterance.
        //
        // buildSolutionContext reads machines from a FLAT `fasi[]` array, but
        // the baseline arrives in the raw backend shape ({ solution: {
        // COM-001: { fasi } } }) which has no top-level fasi. Normalise it
        // first so machines are recovered, then splice back the root-level
        // time_config / shift_types (which the envelope drops) so shift- and
        // deadline-aware patterns still resolve.
        const ctx = buildSolutionContext(contextInput(input.baselineSolution), {});
        const extracted = await extractConstraintFromBackend(input.message, ctx);

        if (!extracted) {
          return jsonError(
            502,
            'extract_unavailable',
            'Il servizio di estrazione vincoli non e raggiungibile. Riprova fra un momento o avvia un nuovo solve from-scratch.',
          );
        }

        // Wave 16.5-RE2 — ask-flow gate. When the extractor signals that the
        // utterance carries a relative date ("oggi"/"domani") but NO explicit
        // day anchor, we MUST ask the manager which plan-day it is before
        // freezing/solving: day-0 is anchored to min(deadline), not the system
        // clock (TD-030), so the payload's fallback day-0 window is unreliable.
        //
        // This check is intentionally placed BEFORE the miss/gray/hit branches
        // (devil-advocate Option 1): the "needs_day_clarification ⇒ never
        // resolveTemplate" property is then structural — independent of how the
        // extractor maps `result` — so a future contract change cannot let an
        // un-anchored utterance fall through to a blind solve. payload may be
        // null (MISS), hence optional chaining.
        if (
          extracted.payload
          && typeof extracted.payload === 'object'
          && (extracted.payload as Record<string, unknown>).needs_day_clarification === true
        ) {
          return new Response(
            JSON.stringify({
              ok: false,
              code: 'needs_day',
              rationale: extracted.rationale,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        // Wave 16.6 §A — interpreter fallback on MISS/GRAY. The deterministic
        // backend extractor is pattern-based and misses utterances the
        // closed-set Haiku interpreter can still map ("m2 rotta" with a loose
        // alias, an intent phrased outside the extractor's templates). On a
        // non-hit we give interpretInstruction a second pass over the SAME ctx.
        //   - interpreter 'hit'    → use its payload as the rules and SOLVE
        //                            (fall through below, like an extractor hit).
        //   - interpreter 'gray'   → ask for confirmation (extract_gray_zone shape).
        //   - interpreter 'reject' → keep the extractor's original miss/gray
        //                            response (no worse than before).
        // The needs_day_clarification short-circuit ABOVE is untouched — an
        // un-anchored relative-date utterance never reaches this fallback.
        let rules: Record<string, unknown>;
        if (extracted.result === 'hit') {
          rules = (extracted.payload ?? {}) as Record<string, unknown>;
        } else {
          // Wave 16.8 (F-TEMP-02): pass the manager's day anchor so Haiku's
          // "oggi"/"domani" resolve to the right plan-day, not always day 1.
          // Sourced from the extractor's payload ("siamo al giorno N").
          const interp = await interpretInstruction(
            input.message,
            ctx,
            dayAnchorFromPayload(extracted.payload) ?? undefined,
          );
          const ix = interp.interpretation;
          if (ix.result === 'hit') {
            rules = ix.payload;
          } else if (ix.result === 'gray') {
            return new Response(
              JSON.stringify({
                ok: false,
                code: 'extract_gray_zone',
                rationale: extracted.rationale,
                confirmationMessage: ix.confirmation_message ?? extracted.confirmation_message,
                confidence: ix.confidence,
                payload: ix.payload,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          } else if (extracted.result === 'gray_zone') {
            // Both the extractor and the interpreter declined; surface the
            // extractor's gray-zone confirmation prompt (richer rationale).
            return new Response(
              JSON.stringify({
                ok: false,
                code: 'extract_gray_zone',
                rationale: extracted.rationale,
                confirmationMessage: extracted.confirmation_message,
                confidence: extracted.confidence,
                payload: extracted.payload,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          } else {
            // extractor MISS + interpreter reject → clarify.
            return new Response(
              JSON.stringify({
                ok: false,
                code: 'extract_miss',
                rationale: ix.confirmation_message ?? extracted.rationale,
                confidence: extracted.confidence,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
        }

        const problemType = input.problemType ?? 'fjsp';

        // Step 2 — frozen window. Re-solving from scratch must NOT reshuffle
        // work the shop has already done. Freeze every phase that finishes at
        // or before the cutoff and let the solver replan the rest.
        //
        // Wave 16.5-RE2 — PRIMARY path: the manager's explicit day anchor
        // ("siamo al giorno N", 1-based) → freeze the completed days 1..N-1.
        // cutoffMin = (N-1) × day_length_min. day_length_min comes from the
        // baseline's time_config (e.g. 960 for a 16h day), NOT 1440 — the model
        // axis compresses nights, so a calendar day would over-freeze half of
        // day N (TD-031). We deliberately do NOT reuse detectScenarioStartMin
        // for the anchor, since it hardcodes DAY_MIN=1440.
        //   day_anchor=1 → cutoff 0 → freeze nothing (we're at the start).
        //   day_anchor=2 → cutoff 1×dl → freeze day 1 (end_min <= dl).
        //
        // FALLBACK path (no day_anchor): the ONLY legitimate cutoff source is an
        // explicit currentTimeMin ("freeze up to the wall clock"). Wave 16.5 #6
        // removed the detectScenarioStartMin(message) fallback that used to live
        // here: it re-parsed dopodomani/fra-N/giorno-N from the text at calendar
        // DAY_MIN=1440 (wrong unit: the model axis compresses nights → TD-031)
        // AND anchored to day-0=wall-clock (wrong: day-0 is deadline-anchored,
        // see ReplanModal.tsx + B1 eea9dea). It was also UNREACHABLE once the BE
        // ask-flow gate (_REL_DATE_SCAN_RX) began firing needs_day_clarification
        // for every relative-date form (oggi/domani/dopodomani/fra-N) without a
        // day anchor — those short-circuit upstream as gray_zone and never reach
        // this hit-path. With neither day_anchor nor currentTimeMin → no cutoff
        // (full-horizon replan), the documented TD-030 limit.
        const dayAnchor = dayAnchorFromPayload(extracted.payload);
        const dayLengthMin = dayLengthMinFromBaseline(input.baselineSolution);

        let cutoffMin: number | undefined;
        let cutoffSource: 'day_anchor' | 'scenario_or_clock' | 'none' = 'none';
        if (dayAnchor !== null) {
          // An explicit day anchor is authoritative. Only the (N-1)*day_length
          // formula is correct here — so when day_length is unknown we skip the
          // freeze rather than fall through to detectScenarioStartMin, which
          // would RE-parse "giorno 2" from the text with the wrong calendar
          // DAY_MIN=1440 unit (TD-031) and produce a bogus cutoff.
          if (dayLengthMin !== null) {
            cutoffMin = (dayAnchor - 1) * dayLengthMin;
            cutoffSource = 'day_anchor';
          }
          // else: cutoffMin stays undefined, cutoffSource 'none' → no freeze.
        } else if (input.currentTimeMin !== undefined) {
          cutoffMin = input.currentTimeMin + input.cushionMin;
          cutoffSource = 'scenario_or_clock';
        }
        // else: neither day_anchor nor currentTimeMin → cutoffMin undefined,
        // cutoffSource 'none' → full-horizon replan (TD-030).

        const frozenPhases: FrozenPhase[] =
          cutoffMin !== undefined && cutoffMin > 0
            ? buildFrozenPhases(baselineCommessaMap(input.baselineSolution), cutoffMin)
            : [];

        try {
          const solveResult = await resolveTemplate(
            input.slug,
            problemType,
            rules,
            cutoffMin,
            frozenPhases as ResolveTemplateFrozenPhase[],
            undefined, // datasetOverrides: extract-constraint emits rules only.
            undefined, // frozenLockMode: backend default 'hard'.
            true, // forceColdStart: a fresh solve must ignore the stale warm-start plan.
          );
          return new Response(
            JSON.stringify({
              ok: true,
              code: 'solved_fresh',
              extracted_pattern_id: extracted.pattern_id,
              cutoff_min: cutoffMin ?? null,
              cutoff_source: cutoffSource,
              // Echo the resolved day anchor so the client can render
              // "ricalcolato dal giorno N (giorni precedenti congelati)".
              day_anchor: dayAnchor,
              frozen_count: frozenPhases.length,
              // Wave 16.6 §C — the extracted rule slot that produced this plan.
              // The client appends it to the applied-rules ledger so the next
              // What-If / Ripianifica re-applies it (cumulative constraints).
              applied_rules: rules,
              result: {
                status: solveResult.status,
                method: 'deterministic-template',
                solution: solveResult.solution ?? {},
                kpis: solveResult.kpis ?? {},
                objective_value: solveResult.objective_value ?? null,
                warnings: solveResult.warnings ?? [],
                cost_usd: 0,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return jsonError(502, 'solve_failed', `Solver non raggiungibile: ${msg}`);
        }
      },
    },
  },
});
