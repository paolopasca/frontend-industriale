#!/usr/bin/env tsx
/**
 * Wave 5 split correctness tests.
 *
 * Calls /api/split via SSE on real fixtures and verifies:
 *   1. HTTP 200 + SSE event stream (chunk + done events).
 *   2. The 4 required markdown sections appear in order:
 *      ## Diagnosi, ## Proposta di split, ## Rischi, ## Stima impatto.
 *      The "infeasible" case is exempt from the order check because the model
 *      legitimately may answer "Commessa <id> non presente" first.
 *   3. Every machine ID and commessa ID cited in the output exists in the
 *      fixture input (no hallucination). Allowed exceptions: synthetic
 *      "SUB-NNN" sub-order labels invented by the model (prefix SUB- is the
 *      explicit naming convention from the system prompt).
 *
 * Tolerates Opus 4.7 transient 529 "overloaded": logs as EXTERNAL, not FAIL.
 *
 * Usage:
 *   npx tsx tests/server/wave5-split-correctness.test.ts
 *   BASE_URL=http://localhost:8080 npx tsx tests/server/wave5-split-correctness.test.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const FIXTURES_DIR = join(process.cwd(), 'tests/fixtures/wave2-solutions');

interface Fixture {
  slug: string;
  solution: unknown;
  kpis: Record<string, number>;
}

function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8'));
}

interface CallOutcome {
  case_id: string;
  fixture: string;
  commessa: string;
  status: number;
  text: string;
  done: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  full_ms: number;
  external: boolean;
  network_error?: string;
}

async function callSplit(
  fix: Fixture,
  commessa: string,
): Promise<{ status: number; text: string; done: Record<string, unknown> | null; error: Record<string, unknown> | null; full_ms: number; network_error?: string }> {
  const body = JSON.stringify({
    slug: fix.slug,
    commessa,
    solution: fix.solution,
    kpis: fix.kpis,
  });

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/split`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    return {
      status: 0,
      text: '',
      done: null,
      error: null,
      full_ms: Date.now() - t0,
      network_error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!res.ok || !res.body) {
    return {
      status: res.status,
      text: await res.text(),
      done: null,
      error: null,
      full_ms: Date.now() - t0,
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

  return { status: res.status, text, done, error, full_ms: Date.now() - t0 };
}

function isExternal529(error: Record<string, unknown> | null, status: number, network_error?: string): boolean {
  if (status === 503 || status === 429) return true;
  if (network_error && /529|overload|rate.?limit/i.test(network_error)) return true;
  if (!error) return false;
  const msg = typeof error.message === 'string' ? error.message : '';
  return /529|overloaded|rate.?limit/i.test(msg);
}

interface VerifyResult {
  ok: boolean;
  reasons: string[];
  warnings: string[];
}

const REQUIRED_SECTIONS = [
  /^##\s+Diagnosi\s*$/m,
  /^##\s+Proposta di split\s*$/m,
  /^##\s+Rischi\s*$/m,
  /^##\s+Stima impatto\s*$/m,
] as const;

/**
 * Walks the solution payload and collects every M-NN and COM-NNN token
 * mentioned anywhere — as a struct field value (e.g. `macchina: "M-3"`),
 * as part of a free-text reason or vincolo, or as a key. This is the set
 * the model is allowed to cite without being flagged as hallucination.
 */
function collectTokens(solution: unknown, re: RegExp): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (v == null) return;
    if (typeof v === 'string') {
      const matches = v.match(re);
      if (matches) for (const m of matches) out.add(m);
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) walk(val);
    }
  };
  walk(solution);
  return out;
}

function collectMachineIds(solution: unknown): Set<string> {
  return collectTokens(solution, /\bM-\d+[A-Za-z0-9]*\b/g);
}

function collectCommessaIds(solution: unknown): Set<string> {
  return collectTokens(solution, /\bCOM-\d+[A-Za-z0-9]*\b/g);
}

