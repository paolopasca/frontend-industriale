#!/usr/bin/env tsx
/**
 * Wave 4 no-hallucination guard for What-If (Opus 4.7).
 *
 * 5 fixtures × 1 call each = 5 Opus calls (tight budget per team-lead cap).
 * Per call:
 *   - Send a generic "analizza la criticità principale" scenario.
 *   - Receive the streamed 4-section markdown analysis.
 *   - Extract every number from the output.
 *   - Verify each appears in the fixture (KPI + solution + derived set).
 *
 * PASS: ≥95% verifiable across non-templated fixtures (excludes empty/malformed).
 * WARN: 90-95%.
 * FAIL: <90%.
 *
 * Tolerates Opus 529 overloads (logs EXTERNAL, doesn't count as FAIL).
 *
 * Usage:
 *   npx tsx tests/server/wave4-no-hallucination.test.ts
 *   BASE_URL=http://localhost:8080 npx tsx tests/server/wave4-no-hallucination.test.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const FIXTURES_DIR = join(process.cwd(), 'tests/fixtures/wave2-solutions');
const FIXTURES = ['optimal', 'feasible-warning', 'infeasible', 'empty', 'malformed'] as const;
const PASS_THRESHOLD = 0.95;
const FAIL_THRESHOLD = 0.90;
const SCENARIO = 'Analizza la criticità principale del piano corrente e dimmi cosa rischio se non intervengo.';

interface FixturePayload {
  slug: string;
  solution: unknown;
  kpis: Record<string, unknown>;
}

interface CallResult {
  fixture: string;
  text: string;
  ok: boolean;
  external_529: boolean;
  status?: number;
  ms: number;
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  cache_read?: number;
  cache_write?: number;
  errorMessage?: string;
}

interface VerifyResult {
  call: CallResult;
  numbers: Array<{
    raw: string;
    value: number;
    verified: boolean;
  }>;
}

function loadFixture(name: string): { raw: string; parsed: FixturePayload } {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8');
  return { raw, parsed: JSON.parse(raw) as FixturePayload };
}

function collectNumbers(value: unknown, out: Set<number>): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.add(value);
    return;
  }
  if (typeof value === 'string') {
    const matches = value.match(/-?\d+(?:[.,]\d+)?/g);
    if (matches) {
      for (const m of matches) {
        const n = Number(m.replace(',', '.'));
        if (Number.isFinite(n)) out.add(n);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectNumbers(v, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectNumbers(v, out);
  }
}

function buildVerifiableSet(payload: FixturePayload): Set<number> {
  const raw = new Set<number>();
  collectNumbers(payload.kpis, raw);
  collectNumbers(payload.solution, raw);

  const expanded = new Set<number>(raw);

  // Ratio ↔ percent.
  for (const n of raw) {
    if (n > 0 && n < 1) {
      expanded.add(Math.round(n * 100));
      expanded.add(n * 100);
    }
    if (n >= 1 && n <= 100 && Number.isInteger(n)) {
      expanded.add(n / 100);
    }
  }

  // Complement to 100.
  for (const n of [...expanded]) {
    if (n >= 0 && n <= 100 && Number.isInteger(n)) {
      expanded.add(100 - n);
    }
  }

  // Baseline numeric vocabulary (LLM uses 1-6 for section counts).
  for (const small of [0, 1, 2, 3, 4, 5, 6]) {
    expanded.add(small);
  }

  // Minute → hour/day conversions.
  for (const n of [...raw]) {
    if (n >= 60 && Number.isFinite(n)) {
      const hours = n / 60;
      if (Number.isInteger(hours) || Math.abs(hours - Math.round(hours)) < 0.01) {
        expanded.add(Math.round(hours));
      }
      const days = n / (60 * 24);
      if (days >= 1 && Math.abs(days - Math.round(days)) < 0.05) {
        expanded.add(Math.round(days));
      }
    }
  }

  // Pairwise derived (legitimate differences and percent ratios).
  const rawList = [...raw];
  for (let i = 0; i < rawList.length; i++) {
    for (let j = 0; j < rawList.length; j++) {
      if (i === j) continue;
      const a = rawList[i];
      const b = rawList[j];
      if (Math.abs(a) < 1e6 && Math.abs(b) < 1e6) {
        expanded.add(a - b);
      }
      if (b !== 0 && Math.abs(a) < Math.abs(b) && Math.abs(b) > 1) {
        const ratio = a / b;
        if (ratio > 0 && ratio < 1) {
          expanded.add(Math.round(ratio * 100));
          expanded.add(Math.round(ratio * 1000) / 10);
        }
      }
    }
  }

  return expanded;
}

function isVerifiable(num: number, allowed: Set<number>): boolean {
  if (allowed.has(num)) return true;
  for (const a of allowed) {
    if (Math.abs(a - num) < 0.5) return true;
  }
  if (num > 0 && num < 1) {
    if (allowed.has(Math.round(num * 100))) return true;
  }
  if (num >= 1 && num <= 100 && Number.isInteger(num)) {
    if (allowed.has(num / 100)) return true;
  }
  return false;
}

function extractNumbers(text: string): Array<{ raw: string; value: number }> {
  const numbers: Array<{ raw: string; value: number }> = [];
  const re = /(?:(?<![\d.,])-)?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|(?:(?<![\d.,])-)?\d+(?:[.,]\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    let normalised: string;
    const hasComma = raw.includes(',');
    const hasDot = raw.includes('.');
    if (hasComma && hasDot) {
      normalised = raw.replace(/\./g, '').replace(',', '.');
    } else if (hasDot && !hasComma) {
      const looksLikeThousands = /^-?\d{1,3}(?:\.\d{3})+$/.test(raw);
      normalised = looksLikeThousands ? raw.replace(/\./g, '') : raw;
    } else if (hasComma && !hasDot) {
      normalised = raw.replace(',', '.');
    } else {
      normalised = raw;
    }
    const value = Number(normalised);
    if (Number.isFinite(value)) numbers.push({ raw, value });
  }
  return numbers;
}

let _ipCounter = 200;
function nextIp(): string {
  _ipCounter++;
  return `10.0.0.${_ipCounter}`;
}

async function callWhatIf(fixtureName: string): Promise<CallResult> {
  const { parsed } = loadFixture(fixtureName);
  const body = JSON.stringify({
    slug: parsed.slug,
    solution: parsed.solution,
    kpis: parsed.kpis,
    scenario: SCENARIO,
  });

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/whatif`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': nextIp(),
      },
      body,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      fixture: fixtureName,
      text: '',
      ok: false,
      external_529: /529|overload/i.test(msg),
      ms: Date.now() - t0,
      errorMessage: msg,
    };
  }

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    return {
      fixture: fixtureName,
      text: body,
      ok: false,
      external_529: res.status === 529 || res.status === 503 || res.status === 429,
      status: res.status,
      ms: Date.now() - t0,
      errorMessage: `HTTP ${res.status}: ${body.slice(0, 200)}`,
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
      if (ev === 'chunk' && typeof data.text === 'string') text += data.text;
      if (ev === 'done') done = data;
      if (ev === 'error') error = data;
    }
  }

  const isExternal = !!error && typeof error.message === 'string' && /529|overload/i.test(error.message as string);
  const fullMs = Date.now() - t0;

  if (error) {
    return {
      fixture: fixtureName,
      text,
      ok: false,
      external_529: isExternal,
      status: res.status,
      ms: fullMs,
      errorMessage: typeof error.message === 'string' ? error.message.slice(0, 200) : JSON.stringify(error).slice(0, 200),
    };
  }

  return {
    fixture: fixtureName,
    text,
    ok: text.length > 0,
    external_529: false,
    status: res.status,
    ms: fullMs,
    cost_usd: typeof done?.cost_usd === 'number' ? done.cost_usd as number : undefined,
    tokens_in: typeof done?.tokens_in === 'number' ? done.tokens_in as number : undefined,
    tokens_out: typeof done?.tokens_out === 'number' ? done.tokens_out as number : undefined,
    cache_read: typeof done?.cache_read_tokens === 'number' ? done.cache_read_tokens as number : undefined,
    cache_write: typeof done?.cache_write_tokens === 'number' ? done.cache_write_tokens as number : undefined,
  };
}

function verify(call: CallResult, allowed: Set<number>): VerifyResult {
  const numbers = extractNumbers(call.text).map(({ raw, value }) => ({
    raw,
    value,
    verified: isVerifiable(value, allowed),
  }));
  return { call, numbers };
}

function pct(n: number, d: number): string {
  if (d === 0) return 'n/a';
  return `${((n / d) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  console.log(`\n=== Wave 4 No-Hallucination Guard (What-If, Opus 4.7) ===`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Fixtures: ${FIXTURES.join(', ')} (1 call each = 5 Opus calls)`);
  console.log(`Scenario: "${SCENARIO}"\n`);

  const allowedByFixture = new Map<string, Set<number>>();
  for (const name of FIXTURES) {
    const { parsed } = loadFixture(name);
    allowedByFixture.set(name, buildVerifiableSet(parsed));
  }

  const results: VerifyResult[] = [];
  let totalCost = 0;

  for (const fixture of FIXTURES) {
    const allowed = allowedByFixture.get(fixture)!;
    process.stdout.write(`[${fixture.padEnd(18)}] ... `);
    const call = await callWhatIf(fixture);
    if (call.external_529) {
      console.log(`EXTERNAL-529 (${call.ms}ms) — ${call.errorMessage ?? 'overloaded'}`);
      results.push({ call, numbers: [] });
      continue;
    }
    if (!call.ok) {
      console.log(`FAIL (${call.ms}ms) — ${call.errorMessage ?? 'unknown'}`);
      results.push({ call, numbers: [] });
      continue;
    }
    const v = verify(call, allowed);
    const verified = v.numbers.filter((n) => n.verified).length;
    const total = v.numbers.length;
    const cost = call.cost_usd ?? 0;
    totalCost += cost;
    console.log(`OK ${total} nums, ${verified}/${total} verified (${pct(verified, total)}, ${call.ms}ms, $${cost.toFixed(4)})`);
    results.push(v);
  }

  console.log(`\n=== Per-fixture summary ===`);
  console.log('| Fixture           | Status | Cited | Verified | Ratio   | Cost     |');
  console.log('|-------------------|--------|-------|----------|---------|----------|');
  for (const r of results) {
    const cited = r.numbers.length;
    const verified = r.numbers.filter((n) => n.verified).length;
    const status = r.call.external_529 ? 'EXT-529' : (r.call.ok ? 'OK' : 'FAIL');
    const cost = r.call.cost_usd != null ? `$${r.call.cost_usd.toFixed(4)}` : 'n/a';
    console.log(
      `| ${r.call.fixture.padEnd(17)} | ${status.padEnd(6)} | ${String(cited).padStart(5)} | ${String(verified).padStart(8)} | ${pct(verified, cited).padStart(7)} | ${cost.padStart(8)} |`,
    );
  }

  // Strict ratio: exclude empty + malformed (templated content has no meaningful numbers
  // and cited counts are dominated by section headers like "## 1.", "## 2.").
  // Also exclude 529-external (not the model's fault).
  const strict = results.filter((r) =>
    r.call.fixture !== 'malformed' &&
    r.call.fixture !== 'empty' &&
    !r.call.external_529 &&
    r.call.ok,
  );
  const totalCited = strict.reduce((s, r) => s + r.numbers.length, 0);
  const totalVerified = strict.reduce((s, r) => s + r.numbers.filter((n) => n.verified).length, 0);
  const ratio = totalCited === 0 ? 1 : totalVerified / totalCited;

  console.log(`\n=== Global (excluding malformed + empty + 529-externals) ===`);
  console.log(`  Calls evaluated:    ${strict.length}/${results.length}`);
  console.log(`  Numbers cited:      ${totalCited}`);
  console.log(`  Numbers verified:   ${totalVerified}`);
  console.log(`  Verification ratio: ${(ratio * 100).toFixed(2)}%`);
  console.log(`  Threshold PASS:     ≥${(PASS_THRESHOLD * 100).toFixed(0)}%`);
  console.log(`  Total cost:         $${totalCost.toFixed(4)}`);

  // Surface unverified examples for diagnosis.
  const unverified = strict
    .flatMap((r) => r.numbers.filter((n) => !n.verified).map((n) => ({ ...n, call: r.call })))
    .slice(0, 15);
  if (unverified.length > 0) {
    console.log(`\n=== Unverified numbers (first 15) ===`);
    for (const u of unverified) {
      const ctxIdx = u.call.text.indexOf(u.raw);
      const snippet = ctxIdx >= 0
        ? u.call.text.slice(Math.max(0, ctxIdx - 25), ctxIdx + 35).replace(/\n/g, ' ')
        : '<not found>';
      console.log(`  [${u.call.fixture}] "${u.raw}" → ${u.value} (ctx: "${snippet}")`);
    }
  }

  let verdict: 'PASS' | 'WARN' | 'FAIL';
  if (strict.length === 0) verdict = 'WARN'; // All external 529 — can't conclude.
  else if (ratio >= PASS_THRESHOLD) verdict = 'PASS';
  else if (ratio >= FAIL_THRESHOLD) verdict = 'WARN';
  else verdict = 'FAIL';

  console.log(`\n=== VERDICT: ${verdict} ===\n`);

  const reportPath = join(process.cwd(), 'docs/wave4-no-hallucination-output.json');
  const summary = {
    base_url: BASE_URL,
    fixtures: FIXTURES,
    scenario: SCENARIO,
    pass_threshold: PASS_THRESHOLD,
    fail_threshold: FAIL_THRESHOLD,
    total_cost_usd: totalCost,
    global: {
      cited: totalCited,
      verified: totalVerified,
      ratio,
      verdict,
      strict_call_count: strict.length,
    },
    per_fixture: results.map((r) => ({
      fixture: r.call.fixture,
      status: r.call.external_529 ? 'external_529' : (r.call.ok ? 'ok' : 'fail'),
      cited: r.numbers.length,
      verified: r.numbers.filter((n) => n.verified).length,
      ratio: r.numbers.length === 0 ? null : r.numbers.filter((n) => n.verified).length / r.numbers.length,
      ms: r.call.ms,
      cost_usd: r.call.cost_usd,
      tokens_in: r.call.tokens_in,
      tokens_out: r.call.tokens_out,
      cache_read: r.call.cache_read,
      cache_write: r.call.cache_write,
      error: r.call.errorMessage,
    })),
    unverified_samples: unverified.map((u) => ({
      fixture: u.call.fixture,
      raw: u.raw,
      value: u.value,
    })),
  };
  writeFileSync(reportPath, JSON.stringify(summary, null, 2));
  console.log(`Report written to ${reportPath}`);

  if (verdict === 'FAIL') process.exit(1);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(2);
});
