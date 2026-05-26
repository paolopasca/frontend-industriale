/**
 * Wave 15 — W15-03: tests for `buildPrintSchedule`, the pure data
 * function that feeds the `/print/$slug` route.
 *
 * The route itself is thin (read localStorage, render, auto-print);
 * the testable contract is:
 *   - operations grouped by machine
 *   - rows sorted by startMin ascending inside each machine section
 *   - operator id resolved to operator.name when available
 *   - on-time rate derived correctly from totalOrders / ordersOnTime
 *   - empty machines omitted from the printed sheet
 *   - dates formatted as Italian dd/MM HH:mm
 *
 * Anything else (Gantt chart, AI panels, KPI cards) is explicitly NOT
 * built by this layer — the route renders only what this function
 * produces, so a smoke test that the function only emits the expected
 * fields is enough to guarantee the print page stays minimal.
 */
import { describe, it, expect } from 'vitest';
import type { DashboardData, TimeConfig } from '@/data/resultAdapter';
import { buildPrintSchedule, formatPrintDateTime } from '../printSchedule';

const TC: TimeConfig = {
  company_start_hour: 6,
  company_end_hour: 22,
  day_length_min: 960,
  start_date: '2026-05-26',
  start_weekday: 1, // Tuesday
};

function makeData(): DashboardData {
  return {
    machines: [
      { id: 'M01', name: 'Pastorizzatore', shortName: 'Past.' },
      { id: 'M02', name: 'Caldaia', shortName: 'Cald.' },
      // M03 has no operations on purpose — must be filtered out.
      { id: 'M03', name: 'Filatrice', shortName: 'Fil.' },
    ],
    operators: [
      { id: 'OP01', name: 'Antonio Esposito', shift: 'Mattina', qualifiedMachines: ['M01', 'M02'] },
      { id: 'OP02', name: 'Giuseppe Ferrara', shift: 'Mattina', qualifiedMachines: ['M01'] },
    ],
    operations: [
      // Intentionally out-of-order to verify sorting.
      { id: 'OP-COM-001-2', orderId: 'COM-001', machineId: 'M01', operatorId: 'OP02',
        setupMinutes: 10, processingMinutes: 100, startMinute: 200, sequence: 2,
        description: 'OP-2', startDatetime: '2026-05-26 09:20', endDatetime: '2026-05-26 11:10' },
      { id: 'OP-COM-001-1', orderId: 'COM-001', machineId: 'M01', operatorId: 'OP01',
        setupMinutes: 5, processingMinutes: 50, startMinute: 0, sequence: 1,
        description: 'OP-1', startDatetime: '2026-05-26 06:00', endDatetime: '2026-05-26 06:55' },
      { id: 'OP-COM-002-3', orderId: 'COM-002', machineId: 'M01', operatorId: 'OP01',
        setupMinutes: 0, processingMinutes: 30, startMinute: 60, sequence: 3,
        description: 'OP-3', startDatetime: '2026-05-26 07:00', endDatetime: '2026-05-26 07:30' },
      { id: 'OP-COM-002-1', orderId: 'COM-002', machineId: 'M02', operatorId: 'OP02',
        setupMinutes: 15, processingMinutes: 75, startMinute: 0, sequence: 1,
        description: 'OP-1', startDatetime: '2026-05-26 06:00', endDatetime: '2026-05-26 07:30' },
      { id: 'OP-COM-001-3', orderId: 'COM-001', machineId: 'M02', operatorId: '',
        setupMinutes: 0, processingMinutes: 40, startMinute: 120, sequence: 3,
        description: 'OP-3', startDatetime: '2026-05-26 08:00', endDatetime: '2026-05-26 08:40' },
    ],
    orders: [
      { id: 'COM-001', product: 'X', quantity: 1, priority: 'alta', priorityWeight: 5,
        deadline: 'G2', deadlineMinute: 960, completionMinute: 850, status: 'in-tempo',
        operationCount: 3, client: '' },
      { id: 'COM-002', product: 'Y', quantity: 1, priority: 'media', priorityWeight: 2,
        deadline: 'G2', deadlineMinute: 960, completionMinute: 1100, status: 'in-ritardo',
        operationCount: 2, client: '' },
    ],
    maintenanceWindows: [],
    keyDecisions: [],
    kpis: {
      makespan: 5.5, makespanDays: 0.7,
      totalTardiness: 140, highPriorityOnTime: 100,
      peakUtilization: 80, avgUtilization: 60,
      totalOperations: 5, totalSetupTime: 30, totalProcessingTime: 295,
      ordersOnTime: 1, ordersLate: 1, totalOrders: 2,
      costoOperatori: 0, costoSetup: 0, costoTotale: 0,
    },
    narrative: '',
    method: 'deterministic-template',
    costUsd: 0,
    timeConfig: TC,
  };
}

