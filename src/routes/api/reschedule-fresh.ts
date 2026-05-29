import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  checkRateLimit,
  getClientIp,
} from '@/server/llm/client';
import { extractConstraintFromBackend } from '@/server/llm/extract-constraint-client';
import { buildAiSolutionEnvelope } from '@/lib/aiInputs';
import { buildSolutionContext } from '@/lib/solutionContext';
import {
  buildFrozenPhases,
  detectScenarioStartMin,
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

        if (extracted.result === 'miss') {
          return new Response(
            JSON.stringify({
              ok: false,
              code: 'extract_miss',
              rationale: extracted.rationale,
              confidence: extracted.confidence,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }

        if (extracted.result === 'gray_zone') {
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
        }

        // result === 'hit'
        const rules = (extracted.payload ?? {}) as Record<string, unknown>;
        const problemType = input.problemType ?? 'fjsp';

        // Step 2 — frozen window. Re-solving from scratch must NOT reshuffle
        // work the shop has already done. Freeze every phase that finishes
        // at or before the cutoff and let the solver replan the rest.
        //
        // cutoff = max(detected future scenario start, currentTimeMin +
        // cushion). The "da domani torna a funzionare" half of a compound
        // utterance pushes the boundary to the start of day 2 so the solver
        // can place work around the unavailability window without disturbing
        // today's committed schedule. detectScenarioStartMin returns null
        // when no temporal phrase is present (the plain "ferma adesso" case),
        // in which case the legacy currentTime+cushion cutoff applies.
        const detectedScenarioStart = detectScenarioStartMin(input.message);
        const legacyCutoff =
          input.currentTimeMin !== undefined
            ? input.currentTimeMin + input.cushionMin
            : undefined;
        const cutoffMin =
          detectedScenarioStart !== null && detectedScenarioStart > 0
            ? legacyCutoff !== undefined
              ? Math.max(detectedScenarioStart, legacyCutoff)
              : detectedScenarioStart
            : legacyCutoff;

        const frozenPhases: FrozenPhase[] =
          cutoffMin !== undefined
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
              frozen_count: frozenPhases.length,
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
