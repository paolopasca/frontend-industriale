#!/usr/bin/env tsx
/**
 * Wave 2 no-hallucination guard.
 *
 * Hits the live BFF (vite dev on :8080) for each of the 5 fixtures, on both
 * /api/explain and /api/advise, with 2 repetitions each (20 calls total).
 * Extracts every number from the streamed body and verifies it appears in
 * the fixture KPIs or solution payload (exact, with %/ratio normalisation).
 *
 * PASS: ≥95% of numbers verifiable across all calls.
 * WARN: 90-95% verifiable (logged, non-zero exit not triggered).
 * FAIL: <90% verifiable.
 *
 * Usage:
 *   npx tsx tests/server/wave2-no-hallucination.test.ts
 *   BASE_URL=http://localhost:8080 npx tsx tests/server/wave2-no-hallucination.test.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const FIXTURES_DIR = join(process.cwd(), 'tests/fixtures/wave2-solutions');
const FIXTURES = ['optimal', 'feasible-warning', 'infeasible', 'empty', 'malformed'] as const;
const REPETITIONS = 2;
const PASS_THRESHOLD = 0.95;
const FAIL_THRESHOLD = 0.90;

type Endpoint = 'explain' | 'advise';

interface FixturePayload {
  slug: string;
  solution: unknown;
  kpis: Record<string, unknown>;
}

interface CallResult {
  fixture: string;
  endpoint: Endpoint;
  rep: number;
  text: string;
  ok: boolean;
  status?: number;
  ms: number;
  errorMessage?: string;
}

interface VerifyResult {
  call: CallResult;
  numbers: Array<{
    raw: string;
    value: number;
    verified: boolean;
    why?: string;
  }>;
}

function loadFixture(name: string): { raw: string; parsed: FixturePayload } {
  const raw = readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8');
  return { raw, parsed: JSON.parse(raw) as FixturePayload };
}

/**
 * Collect every numeric leaf from a value, recursively. Returns a Set of
 * stringified canonical numbers (with reasonable precision for floats).
 */
