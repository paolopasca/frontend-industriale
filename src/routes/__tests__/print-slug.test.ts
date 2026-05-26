/**
 * Wave 15 — W15-03: contract tests for the `/print/$slug` route.
 *
 * The route module itself is presentational JSX that depends on a browser
 * `window.print()` + `localStorage`; without a DOM test runner there's
 * nothing meaningful to "render". The asserts here pin the contract
 * between the route and its data layer (`src/lib/printSchedule.ts`):
 *
 *  (a) buildPrintSchedule groups operations by machine and emits one
 *      section per non-empty machine — that's the per-machine header
 *      the route renders as `<h2 class="machine-title">`.
 *  (b) Rows inside each machine section are sorted by startMin ascending
 *      — i.e. the printed table is in chronological order.
 *  (c) The schedule envelope ONLY exposes {header, sections}. Anything
 *      Gantt-/AI-/KeyDecision-shaped is excluded. The route iterates
 *      `sched.sections` so it cannot accidentally render those surfaces.
 *
 * Full unit coverage of buildPrintSchedule lives in
 * `src/lib/__tests__/printSchedule.test.ts`; this file is the route-level
 * smoke test the W15-03 spec asked for.
 *
 * NOTE: extension is `.ts` (not `.tsx`) on purpose — without
 * `@testing-library/react` + a DOM environment the route's JSX cannot be
 * mounted in vitest. The contract assertions on the data shape are
 * sufficient because the route is a 1:1 mapping over the PrintSchedule
 * output.
 */
import { describe, it, expect } from 'vitest';
import { buildPrintSchedule, PRINT_SNAPSHOT_KEY } from '@/lib/printSchedule';
import type { DashboardData, TimeConfig } from '@/data/resultAdapter';

const TC: TimeConfig = {
  company_start_hour: 6,
  company_end_hour: 22,
  day_length_min: 960,
  start_date: '2026-05-26',
  start_weekday: 1,
};

// 2 machines × 3 phases each, exactly as the spec describes.
function mockData(): DashboardData {
  return {
    machines: [
      { id: 'M01', name: 'Pastorizzatore', shortName: 'Past.' },
      { id: 'M02', name: 'Caldaia', shortName: 'Cald.' },
    ],
    operators: [
      { id: 'OP01', name: 'Mario Rossi', shift: 'Mattina', qualifiedMachines: ['M01', 'M02'] },
      { id: 'OP02', name: 'Anna Bianchi', shift: 'Mattina', qualifiedMachines: ['M01'] },
    ],
    operations: [
      // M01 phases (out of order on purpose)
      { id: 'OP-A2', orderId: 'COM-001', machineId: 'M01', operatorId: 'OP01',
        setupMinutes: 10, processingMinutes: 60, startMinute: 120, sequence: 2,
        description: 'Fase 2', startDatetime: '2026-05-26 08:00', endDatetime: '2026-05-26 09:10' },
      { id: 'OP-A1', orderId: 'COM-001', machineId: 'M01', operatorId: 'OP02',
        setupMinutes: 5, processingMinutes: 30, startMinute: 0, sequence: 1,
        description: 'Fase 1', startDatetime: '2026-05-26 06:00', endDatetime: '2026-05-26 06:35' },
      { id: 'OP-A3', orderId: 'COM-002', machineId: 'M01', operatorId: 'OP01',
        setupMinutes: 0, processingMinutes: 40, startMinute: 60, sequence: 3,
        description: 'Fase 3', startDatetime: '2026-05-26 07:00', endDatetime: '2026-05-26 07:40' },
      // M02 phases (also out of order)
      { id: 'OP-B3', orderId: 'COM-002', machineId: 'M02', operatorId: 'OP01',
        setupMinutes: 5, processingMinutes: 50, startMinute: 200, sequence: 3,
        description: 'Fase 3', startDatetime: '2026-05-26 09:20', endDatetime: '2026-05-26 10:15' },
      { id: 'OP-B1', orderId: 'COM-001', machineId: 'M02', operatorId: 'OP01',
        setupMinutes: 0, processingMinutes: 90, startMinute: 0, sequence: 1,
        description: 'Fase 1', startDatetime: '2026-05-26 06:00', endDatetime: '2026-05-26 07:30' },
      { id: 'OP-B2', orderId: 'COM-002', machineId: 'M02', operatorId: 'OP02',
        setupMinutes: 15, processingMinutes: 45, startMinute: 100, sequence: 2,
        description: 'Fase 2', startDatetime: '2026-05-26 07:40', endDatetime: '2026-05-26 08:40' },
    ],
    orders: [
      { id: 'COM-001', product: 'X', quantity: 1, priority: 'alta', priorityWeight: 5,
        deadline: 'G1', deadlineMinute: 480, completionMinute: 460, status: 'in-tempo',
        operationCount: 3, client: '' },
      { id: 'COM-002', product: 'Y', quantity: 1, priority: 'media', priorityWeight: 2,
        deadline: 'G2', deadlineMinute: 960, completionMinute: 950, status: 'in-tempo',
        operationCount: 3, client: '' },
    ],
    maintenanceWindows: [],
    keyDecisions: [
      // present in the dashboard envelope but MUST NOT leak into the print sheet.
      { title: 'X', description: 'Y', impact: 'Z', icon: 'priority' },
    ],
    kpis: {
      makespan: 4.2, makespanDays: 0.5, totalTardiness: 0,
      highPriorityOnTime: 100, peakUtilization: 80, avgUtilization: 60,
      totalOperations: 6, totalSetupTime: 35, totalProcessingTime: 315,
      ordersOnTime: 2, ordersLate: 0, totalOrders: 2,
      costoOperatori: 100, costoSetup: 30, costoTotale: 130,
    },
    narrative: 'AI explanation — must not appear in the print sheet',
    method: 'deterministic-template',
    costUsd: 0.05,
    timeConfig: TC,
  };
}

