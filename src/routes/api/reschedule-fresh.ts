import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  checkRateLimit,
  getClientIp,
} from '@/server/llm/client';
import { extractConstraintFromBackend } from '@/server/llm/extract-constraint-client';
import { resolveTemplate } from '@/lib/api';

/**
 * Wave 16.4 C4 — fresh re-solve fallback when /api/analysis/{sid}/reschedule
 * returns session_not_found.
 *
 * ReplanModal's primary path calls the authenticated reschedule endpoint
 * with the saved session_id / run_id. If those are stale (server restart,
 * memory eviction, deterministic-template runs that never created a
 * plan_memory record before C1 rollout) the manager would otherwise be
 * stuck — the C3 fix just tells them to reload the dashboard.
 *
 * This endpoint offers a robust escape hatch: take the manager's free-text
 * disruption, send it through the same extract-constraint pattern the
 * What-If panel uses, then solve from scratch with the resulting rules.
 * It is slower (~25 s) and ignores warm-start / frozen-window plumbing,
 * but it always produces a fresh plan against the company's current data.
 *
 * Response is solve-template shaped so the client can hand it to
 * `setBackendResult` exactly like ReplanModal's primary path.
 */

const BodySchema = z.object({
  slug: z.string().min(1),
  message: z.string().min(3).max(4_000),
  problemType: z.string().min(1).max(64).optional(),
  // Optional baseline solution context for extract-constraint. Absent in
  // the typical session_not_found case, but if the caller still has the
  // baseline in memory we can feed it through.
  baselineSolution: z.unknown().optional(),
});

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function minimalSolutionContext(slug: string, solution: unknown): {
  slug: string;
  baseline: { machines: string[]; orders: string[]; fasi: unknown[] };
} {
  // The extract-constraint endpoint accepts an empty baseline when the
  // caller has nothing better. We hand over whatever the client passed,
  // narrowed to the three fields the backend reads.
  const obj = (solution ?? {}) as Record<string, unknown>;
  const fasi = Array.isArray(obj.fasi) ? obj.fasi : [];
  const machines = Array.isArray(obj.machines)
    ? (obj.machines as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const orders = Array.isArray(obj.orders)
    ? (obj.orders as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  return { slug, baseline: { machines, orders, fasi } };
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
        const ctx = minimalSolutionContext(input.slug, input.baselineSolution);
        const extracted = await extractConstraintFromBackend(input.message, ctx as never);

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

        try {
          const solveResult = await resolveTemplate(input.slug, problemType, rules);
          return new Response(
            JSON.stringify({
              ok: true,
              code: 'solved_fresh',
              extracted_pattern_id: extracted.pattern_id,
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
