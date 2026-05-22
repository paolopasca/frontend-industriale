import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  checkRateLimit,
  getClientIp,
  recordCost,
} from '@/server/llm/client';
import { runWhatIf } from '@/server/llm/whatif';

/**
 * Wave 4 BFF route — strategic What-If analysis with Opus 4.7.
 *
 * Same SSE + AbortController + body-size pattern as Wave 2 / Wave 3 routes.
 * Opus is significantly more expensive than Sonnet ($15/M input, $75/M output)
 * so we rely on prompt caching + tight max_tokens.
 */

const BodySchema = z.object({
  slug: z.string().min(1),
  solution: z.unknown(),
  kpis: z.record(z.string(), z.number()),
  consultationMd: z.string().optional(),
  dataSchemaMd: z.string().optional(),
  scenario: z.string().min(3).max(2000),
  context: z.string().max(2000).optional(),
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

export const Route = createFileRoute('/api/whatif')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const ip = getClientIp(request);
        // Whatif is Opus and pricey: give it its own bucket via composite key.
        const rl = checkRateLimit(`${ip}:whatif`);
        if (!rl.ok) {
          return jsonError(429, 'rate_limited', `Limite di ${rl.limit} richieste/ora superato per what-if.`);
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
            surface: 'whatif',
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
              try { controller.enqueue(encoder.encode(sseEvent(event, data))); }
              catch { /* closed */ }
            };
            try {
              const result = await runWhatIf(
                input,
                (text) => write('chunk', { text }),
                {
                  signal: abort.signal,
                  onUsage: (u) => { lastUsage = u; },
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
              if (result.aborted) write('aborted', { reason: 'client_disconnect' });
              else write('done', {
                cost_usd: result.cost_usd,
                tokens_in: result.tokens_in,
                tokens_out: result.tokens_out,
                cache_read_tokens: result.cache_read_tokens,
                cache_write_tokens: result.cache_write_tokens,
              });
            } catch (err) {
              flushCost();
              const msg = err instanceof Error ? err.message : String(err);
              write('error', { code: 'whatif_failed', message: msg });
            } finally {
              flushCost();
              try { controller.close(); } catch { /* closed */ }
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
