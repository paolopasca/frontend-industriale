import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  checkRateLimit,
  getClientIp,
} from '@/server/llm/client';

/**
 * Wave 16.4 A7 — accept candidate solution as the new plan.
 *
 * The What-If diff shows a candidate solution vs the baseline. When the
 * manager clicks "Accetta", the client wraps the candidate into a
 * solve-template shaped result and feeds it back into `setBackendResult`.
 * This endpoint exists for telemetry / audit parity with apply-whatif:
 * the BFF never had a server-side authoritative plan store (the dashboard
 * is purely client state today), so the response is an `ok` echo plus
 * a typed audit envelope so downstream observability can pick it up.
 *
 * Hard requirements per the team-lead:
 *   - No Opus / Sonnet call (zero cost).
 *   - No backend hop; the candidate already came from /api/apply-whatif.
 *   - Idempotent: re-accepting the same candidate is a no-op echo.
 */

const BodySchema = z.object({
  slug: z.string().min(1),
  // The candidate solution shape is forwarded verbatim. We do not
  // re-validate the internal `solution.schedule[]` here — the candidate
  // was already validated by the solver inside apply-whatif.
  candidateSolution: z.unknown(),
  // KPIs are display-only audit echo. Most are flat numbers, but the FJSP
  // solver also emits nested dicts (e.g. carico_macchine: {M01: 703, ...}).
  // Accept either so a nested KPI does not 400 the whole accept.
  candidateKpis: z.record(
    z.string(),
    z.union([z.number(), z.record(z.string(), z.number())]),
  ),
  warnings: z.array(z.string()).optional().default([]),
  intentId: z.string().optional(),
  strategy: z.enum(['A', 'B', 'C']).optional(),
});

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const Route = createFileRoute('/api/accept-candidate')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ip = getClientIp(request);
        // Reuse the generic rate-limit bucket; this endpoint is cheap but
        // there is no reason to allow unbounded clicks either.
        const rl = checkRateLimit(`${ip}:accept-candidate`);
        if (!rl.ok) {
          return jsonError(429, 'rate_limited', `Limite di ${rl.limit} accettazioni/ora superato.`);
        }

        const contentLength = Number(request.headers.get('content-length') || '0');
        if (contentLength > 1_048_576) {
          return jsonError(413, 'payload_too_large', 'Body massimo 1 MB.');
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

        // Build a solve-template shaped envelope so `adaptResult` consumes
        // it without code paths special-casing accept-candidate. Method is
        // set to 'deterministic-template' to match the live solve path.
        const envelope = {
          ok: true,
          accepted_at: new Date().toISOString(),
          slug: input.slug,
          intent_id: input.intentId ?? null,
          strategy: input.strategy ?? null,
          // The result the client can hand directly to setBackendResult.
          result: {
            status: 'OPTIMAL',
            method: 'deterministic-template',
            solution: input.candidateSolution ?? {},
            kpis: input.candidateKpis,
            warnings: input.warnings ?? [],
            objective_value: null,
            cost_usd: 0,
          },
        };

        return new Response(JSON.stringify(envelope), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  },
});