describe('buildPrintSchedule — W15-03 print-only schedule', () => {
  it('groups operations by machine and emits one section per non-empty machine', () => {
    const sched = buildPrintSchedule(makeData(), 'Caseificio Pinco', new Date('2026-05-26T15:30:00'));
    expect(sched.sections.map(s => s.machineId)).toEqual(['M01', 'M02']);
    // M03 is dropped because no operations target it.
  });

  it('sorts rows inside each machine section by startMin ascending', () => {
    const sched = buildPrintSchedule(makeData(), 'Caseificio Pinco', new Date('2026-05-26T15:30:00'));
    const m01 = sched.sections.find(s => s.machineId === 'M01')!;
    expect(m01.rows.map(r => r.startMin)).toEqual([0, 60, 200]);
    // index column is 1-based after sorting.
    expect(m01.rows.map(r => r.index)).toEqual([1, 2, 3]);
  });

  it('resolves operator id to operator name when present and falls back to "—" when missing', () => {
    const sched = buildPrintSchedule(makeData(), 'Caseificio Pinco', new Date('2026-05-26T15:30:00'));
    const m01 = sched.sections.find(s => s.machineId === 'M01')!;
    expect(m01.rows[0].operatore).toBe('Antonio Esposito');
    expect(m01.rows[2].operatore).toBe('Giuseppe Ferrara');
    const m02 = sched.sections.find(s => s.machineId === 'M02')!;
    // Second op on M02 has operatorId='' — must show em-dash, not the empty string.
    expect(m02.rows[1].operatore).toBe('—');
  });

  it('formats start/end dates as dd/MM HH:mm using the backend ISO string when present', () => {
    const sched = buildPrintSchedule(makeData(), 'Caseificio Pinco', new Date('2026-05-26T15:30:00'));
    const m01 = sched.sections.find(s => s.machineId === 'M01')!;
    expect(m01.rows[0].startLabel).toBe('26/05 06:00');
    expect(m01.rows[0].endLabel).toBe('26/05 06:55');
    expect(m01.rows[2].startLabel).toBe('26/05 09:20');
  });

  it('builds a header with makespan hours, on-time rate %, total orders, generation timestamp', () => {
    const sched = buildPrintSchedule(makeData(), 'Caseificio Pinco', new Date('2026-05-26T15:30:00'));
    expect(sched.header.companyName).toBe('Caseificio Pinco');
    expect(sched.header.makespanHours).toBe(5.5);
    expect(sched.header.totalOrders).toBe(2);
    expect(sched.header.ordersOnTime).toBe(1);
    expect(sched.header.onTimeRatePct).toBe(50);
    expect(sched.header.generatedAt).toBe('26/05/2026 15:30');
  });

  it('falls back to "Azienda" when company name is missing or blank', () => {
    expect(buildPrintSchedule(makeData(), '', new Date()).header.companyName).toBe('Azienda');
    expect(buildPrintSchedule(makeData(), '   ', new Date()).header.companyName).toBe('Azienda');
  });

  it('does NOT include keyDecisions, narrative, costUsd, maintenance, or AI-panel fields on the output', () => {
    const sched = buildPrintSchedule(makeData(), 'Caseificio Pinco', new Date());
    // The print sheet is intentionally a flat (header, sections[]) structure
    // so the @media print layout cannot accidentally leak Gantt / AI surfaces.
    expect(Object.keys(sched).sort()).toEqual(['header', 'sections']);
    expect(Object.keys(sched.header).sort()).toEqual([
      'companyName', 'generatedAt', 'makespanHours', 'onTimeRatePct',
      'ordersOnTime', 'totalOrders',
    ].sort());
  });
});

describe('formatPrintDateTime — fallback paths', () => {
  it('falls back to TimeConfig + start_date when ISO string is missing', () => {
    // start_date 2026-05-26, day_length 960, hour 6 + minute 0 → 26/05 06:00
    expect(formatPrintDateTime(0, TC)).toBe('26/05 06:00');
    // 120 min into day 0 → hour 8
    expect(formatPrintDateTime(120, TC)).toBe('26/05 08:00');
    // 960 min = full day → day 1 at 06:00 → 27/05 06:00
    expect(formatPrintDateTime(960, TC)).toBe('27/05 06:00');
  });

  it('falls back to minute counter when no TimeConfig and no ISO are available', () => {
    expect(formatPrintDateTime(120)).toBe('min 120');
  });

  it('prefers the ISO string over TimeConfig when both are available', () => {
    expect(formatPrintDateTime(0, TC, '2026-06-15 10:30')).toBe('15/06 10:30');
  });
});