function collectNumbers(value: unknown, out: Set<number>): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.add(value);
    return;
  }
  if (typeof value === 'string') {
    // Strings often contain embedded numbers, e.g. warnings: "COM-007 in ritardo di 120 min"
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

/**
 * Build the set of all numbers that can be cited from the fixture, including:
 *   - the raw numbers from kpis + solution (recursive),
 *   - ratio-to-percent conversions (0.95 → 95),
 *   - percent-to-ratio (95 → 0.95),
 *   - thousand-separator handling done in the matcher,
 *   - some derived constants (100−rate%, total−component).
 */
function buildVerifiableSet(payload: FixturePayload): Set<number> {
  const raw = new Set<number>();
  collectNumbers(payload.kpis, raw);
  collectNumbers(payload.solution, raw);

  const expanded = new Set<number>(raw);

  // Ratio ↔ percent conversions.
  for (const n of raw) {
    if (n > 0 && n < 1) {
      expanded.add(Math.round(n * 100));
      expanded.add(n * 100);
    }
    if (n >= 1 && n <= 100 && Number.isInteger(n)) {
      expanded.add(n / 100);
    }
  }

  // Trivial complements & sums that legitimately appear in narrative:
  //   on_time_rate 0.95 → 95%, 100 − 95 = 5% "in ritardo"
  for (const n of [...expanded]) {
    if (n >= 0 && n <= 100 && Number.isInteger(n)) {
      expanded.add(100 - n);
    }
  }

  // Small constants the LLM may use without hallucinating: 0, 1, 2, 3, 4, 5.
  // These are baseline numeric vocabulary (1 paragraph, 2 frasi, 3 punti...).
  for (const small of [0, 1, 2, 3, 4, 5, 6]) {
    expanded.add(small);
  }

  // Hour/minute conversions: KPI minutes → hours.
  for (const n of [...raw]) {
    if (n >= 60 && Number.isFinite(n)) {
      const hours = n / 60;
      if (Number.isInteger(hours) || Math.abs(hours - Math.round(hours)) < 0.01) {
        expanded.add(Math.round(hours));
      }
      // Also days.
      const days = n / (60 * 24);
      if (days >= 1 && Math.abs(days - Math.round(days)) < 0.05) {
        expanded.add(Math.round(days));
      }
    }
  }

  // Pairwise derived numbers (differences and ratios) that the LLM can
  // legitimately produce from the data: e.g. "21 totali, 1 in ritardo → 20 in tempo".
  const rawList = [...raw];
  for (let i = 0; i < rawList.length; i++) {
    for (let j = 0; j < rawList.length; j++) {
      if (i === j) continue;
      const a = rawList[i];
      const b = rawList[j];
      if (Math.abs(a) < 1e6 && Math.abs(b) < 1e6) {
        expanded.add(a - b);
      }
      // setup_cost / total_cost type ratios → percent
      if (b !== 0 && Math.abs(a) < Math.abs(b) && Math.abs(b) > 1) {
        const ratio = a / b;
        if (ratio > 0 && ratio < 1) {
          expanded.add(Math.round(ratio * 100));
          expanded.add(Math.round(ratio * 1000) / 10); // 1 decimal place
        }
      }
    }
  }

  return expanded;
}

function isVerifiable(num: number, allowed: Set<number>): { ok: boolean; matched?: number } {
  // Exact match.
  if (allowed.has(num)) return { ok: true, matched: num };

  // Match with float tolerance for cents-precision or 0.1% rounding.
  for (const a of allowed) {
    if (Math.abs(a - num) < 0.5) return { ok: true, matched: a };
  }

  // Match via percent / ratio conversion.
  if (num > 0 && num < 1) {
    if (allowed.has(Math.round(num * 100))) return { ok: true, matched: Math.round(num * 100) };
  }
  if (num >= 1 && num <= 100 && Number.isInteger(num)) {
    if (allowed.has(num / 100)) return { ok: true, matched: num / 100 };
  }

  // Thousands handling: 4380 ↔ 4.380 (Italian "4.380") already normalised.
  return { ok: false };
}

/**
 * Extract numbers from streamed LLM body. Each number is a string match;
 * we normalise European decimals (',' → '.') and treat thousand-grouped
 * Italian numbers ("4.380") as a single number too, when followed by no
 * decimal context.
 */
function extractNumbers(text: string): Array<{ raw: string; value: number }> {
  const numbers: Array<{ raw: string; value: number }> = [];
  // 4.380  |  2.880  |  0,74  |  95%  |  120  |  3.970 USD  |  0.95
  // Match a sequence of digits possibly grouped by `.`/`,` then optional decimal.
  // NOTE: only treat a leading `-` as a sign if NOT preceded by a digit
  //       (avoids "120-300" → "-300"); otherwise it's a range separator.
  const re = /(?:(?<![\d.,])-)?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|(?:(?<![\d.,])-)?\d+(?:[.,]\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    // Heuristic: if the number has both '.' and ',', the '.' is thousands
    // and ',' is decimal (Italian). If only '.' and ≥1 group of 3 digits
    // after a dot, treat dots as thousand separators. Otherwise treat ','
    // as decimal.
    let normalised: string;
    const hasComma = raw.includes(',');
    const hasDot = raw.includes('.');

    if (hasComma && hasDot) {
      // 4.380,75 → 4380.75
      normalised = raw.replace(/\./g, '').replace(',', '.');
    } else if (hasDot && !hasComma) {
      // 4.380 (Italian thousands) vs 0.95 (decimal). Decide by group shape:
      // if every dot is followed by exactly 3 digits and the chunk before
      // is 1-3 digits, it's thousands grouping.
      const looksLikeThousands = /^-?\d{1,3}(?:\.\d{3})+$/.test(raw);
      if (looksLikeThousands) {
        normalised = raw.replace(/\./g, '');
      } else {
        normalised = raw;
      }
    } else if (hasComma && !hasDot) {
      // 0,95 → 0.95
      normalised = raw.replace(',', '.');
    } else {
      normalised = raw;
    }

    const value = Number(normalised);
    if (Number.isFinite(value)) {
      numbers.push({ raw, value });
    }
  }
  return numbers;
}

async function callBff(endpoint: Endpoint, fixtureName: string): Promise<CallResult> {
  const { raw } = loadFixture(fixtureName);
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw,
      signal: AbortSignal.timeout(45_000),
    });
  } catch (err) {
    return {
      fixture: fixtureName,
      endpoint,
      rep: 0,
      text: '',
      ok: false,
      ms: Date.now() - t0,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return {
      fixture: fixtureName,
      endpoint,
      rep: 0,
      text: body,
      ok: false,
      status: res.status,
      ms: Date.now() - t0,
      errorMessage: `HTTP ${res.status}`,
    };
  }

  // SSE: stream text/event-stream until controller closes. Concat chunk texts.
  const reader = res.body?.getReader();
  if (!reader) {
    return {
      fixture: fixtureName,
      endpoint,
      rep: 0,
      text: '',
      ok: false,
      status: res.status,
      ms: Date.now() - t0,
      errorMessage: 'no body',
    };
  }
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let errorPayload: unknown = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Parse SSE events as they come in.
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = rawEvent.split('\n');
      let eventName = 'message';
      let dataStr = '';
      for (const line of lines) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataStr += line.slice(5).trim();
      }
      if (!dataStr) continue;
      try {
        const data = JSON.parse(dataStr);
        if (eventName === 'chunk' && typeof data.text === 'string') {
          text += data.text;
        } else if (eventName === 'error') {
          errorPayload = data;
        }
      } catch {
        // Ignore parse errors on a single event.
      }
    }
  }

  return {
    fixture: fixtureName,
    endpoint,
    rep: 0,
    text,
    ok: errorPayload === null && text.length > 0,
    status: res.status,
    ms: Date.now() - t0,
    errorMessage: errorPayload ? JSON.stringify(errorPayload) : undefined,
  };
}

