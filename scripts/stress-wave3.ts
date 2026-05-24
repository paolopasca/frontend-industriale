#!/usr/bin/env tsx
/**
 * Wave 3 stress test — Manager Chat (Haiku 4.5 agentic loop).
 *
 * 20 sequential calls to /api/manager-chat on the feasible-warning fixture.
 * Cycles through a pool of 10 realistic manager questions (Italian).
 *
 * Measures:
 *   - TTFT (time to first SSE `chunk`)
 *   - full latency
 *   - tool-use rate (% calls that invoked >= 1 tool)
 *   - error rate (real errors, NOT 529 overloaded)
 *   - external (529) rate
 *   - mean cost per call
 *
 * Targets (Haiku 4.5):
 *   - TTFT p99 < 2.0s, full p99 < 5.0s
 *   - error rate (non-529) < 5%
 *   - mean cost < $0.005/query
 *
 * Cap: 20 calls (team-lead budget cap ~$0.10 with Haiku pricing).
 *
 * Usage:
 *   npx tsx scripts/stress-wave3.ts
 *   STRESS_CALLS=10 BASE_URL=http://localhost:8080 npx tsx scripts/stress-wave3.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const FIXTURES_DIR = join(process.cwd(), 'tests/fixtures/wave2-solutions');
const FIX = JSON.parse(readFileSync(join(FIXTURES_DIR, 'feasible-warning.json'), 'utf8'));
const TOTAL_CALLS = Math.min(Number(process.env.STRESS_CALLS ?? 20), 30);

const QUESTIONS = [
  'Quante commesse sono in ritardo?',
  'Quanto è saturata la macchina M-3?',
  'Quale è la prossima scadenza?',
  'Mostrami i KPI principali.',
  'Quali sono i colli di bottiglia?',
  "Dammi il dettaglio dei costi.",
  'Lo status del solver?',
  'Mostra le commesse on-time.',
  'Chi sono gli operatori più carichi?',
  'Dimmi le fasi di COM-007.',
];

interface CallStats {
  index: number;
  question: string;
  ok: boolean;
  external_529: boolean;
  status?: number;
  ttft_ms?: number;
  full_ms: number;
  text_chars: number;
  tools_used: string[];
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  cache_read?: number;
  cache_write?: number;
  iterations?: number;
  error?: string;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(Math.max(Math.ceil((p / 100) * s.length) - 1, 0), s.length - 1);
  return s[i];
}

function fmtMs(ms?: number): string {
  if (ms == null) return '   n/a ';
  return `${ms.toFixed(0).padStart(5)}ms`;
}

function fmt$(n?: number): string {
  if (n == null) return '    n/a';
  return `$${n.toFixed(5)}`;
}

async function callOnce(index: number, question: string): Promise<CallStats> {
  const t0 = Date.now();
  let ttft: number | undefined;
  let firstChunkSeen = false;
  const body = JSON.stringify({
    slug: FIX.slug,
    solution: FIX.solution,
    kpis: FIX.kpis,
    message: question,
  });

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/manager-chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    return {
      index,
      question,
      ok: false,
      external_529: false,
      full_ms: Date.now() - t0,
      text_chars: 0,
      tools_used: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok || !res.body) {
    return {
      index,
      question,
      ok: false,
      external_529: res.status === 503 || res.status === 429,
      status: res.status,
      full_ms: Date.now() - t0,
      text_chars: 0,
      tools_used: [],
      error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  const tools_used: string[] = [];
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
      if (ev === 'tool_use' && typeof data.name === 'string') tools_used.push(data.name);
      if (ev === 'done') done = data;
      if (ev === 'error') error = data;
    }
  }

  const isExternal = !!error && typeof error.message === 'string' && /529|overload/i.test(error.message as string);
  const fullMs = Date.now() - t0;

  if (error) {
    return {
      index,
      question,
      ok: false,
      external_529: isExternal,
      status: res.status,
      ttft_ms: ttft,
      full_ms: fullMs,
      text_chars: text.length,
      tools_used,
      error: typeof error.message === 'string' ? error.message.slice(0, 200) : JSON.stringify(error).slice(0, 200),
    };
  }

  return {
    index,
    question,
    ok: true,
    external_529: false,
    status: res.status,
    ttft_ms: ttft,
    full_ms: fullMs,
    text_chars: text.length,
    tools_used,
    cost_usd: typeof done?.cost_usd === 'number' ? (done.cost_usd as number) : undefined,
    tokens_in: typeof done?.tokens_in === 'number' ? (done.tokens_in as number) : undefined,
    tokens_out: typeof done?.tokens_out === 'number' ? (done.tokens_out as number) : undefined,
    cache_read: typeof done?.cache_read_tokens === 'number' ? (done.cache_read_tokens as number) : undefined,
    cache_write: typeof done?.cache_write_tokens === 'number' ? (done.cache_write_tokens as number) : undefined,
    iterations: typeof done?.iterations === 'number' ? (done.iterations as number) : undefined,
  };
}

async function main() {
  console.log(`Wave 3 stress — ${TOTAL_CALLS} sequential calls to /api/manager-chat`);
  console.log(`Target: ${BASE_URL}, fixture: feasible-warning`);
  console.log('');
  console.log('idx | ttft   | full   | chars | tools                            | cost     | tokens (in/out/cache_r) | status');
  console.log('-'.repeat(140));

  const stats: CallStats[] = [];
  for (let i = 0; i < TOTAL_CALLS; i++) {
    const q = QUESTIONS[i % QUESTIONS.length];
    const r = await callOnce(i, q);
    stats.push(r);
    const toolStr = r.tools_used.length > 0 ? r.tools_used.join(',').slice(0, 32) : '-';
    const tokenStr = `${r.tokens_in ?? '-'}/${r.tokens_out ?? '-'}/${r.cache_read ?? '-'}`;
    const statusStr = r.ok ? 'OK' : (r.external_529 ? 'EXT-529' : `ERR`);
    console.log(
      `${String(i).padStart(3)} | ${fmtMs(r.ttft_ms)} | ${fmtMs(r.full_ms)} | ${String(r.text_chars).padStart(5)} | ${toolStr.padEnd(32)} | ${fmt$(r.cost_usd)} | ${tokenStr.padEnd(20)} | ${statusStr}${r.error ? ` (${r.error.slice(0, 40)})` : ''}`,
    );
  }

  console.log('');
  console.log('=== Wave 3 Stress Summary ===');
  const ok = stats.filter((s) => s.ok);
  const ext = stats.filter((s) => s.external_529);
  const err = stats.filter((s) => !s.ok && !s.external_529);
  console.log(`OK: ${ok.length}/${stats.length}`);
  console.log(`EXTERNAL-529 (Haiku overloaded): ${ext.length}/${stats.length}`);
  console.log(`Real errors: ${err.length}/${stats.length}`);

  if (ok.length > 0) {
    const ttfts = ok.map((s) => s.ttft_ms).filter((v): v is number => v !== undefined);
    const fulls = ok.map((s) => s.full_ms);
    const costs = ok.map((s) => s.cost_usd).filter((v): v is number => v !== undefined);
    const withTools = ok.filter((s) => s.tools_used.length > 0).length;
    const iters = ok.map((s) => s.iterations).filter((v): v is number => v !== undefined);

    console.log('');
    console.log('Latency (only OK calls):');
    console.log(`  TTFT  p50=${fmtMs(pct(ttfts, 50))} p95=${fmtMs(pct(ttfts, 95))} p99=${fmtMs(pct(ttfts, 99))} max=${fmtMs(Math.max(...ttfts))}`);
    console.log(`  Full  p50=${fmtMs(pct(fulls, 50))} p95=${fmtMs(pct(fulls, 95))} p99=${fmtMs(pct(fulls, 99))} max=${fmtMs(Math.max(...fulls))}`);
    console.log('');
    console.log('Tool use:');
    console.log(`  ${withTools}/${ok.length} (${((withTools / ok.length) * 100).toFixed(0)}%) used >=1 tool`);
    if (iters.length > 0) {
      console.log(`  Avg iterations: ${(iters.reduce((s, v) => s + v, 0) / iters.length).toFixed(2)}`);
    }
    console.log('');
    console.log('Cost:');
    if (costs.length > 0) {
      const mean = costs.reduce((s, v) => s + v, 0) / costs.length;
      const total = costs.reduce((s, v) => s + v, 0);
      console.log(`  mean=${fmt$(mean)} total=${fmt$(total)} max=${fmt$(Math.max(...costs))}`);
    }
  }

  // Write results JSON for the report.
  const outPath = join(process.cwd(), 'tests/server/wave3-stress-results.json');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outPath, JSON.stringify(stats, null, 2), 'utf8');
  console.log(`\nResults written to ${outPath}`);

  // Exit non-zero only if we have REAL errors (excluding 529).
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