describe('/print/$slug route contract — W15-03', () => {
  it('(a) emits one section per machine (machine headers will be rendered)', () => {
    const sched = buildPrintSchedule(mockData(), 'Caseificio Test', new Date('2026-05-26T10:00:00'));
    expect(sched.sections).toHaveLength(2);
    expect(sched.sections.map(s => s.machineId)).toEqual(['M01', 'M02']);
    expect(sched.sections.map(s => s.machineName)).toEqual(['Pastorizzatore', 'Caldaia']);
  });

  it('(b) rows inside each machine section are sorted by start_min ascending', () => {
    const sched = buildPrintSchedule(mockData(), 'Caseificio Test', new Date('2026-05-26T10:00:00'));
    for (const section of sched.sections) {
      const starts = section.rows.map(r => r.startMin);
      const sorted = [...starts].sort((a, b) => a - b);
      expect(starts).toEqual(sorted);
    }
    // Spot-check the exact ordering for both machines.
    expect(sched.sections[0].rows.map(r => r.startMin)).toEqual([0, 60, 120]);
    expect(sched.sections[1].rows.map(r => r.startMin)).toEqual([0, 100, 200]);
  });

  it('(c) the print schedule envelope does NOT carry Gantt / AI panel / KeyDecision data', () => {
    const sched = buildPrintSchedule(mockData(), 'Caseificio Test', new Date('2026-05-26T10:00:00'));
    // The route iterates `sched.sections` to render the tables; anything
    // not on this envelope is structurally impossible to render.
    expect(Object.keys(sched).sort()).toEqual(['header', 'sections']);
    // Sanity: source DashboardData *did* carry the noisy surfaces.
    const src = mockData();
    expect(src.keyDecisions.length).toBeGreaterThan(0);
    expect(src.narrative.length).toBeGreaterThan(0);
    expect(src.costUsd).toBeGreaterThan(0);
    // …but none of them leaked into the print schedule.
    const serialized = JSON.stringify(sched);
    expect(serialized).not.toMatch(/AI explanation/);
    expect(serialized).not.toMatch(/keyDecisions/);
    expect(serialized).not.toMatch(/narrative/);
    expect(serialized).not.toMatch(/costUsd/);
    expect(serialized).not.toMatch(/Gantt/i);
  });

  it('exposes the storage handoff key used by DashboardHeader.handleExportPdf', () => {
    // Pin the contract: the dashboard button writes under this key, the
    // print route reads from it. Changing this would silently break
    // "Esporta PDF" without any test failure.
    expect(PRINT_SNAPSHOT_KEY).toBe('print_snapshot');
  });
});
