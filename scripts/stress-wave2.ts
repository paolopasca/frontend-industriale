#!/usr/bin/env tsx
/**
 * Wave 2 stress fast-lane.
 *
 * 50 sequential calls to /api/explain on the optimal fixture (default).
 * Measures time-to-first-token, full latency, error rate, cost.
 *
 * First 5 are "cold" (cache MISS expected), the remaining 45 are "warm"
 * (cache HIT expected). The stable, cached portion is the system prompt
 * + spec block; the per-call variable block keeps the same shape across
 * calls (slug, KPIs, solution all identical), so the entire request
 * prefix is reusable.
 *
 * Hard caps (PRD §7.3 + team-lead brief):
 *   - cap calls at 50 (≤$1-2 total at Sonnet 4.6)
 *   - warm portion should be ≥50% cache_read tokens
 *   - TTFT p99 < 3s, full p99 < 12s, errors < 5%, avg cost < $0.02
 *
 * Usage:
 *   npx tsx scripts/stress-wave2.ts
 *   STRESS_CALLS=20 npx tsx scripts/stress-wave2.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const FIXTURE = process.env.FIXTURE ?? 'optimal';
const FIXTURES_DIR = join(process.cwd(), 'tests/fixtures/wave2-solutions');
const TOTAL_CALLS = Math.min(Number(process.env.STRESS_CALLS ?? 50), 50);
const COLD_PORTION = 5;
const ENDPOINT = process.env.ENDPOINT ?? 'explain';

interface CallStats {
  index: number;
  cold: boolean;
  ok: boolean;
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

function fmtMs(ms: number | undefined): string {
  if (ms == null) return '   n/a ';
  return `${ms.toFixed(0).padStart(5)}ms`;
}

function fmt$(n: number | undefined): string {
  if (n == null) return '   n/a';
  return `$${n.toFixed(5)}`;
}

async function callOnce(index: number, body: string, isCold: boolean): Promise<CallStats> {
  const t0 = Date.now();
  let ttft: number | undefined;
  let costMeta: { cost_usd?: number; tokens_in?: number; tokens_out?: number; cache_read?: number; cache_write?: number } = {};
  let text = '';
  let firstByteReceived = false;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/${ENDPOINT}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return {
      index,
      cold: isCold,
      ok: false,
      full_ms: Date.now() - t0,
      text_chars: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok || !res.body) {
    return {
      index,
      cold: isCold,
      ok: false,
      status: res.status,
      full_ms: Date.now() - t0,
      text_chars: 0,
      error: `HTTP ${res.status}`,
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const evt = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = evt.split('\n');
      let eventName = 'message';
      let dataStr = '';
      for (const l of lines) {
        if (l.startsWith('event:')) eventName = l.slice(6).trim();
        else if (l.startsWith('data:')) dataStr += l.slice(5).trim();
      }
      if (!dataStr) continue;
      let data: unknown;
      try {
        data = JSON.parse(dataStr);
      } catch {
        continue;
      }
      if (eventName === 'chunk') {
        const t = (data as { text?: string }).text;
        if (typeof t === 'string') {
          if (!firstByteReceived) {
            ttft = Date.now() - t0;
            firstByteReceived = true;
          }
          text += t;
        }
      } else if (eventName === 'done') {
        const d = data as { cost_usd?: number; tokens_in?: number; tokens_out?: number };
        costMeta.cost_usd = d.cost_usd;
        costMeta.tokens_in = d.tokens_in;
        costMeta.tokens_out = d.tokens_out;
      }
    }
  }

  // x-rate-limit-remaining + custom cache headers? The "done" event from
  // /api/explain only exposes tokens; the cache_read/cache_write live in
  // recordCost server-side. We approximate cache hit ratio by comparing
  // the cold vs warm cost; a true read of cache_read tokens would require
  // exposing them in the SSE done event.

  return {
    index,
    cold: isCold,
    ok: true,
    status: res.status,
    ttft_ms: ttft,
    full_ms: Date.now() - t0,
    text_chars: text.length,
    cost_usd: costMeta.cost_usd,
    tokens_in: costMeta.tokens_in,
    tokens_out: costMeta.tokens_out,
  };
}

interface BlockSummary {
  label: string;
  n: number;
  ok_n: number;
  ttft_p50: number;
  ttft_p95: number;
  ttft_p99: number;
  full_p50: number;
  full_p95: number;
  full_p99: number;
  cost_avg: number;
  cost_sum: number;
  tokens_in_avg: number;
  tokens_out_avg: number;
}

function summarize(label: string, stats: CallStats[]): BlockSummary {
  const ok = stats.filter((s) => s.ok);
  const ttfts = ok.map((s) => s.ttft_ms ?? 0).filter((n) => n > 0);
  const fulls = ok.map((s) => s.full_ms);
  const costs = ok.map((s) => s.cost_usd ?? 0);
  const tokensIn = ok.map((s) => s.tokens_in ?? 0);
  const tokensOut = ok.map((s) => s.tokens_out ?? 0);
  return {
    label,
    n: stats.length,
    ok_n: ok.length,
    ttft_p50: pct(ttfts, 50),
    ttft_p95: pct(ttfts, 95),
    ttft_p99: pct(ttfts, 99),
    full_p50: pct(fulls, 50),
    full_p95: pct(fulls, 95),
    full_p99: pct(fulls, 99),
    cost_avg: costs.length === 0 ? 0 : costs.reduce((a, b) => a + b, 0) / costs.length,
    cost_sum: costs.reduce((a, b) => a + b, 0),
    tokens_in_avg: tokensIn.length === 0 ? 0 : tokensIn.reduce((a, b) => a + b, 0) / tokensIn.length,
    tokens_out_avg: tokensOut.length === 0 ? 0 : tokensOut.reduce((a, b) => a + b, 0) / tokensOut.length,
  };
}

function printBlock(s: BlockSummary): void {
  console.log(`\n--- ${s.label} (${s.ok_n}/${s.n} ok) ---`);
  console.log(`  TTFT  p50/p95/p99 : ${fmtMs(s.ttft_p50)} / ${fmtMs(s.ttft_p95)} / ${fmtMs(s.ttft_p99)}`);
  console.log(`  Full  p50/p95/p99 : ${fmtMs(s.full_p50)} / ${fmtMs(s.full_p95)} / ${fmtMs(s.full_p99)}`);
  console.log(`  Cost  avg / total : ${fmt$(s.cost_avg)} / ${fmt$(s.cost_sum)}`);
  console.log(`  Tokens in/out avg : ${s.tokens_in_avg.toFixed(0)} / ${s.tokens_out_avg.toFixed(0)}`);
}

async function main(): Promise<void> {
  console.log(`\n=== Wave 2 Stress Fast-Lane ===`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Endpoint: /api/${ENDPOINT}`);
  console.log(`Fixture: ${FIXTURE}`);
  console.log(`Total calls: ${TOTAL_CALLS} (first ${COLD_PORTION} cold, rest warm)\n`);

  const body = readFileSync(join(FIXTURES_DIR, `${FIXTURE}.json`), 'utf8');

  const all: CallStats[] = [];
  for (let i = 1; i <= TOTAL_CALLS; i++) {
    const cold = i <= COLD_PORTION;
    process.stdout.write(`[${i.toString().padStart(2, '0')}/${TOTAL_CALLS}] ${cold ? 'cold' : 'warm'}... `);
    const s = await callOnce(i, body, cold);
    all.push(s);
    if (s.ok) {
      console.log(
        `✓ TTFT ${fmtMs(s.ttft_ms).trim()} / full ${fmtMs(s.full_ms).trim()} / cost ${fmt$(s.cost_usd)} (in ${s.tokens_in ?? '?'} out ${s.tokens_out ?? '?'})`,
      );
    } else {
      console.log(`✗ ${s.error}`);
    }
  }

  const cold = all.filter((s) => s.cold);
  const warm = all.filter((s) => !s.cold);
  const total = summarize('TOTAL', all);
  const coldSum = summarize('COLD (first 5)', cold);
  const warmSum = summarize('WARM (45)', warm);

  printBlock(total);
  printBlock(coldSum);
  printBlock(warmSum);

  console.log(`\n=== Cache effectiveness (cold vs warm avg cost) ===`);
  const ratio = coldSum.cost_avg === 0 ? 0 : warmSum.cost_avg / coldSum.cost_avg;
  console.log(`  Cold avg cost: ${fmt$(coldSum.cost_avg)}`);
  console.log(`  Warm avg cost: ${fmt$(warmSum.cost_avg)}`);
  console.log(`  Warm/Cold ratio: ${(ratio * 100).toFixed(1)}% (lower is better; cache target: <50%)`);

  console.log(`\n=== PRD/team-lead thresholds ===`);
  const errors = all.filter((s) => !s.ok).length;
  const errorRate = errors / all.length;
  const ttftP99Pass = warmSum.ttft_p99 < 3_000;
  const fullP99Pass = warmSum.full_p99 < 12_000;
  const errorPass = errorRate < 0.05;
  const costPass = warmSum.cost_avg < 0.02;
  const cachePass = ratio < 0.5;

  console.log(`  TTFT p99 < 3000ms   : ${warmSum.ttft_p99.toFixed(0)}ms → ${ttftP99Pass ? 'PASS' : 'FAIL'}`);
  console.log(`  Full p99 < 12000ms  : ${warmSum.full_p99.toFixed(0)}ms → ${fullP99Pass ? 'PASS' : 'FAIL'}`);
  console.log(`  Error rate < 5%     : ${(errorRate * 100).toFixed(1)}% → ${errorPass ? 'PASS' : 'FAIL'}`);
  console.log(`  Warm avg cost <$0.02: ${fmt$(warmSum.cost_avg)} → ${costPass ? 'PASS' : 'FAIL'}`);
  console.log(`  Cache (warm/cold) <50% : ${(ratio * 100).toFixed(1)}% → ${cachePass ? 'PASS' : 'WARN'}`);

  const allPass = ttftP99Pass && fullP99Pass && errorPass && costPass;
  console.log(`\n=== VERDICT: ${allPass ? 'PASS' : 'FAIL'} ===\n`);

  // Write JSON output for the report.
  const summary = {
    base_url: BASE_URL,
    endpoint: ENDPOINT,
    fixture: FIXTURE,
    total_calls: TOTAL_CALLS,
    cold_portion: COLD_PORTION,
    error_rate: errorRate,
    cost_total: total.cost_sum,
    cache_warm_cold_ratio: ratio,
    blocks: { total, cold: coldSum, warm: warmSum },
    thresholds: {
      ttft_p99: { actual: warmSum.ttft_p99, limit: 3000, pass: ttftP99Pass },
      full_p99: { actual: warmSum.full_p99, limit: 12000, pass: fullP99Pass },
      error_rate: { actual: errorRate, limit: 0.05, pass: errorPass },
      cost_avg: { actual: warmSum.cost_avg, limit: 0.02, pass: costPass },
      cache_ratio: { actual: ratio, limit: 0.5, pass: cachePass },
    },
    verdict: allPass ? 'PASS' : 'FAIL',
    calls: all.map((c) => ({
      index: c.index,
      cold: c.cold,
      ok: c.ok,
      ttft_ms: c.ttft_ms,
      full_ms: c.full_ms,
      cost_usd: c.cost_usd,
      tokens_in: c.tokens_in,
      tokens_out: c.tokens_out,
      error: c.error,
    })),
  };

  const reportPath = join(process.cwd(), 'docs/wave2-stress-output.json');
  await import('node:fs').then((fs) => fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2)));
  console.log(`Report written to ${reportPath}`);

  if (!allPass) process.exit(1);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(2);
});
