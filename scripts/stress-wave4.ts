#!/usr/bin/env tsx
/**
 * Wave 4 stress test — What-If (Opus 4.7).
 *
 * 10 sequential calls to /api/whatif on the feasible-warning fixture, all with
 * the SAME scenario string. The aim is to:
 *   - Verify Opus prompt caching kicks in (cache_read_tokens > 0 after call #1).
 *   - Measure latency tail (full p99) under saturation.
 *   - Confirm cost stays under control (< $0.03/call mean, given caching).
 *   - Track 529 rate (Opus saturates frequently; tolerated up to 30%).
 *
 * Cap: 10 calls total (per team-lead instruction).
 *
 * Targets:
 *   - full p99 < 25 s
 *   - real-error rate (non-529) < 10%
 *   - mean cost < $0.03/call after first call (caching)
 *   - cache_read_tokens > 0 in at least one call after the first
 *
 * Usage:
 *   npx tsx scripts/stress-wave4.ts
 *   BASE_URL=http://localhost:8080 STRESS_CALLS=10 npx tsx scripts/stress-wave4.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const FIXTURES_DIR = join(process.cwd(), 'tests/fixtures/wave2-solutions');
const FIX = JSON.parse(readFileSync(join(FIXTURES_DIR, 'feasible-warning.json'), 'utf8'));
const TOTAL_CALLS = Math.min(Number(process.env.STRESS_CALLS ?? 8), 10);

const SCENARIO = 'Posso fermare la macchina M-3 oggi dalle 14 alle 18 per manutenzione preventiva? Quali commesse rischio di mandare in ritardo e qual è il trade-off rispetto al rischio guasto?';

interface CallStats {
  index: number;
  ok: boolean;
  external_529: boolean;
  status?: number;
  ttft_ms?: number;
  full_ms: number;
  text_chars: number;
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  cache_read?: number;
  cache_write?: number;
  error?: string;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(Math.max(Math.ceil((p / 100) * s.length) - 1, 0), s.length - 1);
  return s[i];
}

function fmtMs(ms?: number): string {
  if (ms == null) return '    n/a';
  return `${ms.toFixed(0).padStart(6)}ms`;
}

function fmt$(n?: number): string {
  if (n == null) return '     n/a';
  return `$${n.toFixed(5)}`;
}

let _ipCounter = 50;
function nextIp(): string {
  _ipCounter++;
  return `10.0.0.${_ipCounter}`;
}

async function callOnce(index: number): Promise<CallStats> {
  const t0 = Date.now();
  let ttft: number | undefined;
  let firstChunkSeen = false;
  const body = JSON.stringify({
    slug: FIX.slug,
    solution: FIX.solution,
    kpis: FIX.kpis,
    scenario: SCENARIO,
  });

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/whatif`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': nextIp(),
      },
      body,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    return {
      index,
      ok: false,
      external_529: false,
      full_ms: Date.now() - t0,
      text_chars: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    return {
      index,
      ok: false,
      external_529: res.status === 529 || res.status === 503 || res.status === 429,
      status: res.status,
      full_ms: Date.now() - t0,
      text_chars: 0,
      error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
    };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let done: Record<string, unknown> | null = null;
  let error: Record<string, unknown> | null = null;
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const eMatch = chunk.match(/^event:\s*(.+)/m);
      const dMatch = chunk.match(/^data:\s*(.+)/m);
      if (!eMatch || !dMatch) continue;
      const ev = eMatch[1].trim();
      let data: Record<string, unknown> | null = null;
      try { data = JSON.parse(dMatch[1].trim()) as Record<string, unknown>; } catch {}
      if (!data) continue;
      if (ev === 'chunk') {
        if (!firstChunkSeen) { ttft = Date.now() - t0; firstChunkSeen = true; }
        if (typeof data.text === 'string') text += data.text;
      }
      if (ev === 'done') done = data;
      if (ev === 'error') error = data;
    }
  }

  const isExternal = !!error && typeof error.message === 'string' && /529|overload/i.test(error.message as string);
  const fullMs = Date.now() - t0;

  if (error) {
    return {
      index,
      ok: false,
      external_529: isExternal,
      status: res.status,
      ttft_ms: ttft,
      full_ms: fullMs,
      text_chars: text.length,
      error: typeof error.message === 'string' ? error.message.slice(0, 200) : JSON.stringify(error).slice(0, 200),
    };
  }

  return {
    index,
    ok: true,
    external_529: false,
    status: res.status,
    ttft_ms: ttft,
    full_ms: fullMs,
    text_chars: text.length,
    cost_usd: typeof done?.cost_usd === 'number' ? done.cost_usd as number : undefined,
    tokens_in: typeof done?.tokens_in === 'number' ? done.tokens_in as number : undefined,
    tokens_out: typeof done?.tokens_out === 'number' ? done.tokens_out as number : undefined,
    cache_read: typeof done?.cache_read_tokens === 'number' ? done.cache_read_tokens as number : undefined,
    cache_write: typeof done?.cache_write_tokens === 'number' ? done.cache_write_tokens as number : undefined,
  };
}

async function main(): Promise<void> {
  console.log(`Wave 4 stress — ${TOTAL_CALLS} sequential calls to /api/whatif`);
  console.log(`Target: ${BASE_URL}, fixture: feasible-warning, scenario len=${SCENARIO.length}`);
  console.log('');
  console.log('idx | ttft     | full     | chars | cost      | tokens in/out | cache_r | cache_w | status');
  console.log('-'.repeat(110));

  const stats: CallStats[] = [];
  for (let i = 0; i < TOTAL_CALLS; i++) {
    const r = await callOnce(i);
    stats.push(r);
    const statusStr = r.ok ? 'OK' : (r.external_529 ? 'EXT-529' : 'ERR');
    console.log(
      `${String(i).padStart(3)} | ${fmtMs(r.ttft_ms)} | ${fmtMs(r.full_ms)} | ${String(r.text_chars).padStart(5)} | ${fmt$(r.cost_usd)} | ${String(r.tokens_in ?? '-').padStart(6)}/${String(r.tokens_out ?? '-').padEnd(5)} | ${String(r.cache_read ?? '-').padStart(7)} | ${String(r.cache_write ?? '-').padStart(7)} | ${statusStr}${r.error ? ` (${r.error.slice(0, 40)})` : ''}`,
    );
  }

  console.log('');
  console.log('=== Wave 4 Stress Summary ===');
  const ok = stats.filter((s) => s.ok);
  const ext = stats.filter((s) => s.external_529);
  const err = stats.filter((s) => !s.ok && !s.external_529);
  console.log(`OK: ${ok.length}/${stats.length}`);
  console.log(`EXTERNAL-529 (Opus overloaded): ${ext.length}/${stats.length}`);
  console.log(`Real errors: ${err.length}/${stats.length}`);

  if (ok.length > 0) {
    const ttfts = ok.map((s) => s.ttft_ms).filter((v): v is number => v !== undefined);
    const fulls = ok.map((s) => s.full_ms);
    const costs = ok.map((s) => s.cost_usd).filter((v): v is number => v !== undefined);
    const cacheReads = ok.map((s) => s.cache_read ?? 0);
    const cacheWrites = ok.map((s) => s.cache_write ?? 0);

    console.log('');
    console.log('Latency (only OK calls):');
    if (ttfts.length > 0) console.log(`  TTFT  p50=${fmtMs(pct(ttfts, 50))} p95=${fmtMs(pct(ttfts, 95))} p99=${fmtMs(pct(ttfts, 99))} max=${fmtMs(Math.max(...ttfts))}`);
    console.log(`  Full  p50=${fmtMs(pct(fulls, 50))} p95=${fmtMs(pct(fulls, 95))} p99=${fmtMs(pct(fulls, 99))} max=${fmtMs(Math.max(...fulls))}`);

    console.log('');
    console.log('Cost:');
    if (costs.length > 0) {
      const mean = costs.reduce((s, v) => s + v, 0) / costs.length;
      const total = costs.reduce((s, v) => s + v, 0);
      console.log(`  mean=${fmt$(mean)} total=${fmt$(total)} max=${fmt$(Math.max(...costs))}`);
    }

    console.log('');
    console.log('Prompt caching:');
    const callsWithCacheRead = cacheReads.filter((c) => c > 0).length;
    const callsWithCacheWrite = cacheWrites.filter((c) => c > 0).length;
    console.log(`  Calls with cache_read > 0:  ${callsWithCacheRead}/${ok.length} (sum=${cacheReads.reduce((s, v) => s + v, 0)} tokens)`);
    console.log(`  Calls with cache_write > 0: ${callsWithCacheWrite}/${ok.length} (sum=${cacheWrites.reduce((s, v) => s + v, 0)} tokens)`);
    // Cache hits should appear after call #0.
    const cacheHitAfterFirst = ok.slice(1).some((s) => (s.cache_read ?? 0) > 0);
    console.log(`  Cache hit after first call: ${cacheHitAfterFirst ? 'YES' : 'NO'}`);
  }

  console.log('');
  console.log('=== Targets check ===');
  let targetsFails = 0;
  if (ok.length > 0) {
    const fulls = ok.map((s) => s.full_ms);
    const p99 = pct(fulls, 99);
    console.log(`  full p99 < 25000ms ?  ${p99}ms ${p99 < 25_000 ? 'PASS' : 'FAIL'}`);
    if (p99 >= 25_000) targetsFails++;

    const costs = ok.map((s) => s.cost_usd).filter((v): v is number => v !== undefined);
    if (costs.length > 1) {
      const meanAfterFirst = costs.slice(1).reduce((s, v) => s + v, 0) / (costs.length - 1);
      console.log(`  mean cost (calls 2-N) < $0.03 ? $${meanAfterFirst.toFixed(5)} ${meanAfterFirst < 0.03 ? 'PASS' : 'FAIL'}`);
      if (meanAfterFirst >= 0.03) targetsFails++;
    }

    const cacheHitAfterFirst = ok.slice(1).some((s) => (s.cache_read ?? 0) > 0);
    console.log(`  cache_read > 0 after call #1 ? ${cacheHitAfterFirst ? 'YES (PASS)' : 'NO (FAIL)'}`);
    if (!cacheHitAfterFirst && ok.length > 1) targetsFails++;
  }

  const realErrRate = stats.length > 0 ? err.length / stats.length : 0;
  console.log(`  real-error rate < 10% ? ${(realErrRate * 100).toFixed(1)}% ${realErrRate < 0.10 ? 'PASS' : 'FAIL'}`);
  if (realErrRate >= 0.10) targetsFails++;

  // Write results.
  const outPath = join(process.cwd(), 'docs/wave4-stress-results.json');
  writeFileSync(outPath, JSON.stringify({
    base_url: BASE_URL,
    total_calls: TOTAL_CALLS,
    scenario: SCENARIO,
    stats,
    summary: {
      ok: ok.length,
      external_529: ext.length,
      real_errors: err.length,
      cache_hit_after_first: ok.slice(1).some((s) => (s.cache_read ?? 0) > 0),
      total_cost_usd: ok.reduce((s, v) => s + (v.cost_usd ?? 0), 0),
    },
  }, null, 2));
  console.log(`\nResults written to ${outPath}`);

  process.exit(targetsFails > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
