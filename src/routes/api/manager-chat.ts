import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  checkRateLimit,
  getClientIp,
  recordCost,
} from '@/server/llm/client';
import { runManagerChat } from '@/server/llm/manager-chat';

/**
 * Wave 3 Manager Chat BFF route.
 *
 * Threats this route mitigates (see docs/wave3-adversary-report.md):
 *   - DESIGN-W3-1: prompt injection — handled in `runManagerChat`.
 *   - DESIGN-W3-1.6: client-supplied history tampering — `history` schema
 *     only accepts text content; `runManagerChat` rewraps and never trusts
 *     client-side tool_use blocks.
 *   - DESIGN-W3-7 / 7b: rate limit — per-surface bucket via composite key
 *     "${ip}:manager_chat". Manager chat is now budgeted independently of
 *     explainer/advisor (10/hour by default; bump DAINO_BFF_RATE_LIMIT_PER_HOUR).
 *   - DESIGN-W3-13: 256 KB inbound body cap, same as Wave 2 routes.
 *   - Wave 2 streaming pattern: SSE with abort propagation and idempotent
 *     cost flush.
 */

const HistoryTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(2000),
});

const BodySchema = z.object({
  slug: z.string().min(1).max(128),
  solution: z.unknown(),
  kpis: z.record(z.string(), z.number()),
  consultationMd: z.string().optional(),
  dataSchemaMd: z.string().optional(),
  message: z.string().min(1).max(2000),
  history: z.array(HistoryTurnSchema).max(20).optional(),
});

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const Route = createFileRoute('/api/manager-chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ip = getClientIp(request);
        // Per-surface rate limiting (DESIGN-W3-7b). Manager chat gets its own
        // bucket — single bucket shared with explainer+advisor collapses
        // realistic sessions after ~8 turns.
        const rl = checkRateLimit(`${ip}:manager_chat`);
        if (!rl.ok) {
          return jsonError(
            429,
            'rate_limited',
            `Limite di ${rl.limit} richieste/ora superato per la chat manager.`,
          );
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
            parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
          );
        }
        const input = parsed.data;

        // Extra defense: message must be non-empty after trim (Zod min(1)
        // already covers empty string, but whitespace-only would slip
        // through; this also makes prompt-injection of pure whitespace
        // fail cleanly).
        if (input.message.trim().length === 0) {
          return jsonError(400, 'invalid_message', 'Messaggio vuoto.');
        }

        const abort = new AbortController();
        if (request.signal.aborted) {
          abort.abort(request.signal.reason);
        } else {
          request.signal.addEventListener(
            'abort',
            () => abort.abort(request.signal.reason),
            { once: true },
          );
        }

        let lastUsage: {
          cost_usd: number;
          tokens_in: number;
          tokens_out: number;
          cache_read_tokens?: number;
          cache_write_tokens?: number;
        } | null = null;
        let costRecorded = false;
        const flushCost = () => {
          if (costRecorded || !lastUsage) return;
          costRecorded = true;
          recordCost({
            ts: Date.now(),
            surface: 'manager_chat',
            cost_usd: lastUsage.cost_usd,
            tokens_in: lastUsage.tokens_in,
            tokens_out: lastUsage.tokens_out,
            cache_read_tokens: lastUsage.cache_read_tokens,
            cache_write_tokens: lastUsage.cache_write_tokens,
          });
        };

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const write = (event: string, data: unknown) => {
              try {
                controller.enqueue(encoder.encode(sseEvent(event, data)));
              } catch {
                // Controller already closed (client disconnect).
              }
            };
            try {
              const result = await runManagerChat(
                input,
                (text) => write('chunk', { text }),
                {
                  signal: abort.signal,
                  onUsage: (u) => {
                    lastUsage = u;
                  },
                  onToolUse: (info) => {
                    write('tool_use', info);
                  },
                },
              );
              if (!lastUsage) {
                lastUsage = {
                  cost_usd: result.cost_usd,
                  tokens_in: result.tokens_in,
                  tokens_out: result.tokens_out,
                  cache_read_tokens: result.cache_read_tokens,
                  cache_write_tokens: result.cache_write_tokens,
                };
              }
              flushCost();
              if (result.aborted) {
                write('aborted', { reason: 'client_disconnect' });
              } else {
                write('done', {
                  cost_usd: result.cost_usd,
                  tokens_in: result.tokens_in,
                  tokens_out: result.tokens_out,
                  tools_used: result.tools_used,
                  iterations: result.iterations,
                  warning: result.warning,
                });
              }
            } catch (err) {
              flushCost();
              const message = err instanceof Error ? err.message : String(err);
              write('error', { code: 'manager_chat_failed', message });
            } finally {
              flushCost();
              try {
                controller.close();
              } catch {
                // Already closed.
              }
            }
          },
          cancel() {
            abort.abort('client_disconnect');
            flushCost();
          },
        });

        return new Response(stream, {
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            'x-rate-limit-remaining': String(rl.remaining),
          },
        });
      },
    },
  },
});
