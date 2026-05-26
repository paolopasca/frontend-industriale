import Anthropic from '@anthropic-ai/sdk';

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (_client) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY not set (server-only env var)');
  }
  _client = new Anthropic({ apiKey: key });
  return _client;
}

export type LlmSurface = 'explainer' | 'advisor' | 'manager_chat' | 'whatif' | 'split' | 'translator' | 'whatif_apply';

export interface CostRecord {
  ts: number;
  surface: LlmSurface;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

const _costs: CostRecord[] = [];
const COST_HISTORY_LIMIT = 1000;

export function recordCost(r: CostRecord): void {
  _costs.push(r);
  if (_costs.length > COST_HISTORY_LIMIT) _costs.shift();
}

export function getCosts(since?: number): CostRecord[] {
  return since ? _costs.filter((c) => c.ts >= since) : _costs.slice();
}

const _hits = new Map<string, number[]>();
const LIMIT = Number(process.env.DAINO_BFF_RATE_LIMIT_PER_HOUR || '10');
const WINDOW_MS = 60 * 60 * 1000;

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  limit: number;
}

function shouldBypassRateLimit(ipOrCompositeKey: string): boolean {
  // Explicit opt-out always wins — a dev exercising the real limiter can
  // set BYPASS_LOCAL=0 to force the limiter on regardless of env.
  if (process.env.DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL === '0') return false;
  // Wave 16.3 HIGH-1 — allow-list of dev/test envs. The previous version
  // bypassed for any NODE_ENV !== 'production', which meant Cloudflare
  // Workers deployments (where NODE_ENV is undefined unless explicitly
  // set in wrangler.jsonc) silently disabled the limiter and exposed the
  // Anthropic billing to runaway clients. Now: bypass ONLY when the env
  // is *explicitly* 'development' or 'test'. Undefined, 'production',
  // 'staging', or any other value → fall through to the limiter (safe
  // default). Pair with wrangler.jsonc setting NODE_ENV="production".
  const env = process.env.NODE_ENV;
  if (env !== 'development' && env !== 'test') return false;
  // In dev/test we bypass the limiter so e2e tests, stress runners, and a
  // manager dogfooding the dashboard on a LAN IP don't trip the 10/h cap
  // while iterating.
  void ipOrCompositeKey;
  return true;
}

// `limitOverride` lets a caller enforce a stricter per-surface cap (e.g.
// apply-whatif is 5/h because each call triggers a full re-solve, not just
// an LLM round-trip). The override only narrows: it never raises the cap
// above the global LIMIT env var, so a misconfigured surface can't escape
// the safety ceiling.
export function checkRateLimit(ip: string, limitOverride?: number): RateLimitResult {
  const effectiveLimit =
    typeof limitOverride === 'number' && limitOverride > 0
      ? Math.min(limitOverride, LIMIT)
      : LIMIT;
  if (shouldBypassRateLimit(ip)) {
    return { ok: true, remaining: effectiveLimit, limit: effectiveLimit };
  }
  const now = Date.now();
  const hits = (_hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= effectiveLimit) {
    _hits.set(ip, hits);
    return { ok: false, remaining: 0, limit: effectiveLimit };
  }
  hits.push(now);
  _hits.set(ip, hits);
  return { ok: true, remaining: effectiveLimit - hits.length, limit: effectiveLimit };
}

export function getClientIp(request: Request): string {
  const headers = request.headers;
  const cf = headers.get('cf-connecting-ip');
  if (cf) return cf;
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  const real = headers.get('x-real-ip');
  if (real) return real;
  return 'local';
}
