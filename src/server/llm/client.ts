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

export type LlmSurface = 'explainer' | 'advisor' | 'manager_chat' | 'whatif' | 'split';

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
  if (process.env.DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL === '0') return false;
  // Composite keys are of the form "<ip>:<surface>" (e.g. "local:whatif",
  // "127.0.0.1:split"). Strip the surface suffix before matching.
  const ip = ipOrCompositeKey.split(':')[0];
  if (ip !== 'local' && ip !== '127.0.0.1' && ip !== '::1') return false;
  const env = process.env.NODE_ENV;
  return env !== 'production';
}

export function checkRateLimit(ip: string): RateLimitResult {
  if (shouldBypassRateLimit(ip)) {
    return { ok: true, remaining: LIMIT, limit: LIMIT };
  }
  const now = Date.now();
  const hits = (_hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= LIMIT) {
    _hits.set(ip, hits);
    return { ok: false, remaining: 0, limit: LIMIT };
  }
  hits.push(now);
  _hits.set(ip, hits);
  return { ok: true, remaining: LIMIT - hits.length, limit: LIMIT };
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
