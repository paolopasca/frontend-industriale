#!/usr/bin/env tsx
/**
 * Wave 7 — backend-only integration smoke (no LLM, no BFF).
 *
 * Bypasses /api/apply-whatif and Haiku intent parser. Hits the backend
 * directly with hand-crafted `rules.unavailable_machines` to verify the
 * solver actually honours the constraint when given a clean payload.
 *
 * Useful when:
 *   - Anthropic API credit is exhausted (no LLM path possible)
 *   - You want to isolate whether failures are in the BFF/parser layer
 *     vs. the backend rule consumer (`f_apply_rules.py`)
 *
 * Output: scripts/wave7-integration-smoke-results.json.
 */
import { writeFileSync } from 'node:fs';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8001';
const SLUG = 'demo-commesse';
const CYCLES = Number(process.env.SMOKE_CYCLES ?? '10');

const MACHINES = ['M01', 'M02', 'M03', 'M04', 'M05'];

interface CycleResult {
  idx: number;
  machine: string;
  window_start_min: number;
  window_end_min: number;
  day_label: string;
  status: string;
  latency_ms: number;
  phases_total: number;
  target_machine_total: number;
  target_machine_in_window: number;
  respected: boolean | null; // null = INFEASIBLE or empty
  sample_violations: Array<{ commessa: string; operazione: string; start_min: number; end_min: number }>;
  wave7?: unknown;
}

function pickScenario(idx: number): { machine: string; start_min: number; end_min: number; day_label: string } {
  const machine = MACHINES[idx % MACHINES.length];
  // Catalog convention: gg1 = 0-1440, gg2 = 1440-2880, gg3 = 2880-4320.
  const day = (idx % 3) + 1;
  const hour = 8 + (idx % 8); // 8..15
  const span = 3 + (idx % 4); // 3..6
  const start_min = (day - 1) * 1440 + hour * 60;
  const end_min = start_min + span * 60;
  return { machine, start_min, end_min, day_label: `gg${day}` };
}

interface FjspFase { operazione?: string; macchina?: string; start_min?: number; end_min?: number; }
interface FjspSol { [commessa: string]: { fasi?: FjspFase[] }; }

function verifyConstraint(
  solution: FjspSol,
  machine: string,
  windowStart: number,
  windowEnd: number,
): { respected: boolean | null; phases_total: number; target_machine_total: number; target_machine_in_window: number; sample_violations: CycleResult['sample_violations'] } {
  if (!solution || typeof solution !== 'object') {
    return { respected: null, phases_total: 0, target_machine_total: 0, target_machine_in_window: 0, sample_violations: [] };
  }
  let phases_total = 0;
  let target_total = 0;
  let in_window = 0;
  const violations: CycleResult['sample_violations'] = [];
  for (const [commessa, job] of Object.entries(solution)) {
    for (const fase of job?.fasi ?? []) {
      phases_total++;
      if (fase.macchina !== machine) continue;
      target_total++;
      const s = Number(fase.start_min ?? -1);
      const e = Number(fase.end_min ?? -1);
      // Overlap test: [s, e) intersects [windowStart, windowEnd) iff s < windowEnd && e > windowStart
      if (s < windowEnd && e > windowStart && s >= 0 && e >= 0) {
        in_window++;
        if (violations.length < 3) violations.push({ commessa, operazione: fase.operazione ?? '?', start_min: s, end_min: e });
      }
    }
  }
  if (phases_total === 0) {
    return { respected: null, phases_total, target_machine_total: target_total, target_machine_in_window: in_window, sample_violations: violations };
  }
  return { respected: in_window === 0, phases_total, target_machine_total: target_total, target_machine_in_window: in_window, sample_violations: violations };
}

async function probeBackend(machine: string, start_min: number, end_min: number): Promise<{ status: string; latency_ms: number; solution: FjspSol; wave7?: unknown }> {
  const t0 = Date.now();
  const res = await fetch(`${BACKEND_URL}/api/public/solve-template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug: SLUG,
      problem_type: 'fjsp',
      force_cold_start: true,
      rules: { unavailable_machines: { [machine]: [{ start_min, end_min }] } },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  const elapsed = Date.now() - t0;
  if (!res.ok) {
    return { status: `HTTP_${res.status}`, latency_ms: elapsed, solution: {} };
  }
  const j = await res.json() as Record<string, unknown>;
  return {
    status: String(j.status ?? 'unknown'),
    latency_ms: elapsed,
    solution: (j.solution ?? {}) as FjspSol,
    wave7: j.wave7,
  };
}

async function main(): Promise<void> {
  console.log(`Wave 7 backend-only smoke — ${CYCLES} cycles direct to ${BACKEND_URL}\n`);
  console.log('idx | machine | window               | status     | resp.');
  console.log('-----------------------------------------------------------');
  const cycles: CycleResult[] = [];
  for (let i = 0; i < CYCLES; i++) {
    const { machine, start_min, end_min, day_label } = pickScenario(i);
    const probe = await probeBackend(machine, start_min, end_min);
    const verdict = verifyConstraint(probe.solution, machine, start_min, end_min);
    const respStr = verdict.respected === null ? '-' : verdict.respected ? 'YES' : 'NO ';
    const winStr = `${String(start_min).padStart(5, ' ')}-${String(end_min).padEnd(5, ' ')}`;
    const dayStr = `(${day_label})`;
    console.log(`${String(i).padStart(3, ' ')} | ${machine}     | ${winStr} ${dayStr.padEnd(5, ' ')} | ${probe.status.padEnd(10, ' ')} | ${respStr}`);
    cycles.push({
      idx: i,
      machine,
      window_start_min: start_min,
      window_end_min: end_min,
      day_label,
      status: probe.status,
      latency_ms: probe.latency_ms,
      ...verdict,
      wave7: probe.wave7,
    });
  }
  console.log('\n=== Summary ===');
  const ok = cycles.filter((c) => c.status === 'FEASIBLE' || c.status === 'OPTIMAL');
  const respected = cycles.filter((c) => c.respected === true).length;
  const violated = cycles.filter((c) => c.respected === false).length;
  const unverifiable = cycles.filter((c) => c.respected === null).length;
  console.log(`Respected:    ${respected}/${cycles.length} (${((respected / cycles.length) * 100).toFixed(0)}%)  → of FEASIBLE: ${respected}/${ok.length} (${ok.length ? ((respected / ok.length) * 100).toFixed(0) : '0'}%)`);
  console.log(`Violated:     ${violated}/${cycles.length}`);
  console.log(`Unverifiable: ${unverifiable}/${cycles.length}`);
  writeFileSync('scripts/wave7-integration-smoke-results.json', JSON.stringify({ cycles, summary: { respected, violated, unverifiable, ok_count: ok.length } }, null, 2));
  console.log('\nFull cycle records: scripts/wave7-integration-smoke-results.json');
}

main().catch((err) => {
  console.error('Smoke failed:', err);
  process.exit(1);
});