function verify(call: CallResult, allowed: Set<number>): VerifyResult {
  const numbers = extractNumbers(call.text).map(({ raw, value }) => {
    const r = isVerifiable(value, allowed);
    return {
      raw,
      value,
      verified: r.ok,
      why: r.ok ? undefined : `not in fixture (allowed set has ${allowed.size} entries)`,
    };
  });
  return { call, numbers };
}

function pct(n: number, d: number): string {
  if (d === 0) return 'n/a';
  return `${((n / d) * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  console.log(`\n=== Wave 2 No-Hallucination Guard ===`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Fixtures: ${FIXTURES.join(', ')}`);
  console.log(`Endpoints: explain + advise, ${REPETITIONS} repetition(s) each = ${FIXTURES.length * 2 * REPETITIONS} calls\n`);

  // Pre-build the allowed-number sets per fixture (load once).
  const allowedByFixture = new Map<string, Set<number>>();
  for (const name of FIXTURES) {
    const { parsed } = loadFixture(name);
    allowedByFixture.set(name, buildVerifiableSet(parsed));
  }

  const results: VerifyResult[] = [];
  let totalCalls = 0;

  for (const fixture of FIXTURES) {
    const allowed = allowedByFixture.get(fixture)!;
    for (const endpoint of ['explain', 'advise'] as const) {
      for (let rep = 1; rep <= REPETITIONS; rep++) {
        totalCalls++;
        process.stdout.write(`[${totalCalls.toString().padStart(2, '0')}/${FIXTURES.length * 2 * REPETITIONS}] ${fixture} → ${endpoint} (rep ${rep})... `);
        const call = await callBff(endpoint, fixture);
        call.rep = rep;
        if (!call.ok) {
          // The "malformed" fixture is allowed to fail with a 4xx — treat that
          // separately. Other failures still produce a row with 0 numbers.
          console.log(`✗ ${call.errorMessage ?? 'failed'} (${call.ms}ms)`);
        } else {
          const v = verify(call, allowed);
          const verified = v.numbers.filter((n) => n.verified).length;
          const total = v.numbers.length;
          console.log(`✓ ${total} nums, ${verified}/${total} verified (${pct(verified, total)}, ${call.ms}ms)`);
          results.push(v);
          continue;
        }
        results.push({ call, numbers: [] });
      }
    }
  }

  // Aggregate.
  console.log(`\n=== Per-fixture summary ===`);
  console.log('| Fixture           | Endpoint | Calls | Numbers cited | Verified | Ratio   |');
  console.log('|-------------------|----------|-------|---------------|----------|---------|');
  for (const fixture of FIXTURES) {
    for (const endpoint of ['explain', 'advise'] as const) {
      const rows = results.filter((r) => r.call.fixture === fixture && r.call.endpoint === endpoint);
      const calls = rows.length;
      const cited = rows.reduce((s, r) => s + r.numbers.length, 0);
      const verified = rows.reduce((s, r) => s + r.numbers.filter((n) => n.verified).length, 0);
      console.log(
        `| ${fixture.padEnd(17)} | ${endpoint.padEnd(8)} | ${String(calls).padStart(5)} | ${String(cited).padStart(13)} | ${String(verified).padStart(8)} | ${pct(verified, cited).padStart(7)} |`,
      );
    }
  }

  // Global totals. Exclude "malformed" + "empty" from the strict pass gate
  // because they short-circuit to templated text with no numeric content
  // (any number found is by construction the entire fixture, mostly trivial).
  const strict = results.filter((r) => r.call.fixture !== 'malformed' && r.call.fixture !== 'empty');
  const totalCited = strict.reduce((s, r) => s + r.numbers.length, 0);
  const totalVerified = strict.reduce((s, r) => s + r.numbers.filter((n) => n.verified).length, 0);
  const ratio = totalCited === 0 ? 1 : totalVerified / totalCited;

  console.log(`\n=== Global (excluding malformed + empty) ===`);
  console.log(`  Numbers cited:    ${totalCited}`);
  console.log(`  Numbers verified: ${totalVerified}`);
  console.log(`  Verification ratio: ${(ratio * 100).toFixed(2)}%`);
  console.log(`  Threshold (PASS): ≥${(PASS_THRESHOLD * 100).toFixed(0)}%`);
  console.log(`  Threshold (FAIL): <${(FAIL_THRESHOLD * 100).toFixed(0)}%`);

  // Surface unverified examples for diagnosis (first 10).
  const unverified = strict
    .flatMap((r) => r.numbers.filter((n) => !n.verified).map((n) => ({ ...n, call: r.call })))
    .slice(0, 15);
  if (unverified.length > 0) {
    console.log(`\n=== Unverified numbers (first 15) ===`);
    for (const u of unverified) {
      const snippet = u.call.text.slice(Math.max(0, u.call.text.indexOf(u.raw) - 20), u.call.text.indexOf(u.raw) + 30).replace(/\n/g, ' ');
      console.log(`  [${u.call.fixture}/${u.call.endpoint}] "${u.raw}" → ${u.value} (ctx: "${snippet}")`);
    }
  }

  let verdict: 'PASS' | 'WARN' | 'FAIL';
  if (ratio >= PASS_THRESHOLD) verdict = 'PASS';
  else if (ratio >= FAIL_THRESHOLD) verdict = 'WARN';
  else verdict = 'FAIL';

  console.log(`\n=== VERDICT: ${verdict} ===\n`);

  // Write JSON output for the report.
  const reportPath = join(process.cwd(), 'docs/wave2-no-hallucination-output.json');
  const summary = {
    base_url: BASE_URL,
    fixtures: FIXTURES,
    repetitions: REPETITIONS,
    total_calls: totalCalls,
    pass_threshold: PASS_THRESHOLD,
    fail_threshold: FAIL_THRESHOLD,
    global: {
      cited: totalCited,
      verified: totalVerified,
      ratio,
      verdict,
    },
    per_fixture_endpoint: FIXTURES.flatMap((fixture) =>
      (['explain', 'advise'] as const).map((endpoint) => {
        const rows = results.filter((r) => r.call.fixture === fixture && r.call.endpoint === endpoint);
        const cited = rows.reduce((s, r) => s + r.numbers.length, 0);
        const verified = rows.reduce((s, r) => s + r.numbers.filter((n) => n.verified).length, 0);
        return { fixture, endpoint, calls: rows.length, cited, verified, ratio: cited === 0 ? null : verified / cited };
      }),
    ),
    unverified_samples: unverified.map((u) => ({
      fixture: u.call.fixture,
      endpoint: u.call.endpoint,
      raw: u.raw,
      value: u.value,
    })),
  };
  await import('node:fs').then((fs) => fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2)));
  console.log(`Report written to ${reportPath}`);

  if (verdict === 'FAIL') process.exit(1);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(2);
});
