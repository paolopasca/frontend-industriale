#!/usr/bin/env tsx
/**
 * Wave 2 edge-case tests against the live BFF.
 *
 * For each of the 5 fixtures, hits both /api/explain and /api/advise
 * and asserts:
 *   - the response is structurally graceful (200 + non-empty SSE body,
 *     or 4xx with a JSON error message for malformed inputs),
 *   - the body matches a per-fixture template heuristic
 *     (OPTIMAL → ✅; FEASIBLE → "fattibile|feasibile|FEASIBLE";
 *      INFEASIBLE → "non possibile|vincoli|INFEASIBLE"; empty → "Nessuna commessa pianificabile";
 *      malformed → templated "Pianificazione non disponibile" or 400 JSON error).
 *
 * Exit 0 on pass, 1 on fail. Designed to run after npm run dev:bff.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const FIXTURES_DIR = join(process.cwd(), 'tests/fixtures/wave2-solutions');

type Endpoint = 'explain' | 'advise';
type Fixture = 'optimal' | 'feasible-warning' | 'infeasible' | 'empty' | 'malformed';

interface ExpectedShape {
  /** Per-endpoint regex (or array of options OR'd together) the body must match. */
  explain: RegExp[];
  advise: RegExp[];
  /** Whether a 4xx response is an acceptable graceful failure here. */
  acceptable_4xx?: boolean;
}

const EXPECTATIONS: Record<Fixture, ExpectedShape> = {
  optimal: {
    explain: [/✅|ottimale|OPTIMAL|pianificazione/i],
    advise: [/✅|🟡|⚠️|📋/, /\d\.\s/],
  },
  'feasible-warning': {
    explain: [/FEASIBLE|fattibile|feasibile|ritardo|saturazione|⚠️/i],
    advise: [/⚠️|COM-007|ritardo|M-3/i],
  },
  infeasible: {
    explain: [/INFEASIBLE|non possibile|vincoli|capacit[aà]|infeasibility|impossibile/i],
    advise: [/⚠️|📋|vincoli|capacit|deadline|rilass|estendi/i],
  },
  empty: {
    explain: [/Nessuna commessa pianificabile|verifica i dati|finestra temporale|verifica.*dati/i],
    advise: [/📋|verifica|deadline|input|dati/i],
  },
  malformed: {
    explain: [/Pianificazione non disponibile|non in un formato leggibile|invalid|invalid_body|non e JSON|invalid_json/i],
    advise: [/Pianificazione non disponibile|non in un formato leggibile|verifica|dati|invalid/i],
    acceptable_4xx: true,
  },
};

interface CallOutcome {
  fixture: Fixture;
  endpoint: Endpoint;
  status: number;
  body: string;
  ms: number;
  isStream: boolean;
}

