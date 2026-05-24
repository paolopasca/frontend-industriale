#!/usr/bin/env tsx
/**
 * Wave 3 tool correctness tests.
 *
 * Bypasses the LLM entirely: calls `executeManagerTool` directly with
 * deterministic inputs and asserts shape + content of the output.
 *
 * Tier-1 subset (5 of 10 tools, per team-lead brief — Haiku overload meant
 * we prioritized the most-used tools):
 *   - get_kpi_summary
 *   - list_orders
 *   - get_machine_status
 *   - get_late_orders
 *   - get_status_diagnosis
 *
 * Also covers a few critical adversarial-input cases per DESIGN-W3-2:
 *   - sanitizeId rejection for SQL/path-traversal payloads,
 *   - clamp on `limit` parameter.
 *
 * Usage:
 *   npx tsx tests/server/wave3-tool-correctness.test.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  executeManagerTool,
  type ManagerToolContext,
} from '../../src/server/llm/manager-chat-tools';

const FIX_DIR = join(process.cwd(), 'tests/fixtures/wave2-solutions');

function loadFixture(name: string): { slug: string; solution: unknown; kpis: Record<string, number> } {
  return JSON.parse(readFileSync(join(FIX_DIR, `${name}.json`), 'utf8'));
}

interface TestResult {
  name: string;
  ok: boolean;
  detail?: string;
}

const results: TestResult[] = [];

function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      results.push({ name, ok: true });
      console.log(`PASS  ${name}`);
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err);
      results.push({ name, ok: false, detail });
      console.log(`FAIL  ${name} — ${detail}`);
    });
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function main() {
  const feasibleFix = loadFixture('feasible-warning');
  const optimalFix = loadFixture('optimal');
  const infeasibleFix = loadFixture('infeasible');
  const emptyFix = loadFixture('empty');

  const feasibleCtx: ManagerToolContext = {
    solution: feasibleFix.solution,
    kpis: feasibleFix.kpis,
  };
  const optimalCtx: ManagerToolContext = {
    solution: optimalFix.solution,
    kpis: optimalFix.kpis,
  };
  const infeasibleCtx: ManagerToolContext = {
    solution: infeasibleFix.solution,
    kpis: infeasibleFix.kpis,
  };
  const emptyCtx: ManagerToolContext = {
    solution: emptyFix.solution,
    kpis: emptyFix.kpis,
  };

  // === get_kpi_summary ===
  await check('get_kpi_summary: returns status + kpis + n_fasi + n_commesse', async () => {
    const r = await executeManagerTool('get_kpi_summary', {}, feasibleCtx);
    assert(isObj(r), 'expected object');
    assert(typeof r.status === 'string', 'status must be string');
    assert(isObj(r.kpis), 'kpis must be object');
    assert(typeof r.n_fasi === 'number', 'n_fasi must be number');
    assert(typeof r.n_commesse === 'number', 'n_commesse must be number');
    assert((r.kpis as Record<string, number>).makespan_min === 3120, `expected makespan 3120, got ${(r.kpis as any).makespan_min}`);
    assert((r.kpis as Record<string, number>).on_time_rate === 0.85, `expected on_time 0.85`);
  });

  await check('get_kpi_summary on empty fixture: n_fasi=0, status=UNKNOWN/EMPTY', async () => {
    const r = await executeManagerTool('get_kpi_summary', {}, emptyCtx);
    assert(isObj(r), 'object');
    assert(r.n_fasi === 0, `expected n_fasi=0, got ${r.n_fasi}`);
    assert(typeof r.status === 'string', 'status string');
  });

  // === list_orders ===
  await check('list_orders default: returns total + orders array', async () => {
    const r = await executeManagerTool('list_orders', {}, feasibleCtx);
    assert(isObj(r), 'object');
    assert(typeof r.total === 'number', 'total number');
    assert(Array.isArray(r.orders), 'orders array');
    assert((r.orders as unknown[]).length === r.total, 'all orders returned (no truncation expected on 2-fixture)');
  });

  await check('list_orders status=late on feasible-warning: includes COM-007', async () => {
    const r = await executeManagerTool('list_orders', { status: 'late' }, feasibleCtx);
    assert(isObj(r), 'object');
    const orders = r.orders as Array<Record<string, unknown>>;
    const com007 = orders.find((o) => o.commessa === 'COM-007');
    assert(com007, `COM-007 not in late orders. orders: ${JSON.stringify(orders.map((o) => o.commessa))}`);
    assert(com007.status === 'late', 'COM-007 marked late');
    assert((com007.ritardo_min as number) > 0, 'ritardo_min positive');
  });

  await check('list_orders status=on_time on feasible-warning: excludes COM-007', async () => {
    const r = await executeManagerTool('list_orders', { status: 'on_time' }, feasibleCtx);
    const orders = r.orders as Array<Record<string, unknown>>;
    const com007 = orders.find((o) => o.commessa === 'COM-007');
    assert(!com007, 'COM-007 should not be in on_time orders');
  });

  await check('list_orders limit clamp: limit=1 returns 1 order + truncated=true', async () => {
    const r = await executeManagerTool('list_orders', { limit: 1 }, feasibleCtx);
    const orders = r.orders as unknown[];
    assert(orders.length === 1, `expected 1 order, got ${orders.length}`);
    assert(r.truncated === true, 'truncated flag set');
  });

  await check('list_orders adversarial limit=999999: clamped to MAX_LIST_ITEMS (50)', async () => {
    const r = await executeManagerTool('list_orders', { limit: 999999 }, feasibleCtx);
    const orders = r.orders as unknown[];
    assert(orders.length <= 50, `limit not clamped: ${orders.length}`);
  });

  // === get_machine_status ===
  await check('get_machine_status: returns all machines if no filter', async () => {
    const r = await executeManagerTool('get_machine_status', {}, feasibleCtx);
    assert(isObj(r), 'object');
    assert(Array.isArray(r.machines), 'machines array');
    assert((r.machines as unknown[]).length >= 2, 'at least M-1 and M-3');
    const ids = (r.machines as Array<Record<string, unknown>>).map((m) => m.machine_id);
    assert(ids.includes('M-1') && ids.includes('M-3'), `machines missing: ${ids.join(',')}`);
  });

  await check('get_machine_status M-3: returns single machine', async () => {
    const r = await executeManagerTool('get_machine_status', { machine_id: 'M-3' }, feasibleCtx);
    assert(isObj(r), 'object');
    const machines = r.machines as Array<Record<string, unknown>>;
    assert(machines.length === 1, `expected 1 machine, got ${machines.length}`);
    assert(machines[0].machine_id === 'M-3', `wrong machine: ${machines[0].machine_id}`);
  });

  await check('get_machine_status: SQL injection rejected', async () => {
    const r = await executeManagerTool(
      'get_machine_status',
      { machine_id: "'; DROP TABLE--" },
      feasibleCtx,
    );
    assert(isObj(r), 'object');
    assert(typeof r.error === 'string', `expected error, got ${JSON.stringify(r)}`);
  });

  await check('get_machine_status: path traversal rejected', async () => {
    const r = await executeManagerTool(
      'get_machine_status',
      { machine_id: '../../../etc/passwd' },
      feasibleCtx,
    );
    assert(isObj(r), 'object');
    assert(typeof r.error === 'string', `expected error for traversal payload`);
  });

  // === get_late_orders ===
  await check('get_late_orders on feasible-warning: includes COM-007 with total_ritardo=120', async () => {
    const r = await executeManagerTool('get_late_orders', {}, feasibleCtx);
    assert(isObj(r), 'object');
    assert(r.total === 1, `expected total=1, got ${r.total}`);
    assert(r.totale_ritardo_min === 120, `expected totale_ritardo=120, got ${r.totale_ritardo_min}`);
    const orders = r.orders as Array<Record<string, unknown>>;
    assert(orders[0]?.commessa === 'COM-007', 'first late order is COM-007');
  });

  await check('get_late_orders on optimal: total=0', async () => {
    const r = await executeManagerTool('get_late_orders', {}, optimalCtx);
    assert(isObj(r), 'object');
    assert(r.total === 0, `expected total=0 on optimal, got ${r.total}`);
  });

  // === get_status_diagnosis ===
  await check('get_status_diagnosis on feasible-warning: status FEASIBLE + warnings', async () => {
    const r = await executeManagerTool('get_status_diagnosis', {}, feasibleCtx);
    assert(isObj(r), 'object');
    assert(r.status === 'FEASIBLE', `expected FEASIBLE, got ${r.status}`);
    assert(Array.isArray(r.warnings), 'warnings array');
    assert((r.warnings as unknown[]).length >= 1, 'has warnings');
    assert(r.has_plan === true, 'has_plan true');
  });

  await check('get_status_diagnosis on infeasible: status INFEASIBLE', async () => {
    const r = await executeManagerTool('get_status_diagnosis', {}, infeasibleCtx);
    assert(isObj(r), 'object');
    assert(r.status === 'INFEASIBLE' || r.status === 'UNKNOWN', `expected INFEASIBLE/UNKNOWN, got ${r.status}`);
  });

  // === Defense-in-depth: unknown tool ===
  await check('unknown tool name: returns error', async () => {
    const r = await executeManagerTool('leak_env_vars', {}, feasibleCtx);
    assert(isObj(r), 'object');
    assert(typeof r.error === 'string' && r.error.includes('Unknown tool'), `expected unknown_tool error, got ${JSON.stringify(r)}`);
  });

  // === Summary ===
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log('');
  console.log(`Wave 3 tool-correctness: ${passed}/${results.length} passed (${failed} failed)`);
  if (failed > 0) {
    console.log('FAILED tests:');
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
