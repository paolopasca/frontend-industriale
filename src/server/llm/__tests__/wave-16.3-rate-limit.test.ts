import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Wave 16.3 HIGH-1 — `shouldBypassRateLimit` allow-list semantics.
 *
 * Devil-advocate finding (post Wave 16.3 round-2 review):
 *   The pre-Wave-16.3 bypass logic was "deny only when NODE_ENV ===
 *   'production'", which meant any deployment where NODE_ENV is undefined
 *   (the default on Cloudflare Workers unless explicitly set in
 *   wrangler.jsonc) silently disabled the limiter and exposed the
 *   Anthropic billing to runaway clients.
 *
 *   The fix inverts the check into an explicit allow-list: bypass only
 *   when NODE_ENV is exactly 'development' or 'test'. Any other value
 *   (including undefined, 'production', 'staging', or a typo'd
 *   'productioN') falls through to the limiter.
 *
 * This test exercises `checkRateLimit` (the public entry point) since
 * `shouldBypassRateLimit` is module-private. We use distinct IPs per
 * scenario so the in-memory `_hits` map doesn't cross-pollute between
 * assertions.
 */

describe('Wave 16.3 HIGH-1 — rate-limit bypass allow-list', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset to a clean slate; each test sets its own NODE_ENV.
    delete process.env.NODE_ENV;
    delete process.env.DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL;
    delete process.env.DAINO_BFF_RATE_LIMIT_PER_HOUR;
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function loadCheck() {
    const mod = await import('../client');
    return mod.checkRateLimit;
  }

  it('NODE_ENV=undefined (Cloudflare Workers default) → limiter active', async () => {
    // No NODE_ENV set. Pre-Wave-16.3: bypass active (BUG). Post-fix: limiter.
    process.env.DAINO_BFF_RATE_LIMIT_PER_HOUR = '2';
    const checkRateLimit = await loadCheck();
    const ip = 'test-undefined-env';
    expect(checkRateLimit(ip).ok).toBe(true);  // 1st: ok
    expect(checkRateLimit(ip).ok).toBe(true);  // 2nd: ok
    expect(checkRateLimit(ip).ok).toBe(false); // 3rd: limit hit
  });

  it("NODE_ENV='production' → limiter active", async () => {
    process.env.NODE_ENV = 'production';
    process.env.DAINO_BFF_RATE_LIMIT_PER_HOUR = '2';
    const checkRateLimit = await loadCheck();
    const ip = 'test-prod-env';
    expect(checkRateLimit(ip).ok).toBe(true);
    expect(checkRateLimit(ip).ok).toBe(true);
    expect(checkRateLimit(ip).ok).toBe(false);
  });

  it("NODE_ENV='staging' → limiter active (not in allow-list)", async () => {
    process.env.NODE_ENV = 'staging';
    process.env.DAINO_BFF_RATE_LIMIT_PER_HOUR = '2';
    const checkRateLimit = await loadCheck();
    const ip = 'test-staging-env';
    expect(checkRateLimit(ip).ok).toBe(true);
    expect(checkRateLimit(ip).ok).toBe(true);
    expect(checkRateLimit(ip).ok).toBe(false);
  });

  it("NODE_ENV='development' → bypass active (allow-list)", async () => {
    process.env.NODE_ENV = 'development';
    process.env.DAINO_BFF_RATE_LIMIT_PER_HOUR = '2';
    const checkRateLimit = await loadCheck();
    const ip = 'test-dev-env';
    // 3 calls; in bypass mode all return ok.
    expect(checkRateLimit(ip).ok).toBe(true);
    expect(checkRateLimit(ip).ok).toBe(true);
    expect(checkRateLimit(ip).ok).toBe(true);
  });

  it("NODE_ENV='test' → bypass active (allow-list)", async () => {
    process.env.NODE_ENV = 'test';
    process.env.DAINO_BFF_RATE_LIMIT_PER_HOUR = '2';
    const checkRateLimit = await loadCheck();
    const ip = 'test-test-env';
    expect(checkRateLimit(ip).ok).toBe(true);
    expect(checkRateLimit(ip).ok).toBe(true);
    expect(checkRateLimit(ip).ok).toBe(true);
  });

  it("NODE_ENV='development' + BYPASS_LOCAL=0 → limiter still active (explicit opt-out)", async () => {
    process.env.NODE_ENV = 'development';
    process.env.DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL = '0';
    process.env.DAINO_BFF_RATE_LIMIT_PER_HOUR = '2';
    const checkRateLimit = await loadCheck();
    const ip = 'test-dev-optout';
    expect(checkRateLimit(ip).ok).toBe(true);
    expect(checkRateLimit(ip).ok).toBe(true);
    expect(checkRateLimit(ip).ok).toBe(false);
  });

  it("NODE_ENV='productioN' (typo) → limiter active (not exact match)", async () => {
    // Defensive: a typo'd NODE_ENV must not silently bypass the limiter.
    process.env.NODE_ENV = 'productioN';
    process.env.DAINO_BFF_RATE_LIMIT_PER_HOUR = '2';
    const checkRateLimit = await loadCheck();
    const ip = 'test-typo-env';
    expect(checkRateLimit(ip).ok).toBe(true);
    expect(checkRateLimit(ip).ok).toBe(true);
    expect(checkRateLimit(ip).ok).toBe(false);
  });
});