async function callBff(endpoint: Endpoint, fixture: Fixture): Promise<CallOutcome> {
  const raw = readFileSync(join(FIXTURES_DIR, `${fixture}.json`), 'utf8');
  const t0 = Date.now();
  const res = await fetch(`${BASE_URL}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw,
    signal: AbortSignal.timeout(45_000),
  });

  const isStream = (res.headers.get('content-type') ?? '').includes('text/event-stream');
  let body = '';
  if (isStream && res.body) {
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
        try {
          const data = JSON.parse(dataStr);
          if (eventName === 'chunk' && typeof data.text === 'string') {
            body += data.text;
          } else if (eventName === 'error') {
            body += `\n[ERROR EVENT: ${JSON.stringify(data)}]`;
          }
        } catch {
          // ignore
        }
      }
    }
  } else {
    body = await res.text().catch(() => '');
  }

  return { fixture, endpoint, status: res.status, body, ms: Date.now() - t0, isStream };
}

interface CheckResult {
  fixture: Fixture;
  endpoint: Endpoint;
  status: number;
  ms: number;
  isStream: boolean;
  preview: string;
  pass: boolean;
  reasons: string[];
}

function checkOutcome(o: CallOutcome): CheckResult {
  const reasons: string[] = [];
  const exp = EXPECTATIONS[o.fixture];

  // No 5xx ever.
  if (o.status >= 500) {
    reasons.push(`HTTP ${o.status} — backend crashed (5xx is never acceptable)`);
  }

  // Status check.
  if (o.status >= 400 && o.status < 500) {
    if (!exp.acceptable_4xx) {
      reasons.push(`HTTP ${o.status} not acceptable for this fixture`);
    }
  } else if (o.status !== 200) {
    reasons.push(`HTTP ${o.status} unexpected`);
  }

  // Body non-empty.
  if (!o.body || o.body.length < 5) {
    reasons.push(`Body is empty or near-empty (${o.body.length} chars)`);
  }

  // Template match (only check on success path; on 4xx the response body is
  // a JSON error message, which we test separately).
  if (o.status === 200) {
    const regexes = exp[o.endpoint];
    const matched = regexes.every((re) => re.test(o.body));
    if (!matched) {
      const failing = regexes.filter((re) => !re.test(o.body)).map((re) => re.source);
      reasons.push(`Body did not match expected pattern(s): ${failing.join(' AND ')}`);
    }
  } else if (exp.acceptable_4xx && o.status >= 400 && o.status < 500) {
    // The 4xx body should be JSON with at minimum a `message` field for the user.
    let json: { message?: string; error?: string } | null = null;
    try {
      json = JSON.parse(o.body);
    } catch {
      reasons.push(`4xx body is not JSON: ${o.body.slice(0, 100)}`);
    }
    if (json && !json.message && !json.error) {
      reasons.push(`4xx JSON lacks message/error field`);
    }
  }

  return {
    fixture: o.fixture,
    endpoint: o.endpoint,
    status: o.status,
    ms: o.ms,
    isStream: o.isStream,
    preview: o.body.slice(0, 120).replace(/\n/g, ' '),
    pass: reasons.length === 0,
    reasons,
  };
}

async function main(): Promise<void> {
  console.log(`\n=== Wave 2 Edge-Case Tests ===`);
  console.log(`Base URL: ${BASE_URL}\n`);

  const results: CheckResult[] = [];
  const fixtures: Fixture[] = ['optimal', 'feasible-warning', 'infeasible', 'empty', 'malformed'];
  const endpoints: Endpoint[] = ['explain', 'advise'];

  let i = 0;
  for (const f of fixtures) {
    for (const e of endpoints) {
      i++;
      process.stdout.write(`[${i.toString().padStart(2, '0')}/${fixtures.length * endpoints.length}] ${f} → ${e}... `);
      try {
        const outcome = await callBff(e, f);
        const check = checkOutcome(outcome);
        results.push(check);
        const tag = check.pass ? '✓' : '✗';
        console.log(`${tag} HTTP ${check.status} (${check.ms}ms) — ${check.preview.slice(0, 60)}...`);
        if (!check.pass) {
          for (const r of check.reasons) console.log(`   reason: ${r}`);
        }
      } catch (err) {
        console.log(`✗ EXCEPTION: ${err instanceof Error ? err.message : String(err)}`);
        results.push({
          fixture: f,
          endpoint: e,
          status: 0,
          ms: 0,
          isStream: false,
          preview: '',
          pass: false,
          reasons: [`Exception: ${err instanceof Error ? err.message : String(err)}`],
        });
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log('| Fixture           | Endpoint | HTTP | OK | Reasons                              |');
  console.log('|-------------------|----------|------|----|--------------------------------------|');
  for (const r of results) {
    const tag = r.pass ? 'YES' : 'NO ';
    const reason = r.reasons.length === 0 ? '' : r.reasons[0].slice(0, 36);
    console.log(`| ${r.fixture.padEnd(17)} | ${r.endpoint.padEnd(8)} | ${String(r.status).padStart(4)} | ${tag} | ${reason.padEnd(36)} |`);
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\n=== Final: ${passed}/${total} passing ===\n`);

  // Write JSON output for the report.
  const summary = {
    base_url: BASE_URL,
    total,
    passed,
    failed: total - passed,
    results: results.map((r) => ({
      fixture: r.fixture,
      endpoint: r.endpoint,
      status: r.status,
      pass: r.pass,
      preview: r.preview,
      reasons: r.reasons,
      ms: r.ms,
    })),
  };
  const reportPath = join(process.cwd(), 'docs/wave2-edge-cases-output.json');
  await import('node:fs').then((fs) => fs.writeFileSync(reportPath, JSON.stringify(summary, null, 2)));
  console.log(`Report written to ${reportPath}`);

  if (passed < total) process.exit(1);
}

main().catch((err) => {
  console.error('UNEXPECTED ERROR:', err);
  process.exit(2);
});