function verifyResponse(outcome: CallOutcome, fix: Fixture, requireOrder: boolean): VerifyResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  const text = outcome.text;

  // 1. The four sections must all appear.
  const positions: number[] = [];
  for (const re of REQUIRED_SECTIONS) {
    const m = text.match(re);
    if (!m || m.index == null) {
      reasons.push(`MISSING_SECTION:${re.source}`);
    } else {
      positions.push(m.index);
    }
  }

  // 2. They must appear in order (only if all 4 are present AND requireOrder).
  if (requireOrder && positions.length === REQUIRED_SECTIONS.length) {
    for (let i = 1; i < positions.length; i++) {
      if (positions[i] < positions[i - 1]) {
        reasons.push('SECTIONS_OUT_OF_ORDER');
        break;
      }
    }
  }

  // 3. No-hallucination: every M-NN and COM-NNN token cited in the output
  //    must exist in the fixture solution OR be the target commessa the user
  //    asked to split. Tokens of the form SUB-... are allowed as synthetic
  //    sub-order labels (system prompt explicitly invents them).
  const knownMachines = collectMachineIds(fix.solution);
  const knownCommesse = collectCommessaIds(fix.solution);
  knownCommesse.add(outcome.commessa); // target commessa is part of the request

  const machineTokens = new Set(text.match(/\bM-\d+[A-Za-z0-9]*\b/g) ?? []);
  const orderTokens = new Set(text.match(/\bCOM-\d+[A-Za-z0-9]*\b/g) ?? []);
  const subTokens = new Set(text.match(/\bSUB-\d+[A-Za-z0-9]*\b/g) ?? []);

  for (const m of machineTokens) {
    if (!knownMachines.has(m)) reasons.push(`HALLUCINATED_MACHINE:${m}`);
  }
  for (const c of orderTokens) {
    if (!knownCommesse.has(c)) reasons.push(`HALLUCINATED_COMMESSA:${c}`);
  }
  if (subTokens.size > 0) {
    warnings.push(`SUB_LABELS:${[...subTokens].join(',')}`);
  }

  return { ok: reasons.length === 0, reasons, warnings };
}

interface CaseSpec {
  case_id: string;
  fixture_name: string;
  commessa: string;
  require_order: boolean; // 'infeasible' may legitimately answer with a refusal preamble
  expect_strict_sections: boolean;
}

const CASES: CaseSpec[] = [
  {
    case_id: 'CASE-COM001-OPTIMAL',
    fixture_name: 'optimal',
    commessa: 'COM-001',
    require_order: true,
    expect_strict_sections: true,
  },
  {
    case_id: 'CASE-COM-INFEASIBLE',
    // The 'infeasible' fixture has KPI but no fasi[]. We pick a commessa name
    // that does NOT exist in the solution; the model should still produce the
    // 4 sections (with Diagnosi explaining the issue).
    fixture_name: 'infeasible',
    commessa: 'COM-001',
    require_order: false,
    expect_strict_sections: true,
  },
];

async function main() {
  console.log(`Wave 5 split-correctness — ${CASES.length} cases against ${BASE_URL}`);
  console.log('');

  const outcomes: CallOutcome[] = [];

  for (const c of CASES) {
    const fix = loadFixture(c.fixture_name);
    process.stdout.write(`[${c.case_id}] fixture=${c.fixture_name} commessa=${c.commessa} ...`);
    const r = await callSplit(fix, c.commessa);
    const external = isExternal529(r.error, r.status, r.network_error);
    const outcome: CallOutcome = {
      case_id: c.case_id,
      fixture: c.fixture_name,
      commessa: c.commessa,
      status: r.status,
      text: r.text,
      done: r.done,
      error: r.error,
      full_ms: r.full_ms,
      external,
      network_error: r.network_error,
    };
    outcomes.push(outcome);

    if (external) {
      console.log(` EXTERNAL (529/overloaded) in ${r.full_ms}ms`);
    } else if (r.network_error) {
      console.log(` NET-ERR in ${r.full_ms}ms — ${r.network_error}`);
    } else if (r.status !== 200) {
      console.log(` HTTP ${r.status} in ${r.full_ms}ms — ${r.text.slice(0, 120)}`);
    } else {
      const v = verifyResponse(outcome, fix, c.require_order);
      if (v.ok) {
        const warnStr = v.warnings.length > 0 ? ` (warn: ${v.warnings.join('; ')})` : '';
        console.log(` PASS in ${r.full_ms}ms (chars=${r.text.length})${warnStr}`);
      } else {
        console.log(` FAIL in ${r.full_ms}ms — ${v.reasons.join(', ')}`);
      }
    }
  }

  console.log('');
  console.log('=== Summary ===');
  let pass = 0, fail = 0, ext = 0;
  for (let i = 0; i < outcomes.length; i++) {
    const o = outcomes[i];
    const c = CASES[i];
    const fix = loadFixture(c.fixture_name);
    if (o.external) { ext++; continue; }
    if (o.network_error || o.status !== 200) { fail++; continue; }
    const v = verifyResponse(o, fix, c.require_order);
    if (v.ok) pass++;
    else fail++;
  }
  console.log(`PASS=${pass}, FAIL=${fail}, EXTERNAL(529)=${ext}, TOTAL=${CASES.length}`);

  const outPath = join(process.cwd(), 'tests/server/wave5-split-correctness-results.json');
  writeFileSync(outPath, JSON.stringify(outcomes, null, 2), 'utf8');
  console.log(`Results written to ${outPath}`);

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
