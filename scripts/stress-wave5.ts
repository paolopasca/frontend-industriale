#!/usr/bin/env tsx
/**
 * Wave 5 stress test — Split (Opus 4.7).
 *
 * 5 sequential calls to /api/split on the optimal.json fixture.
 *
 * Measures:
 *   - TTFT (time to first SSE `chunk`)
 *   - full latency
 *   - mean cost per call
 *   - error rate (real errors, NOT 529 overloaded)
 *
 * Targets (Opus 4.7):
 *   - full p99 < 25s
 *   - mean cost < $0.04/call
 *   - real-error rate < 5% (529 tolerated)
 *
 * Cap: 5 calls (team-lead budget cap ≈ $0.20 of the $0.50 wave-wide cap).
 *
 * Usage:
 *   npx tsx scripts/stress-wave5.ts
 *   STRESS_CALLS=3 BASE_URL=http://localhost:8080 npx tsx scripts/stress-wave5.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const FIXTURES_DIR = join(process.cwd(), 'tests/fixtures/wave2-solutions');
const FIX = JSON.parse(readFileSync(join(FIXTURES_DIR, 'optimal.json'), 'utf8'));
const TOTAL_CALLS = Math.min(Number(process.env.STRESS_CALLS ?? 5), 10);

// Cycle through commesse present in the optimal fixture so we don't hit a
// trivial prompt-cache identical-body scenario for every call.
const COMMESSE = ['COM-001', 'COM-002', 'COM-001', 'COM-002', 'COM-001'];

interface CallStats {
  index: number;
  commessa: string;
  ok: boolean;
  external_529: boolean;
  status?: number;
  ttft_ms?: number;
  full_ms: number;
  text_chars: number;
  has_all_4_sections: boolean;
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  cache_read?: number;
  cache_write?: number;
  error?: string;
}

const SECTION_RES = [
  /^##\s+Diagnosi\s*$/m,
  /^##\s+Proposta di split\s*$/m,
  /^##\s+Rischi\s*$/m,
  /^##\s+Stima impatto\s*$/m,
] as const;

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(Math.max(Math.ceil((p / 100) * s.length) - 1, 0), s.length - 1);
  return s[i];
}

function fmtMs(ms?: number): string {
  if (ms == null) return '    n/a ';
  return `${ms.toFixed(0).padStart(6)}ms`;
}

function fmt$(n?: number): string {
  if (n == null) return '     n/a';
  return `$${n.toFixed(5)}`;
}

function hasAllSections(text: string): boolean {
  return SECTION_RES.every((re) => re.test(text));
}

async function callOnce(index: number, commessa: string): Promise<CallStats> {
  const t0 = Date.now();
  let ttft: number | undefined;
  let firstChunkSeen = false;
  const body = JSON.stringify({
    slug: FIX.slug,
    commessa,
    solution: FIX.solution,
    kpis: FIX.kpis,
  });

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return {
      index,
      commessa,
      ok: false,
      external_529: false,
      full_ms: Date.now() - t0,
      text_chars: 0,
      has_all_4_sections: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok || !res.body) {
    return {
      index,
      commessa,
      ok: false,
      external_529: res.status === 503 || res.status === 429,
      status: res.status,
      full_ms: Date.now() - t0,
      text_chars: 0,
      has_all_4_sections: false,
      error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
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
      commessa,
      ok: false,
      external_529: isExternal,
      status: res.status,
      ttft_ms: ttft,
      full_ms: fullMs,
      text_chars: text.length,
      has_all_4_sections: hasAllSections(text),
      error: typeof error.message === 'string' ? error.message.slice(0, 200) : JSON.stringify(error).slice(0, 200),
    };
  }

  return {
    index,
    commessa,
    ok: true,
    external_529: false,
    status: res.status,
    ttft_ms: ttft,
    full_ms: fullMs,
    text_chars: text.length,
    has_all_4_sections: hasAllSections(text),
    cost_usd: typeof done?.cost_usd === 'number' ? (done.cost_usd as number) : undefined,
    tokens_in: typeof done?.tokens_in === 'number' ? (done.tokens_in as number) : undefined,
    tokens_out: typeof done?.tokens_out === 'number' ? (done.tokens_out as number) : undefined,
    cache_read: typeof done?.cache_read_tokens === 'number' ? (done.cache_read_tokens as number) : undefined,
    cache_write: typeof done?.cache_write_tokens === 'number' ? (done.cache_write_tokens as number) : undefined,
  };
}

async function main() {
  console.log(`Wave 5 stress — ${TOTAL_CALLS} sequential calls to /api/split (Opus 4.7)`);
  console.log(`Target: ${BASE_URL}, fixture: optimal`);
  console.log('');
  console.log('idx | commessa  | ttft    | full    | chars | 4-sect | cost     | tokens (in/out/cache_r/cache_w) | status');
  console.log('-'.repeat(135));

  const stats: CallStats[] = [];
  for (let i = 0; i < TOTAL_CALLS; i++) {
    const c = COMMESSE[i % COMMESSE.length];
    const r = await callOnce(i, c);
    stats.push(r);
    const tokenStr = `${r.tokens_in ?? '-'}/${r.tokens_out ?? '-'}/${r.cache_read ?? '-'}/${r.cache_write ?? '-'}`;
    const statusStr = r.ok ? 'OK' : (r.external_529 ? 'EXT-529' : 'ERR');
    console.log(
      `${String(i).padStart(3)} | ${c.padEnd(9)} | ${fmtMs(r.ttft_ms)} | ${fmtMs(r.full_ms)} | ${String(r.text_chars).padStart(5)} | ${r.has_all_4_sections ? '  yes ' : '  no  '} | ${fmt$(r.cost_usd)} | ${tokenStr.padEnd(28)} | ${statusStr}${r.error ? ` (${r.error.slice(0, 50)})` : ''}`,
    );
  }

  console.log('');
  console.log('=== Wave 5 Stress Summary ===');
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
    const with4 = ok.filter((s) => s.has_all_4_sections).length;

    console.log('');
    console.log('Latency (only OK calls):');
    if (ttfts.length > 0) {
      console.log(`  TTFT  p50=${fmtMs(pct(ttfts, 50))} p95=${fmtMs(pct(ttfts, 95))} p99=${fmtMs(pct(ttfts, 99))} max=${fmtMs(Math.max(...ttfts))}`);
    }
    console.log(`  Full  p50=${fmtMs(pct(fulls, 50))} p95=${fmtMs(pct(fulls, 95))} p99=${fmtMs(pct(fulls, 99))} max=${fmtMs(Math.max(...fulls))}`);
    console.log('');
    console.log('Output structure:');
    console.log(`  ${with4}/${ok.length} (${((with4 / ok.length) * 100).toFixed(0)}%) produced all 4 required sections`);
    console.log('');
    console.log('Cost:');
    if (costs.length > 0) {
      const mean = costs.reduce((s, v) => s + v, 0) / costs.length;
      const total = costs.reduce((s, v) => s + v, 0);
      console.log(`  mean=${fmt$(mean)} total=${fmt$(total)} max=${fmt$(Math.max(...costs))}`);
    }
  }

  const outPath = join(process.cwd(), 'tests/server/wave5-stress-results.json');
  writeFileSync(outPath, JSON.stringify(stats, null, 2), 'utf8');
  console.log(`\nResults written to ${outPath}`);

  // Check targets
  const ttftsOk = ok.map((s) => s.full_ms);
  const p99Full = pct(ttftsOk, 99);
  const meanCost = ok.length > 0
    ? (ok.map((s) => s.cost_usd).filter((v): v is number => v !== undefined).reduce((s, v) => s + v, 0) / ok.length)
    : 0;
  console.log('');
  console.log(`Target full p99 < 25000ms: ${p99Full < 25000 ? 'PASS' : 'FAIL'} (actual ${p99Full}ms)`);
  console.log(`Target mean cost < $0.04:  ${meanCost < 0.04 ? 'PASS' : 'FAIL'} (actual $${meanCost.toFixed(5)})`);

  const errRate = stats.length > 0 ? err.length / stats.length : 0;
  if (errRate >= 0.05) {
    console.log(`\nFAIL: real-error rate ${(errRate * 100).toFixed(1)}% >= 5%`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
