/**
 * Wave 15 — W15-03: pure data layer for the print-only "production plan"
 * route at `/print/$slug`.
 *
 * The dashboard uses the rich `DashboardData` envelope produced by
 * `src/data/resultAdapter.ts`. The print layout only needs:
 *   - a header with company name + makespan + on-time rate
 *   - one section per machine with operations ordered by `startMinute`
 *
 * `buildPrintSchedule` is the pure function the route consumes and the
 * test asserts on. It groups operations by machine, sorts each group
 * ascending by `startMinute`, and resolves operator id → operator name
 * when the operator is present in the dashboard data.
 *
 * `formatPrintDateTime` produces the Italian `dd/MM HH:mm` string the
 * manager expects on the printed sheet. It prefers the wall-clock ISO
 * string already produced by the backend (`startDatetime` / `endDatetime`
 * fields on each operation) and falls back to `start_min + time_config`
 * when the ISO is missing (legacy llm-only path or unit-test fixtures
 * without a `time_config`).
 */
import type { DashboardData } from '@/data/resultAdapter';
import type { TimeConfig } from '@/data/resultAdapter';

export interface PrintRow {
  index: number;
  ordine: string;
  operatore: string;
  setupMinutes: number;
  processingMinutes: number;
  startMin: number;
  endMin: number;
  startLabel: string;
  endLabel: string;
}

export interface PrintMachineSection {
  machineId: string;
  machineName: string;
  rows: PrintRow[];
}

export interface PrintScheduleHeader {
  companyName: string;
  generatedAt: string;          // "dd/MM/yyyy HH:mm"
  makespanHours: number;        // hours, one decimal
  onTimeRatePct: number;        // 0..100, integer
  totalOrders: number;
  ordersOnTime: number;
}

export interface PrintSchedule {
  header: PrintScheduleHeader;
  sections: PrintMachineSection[];
}

const WEEKDAY_IT = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

/**
 * Italian-locale wall-clock formatter for the print sheet. Prefer the
 * backend-emitted ISO string when available, fall back to model minutes
 * + TimeConfig, last-resort dump the raw minute number.
 */
export function formatPrintDateTime(
  minutes: number,
  tc?: TimeConfig,
  isoDatetime?: string,
): string {
  if (isoDatetime) {
    // backend format is "YYYY-MM-DD HH:MM" → "dd/MM HH:mm"
    const m = isoDatetime.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (m) {
      const [, , mo, dd, hh, mm] = m;
      return `${dd}/${mo} ${hh}:${mm}`;
    }
  }
  if (tc) {
    const dayIdx = Math.floor(minutes / tc.day_length_min);
    const minInDay = minutes % tc.day_length_min;
    const hour = tc.company_start_hour + Math.floor(minInDay / 60);
    const mm = minInDay % 60;
    // Try to derive a real date from tc.start_date when valid;
    // fall back to weekday + offset day.
    const baseDate = parseStartDate(tc.start_date);
    if (baseDate) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + dayIdx);
      const dd = String(d.getDate()).padStart(2, '0');
      const mo = String(d.getMonth() + 1).padStart(2, '0');
      return `${dd}/${mo} ${String(hour).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
    const wd = WEEKDAY_IT[(tc.start_weekday + dayIdx) % 7];
    return `g${dayIdx} ${wd} ${String(hour).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }
  // No time config and no ISO — best effort: minute counter.
  return `min ${minutes}`;
}

function parseStartDate(s: string | undefined): Date | null {
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  // Construct in local time, avoiding the UTC-shift JS does for ISO strings.
  return new Date(Number(y), Number(mo) - 1, Number(d));
}

/**
 * Italian dd/MM/yyyy HH:mm for the print header.
 */
function formatGeneratedAt(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mo}/${yyyy} ${hh}:${mm}`;
}

/**
 * Group operations by machine, sort each group by startMinute ascending,
 * and resolve operator names from the dashboard's operator list. The
 * input is the `DashboardData` envelope adapted from the backend response
 * by `src/data/resultAdapter.ts`.
 *
 * Machines with no operations are omitted from the printed sheet so the
 * manager doesn't get blank pages for unused resources.
 */
export function buildPrintSchedule(
  data: DashboardData,
  companyName: string,
  now: Date = new Date(),
): PrintSchedule {
  const operatorById = new Map<string, string>();
  for (const op of data.operators) {
    operatorById.set(op.id, op.name && op.name.trim().length > 0 ? op.name : op.id);
  }

  const sections: PrintMachineSection[] = [];
  for (const machine of data.machines) {
    const machineOps = data.operations
      .filter(o => o.machineId === machine.id)
      .sort((a, b) => a.startMinute - b.startMinute);
    if (machineOps.length === 0) continue;

    const rows: PrintRow[] = machineOps.map((op, i) => {
      const endMin = op.startMinute + op.setupMinutes + op.processingMinutes;
      const operatorLabel = op.operatorId && op.operatorId.trim().length > 0
        ? (operatorById.get(op.operatorId) ?? op.operatorId)
        : '—';
      return {
        index: i + 1,
        ordine: op.orderId,
        operatore: operatorLabel,
        setupMinutes: op.setupMinutes,
        processingMinutes: op.processingMinutes,
        startMin: op.startMinute,
        endMin,
        startLabel: formatPrintDateTime(op.startMinute, data.timeConfig, op.startDatetime),
        endLabel: formatPrintDateTime(endMin, data.timeConfig, op.endDatetime),
      };
    });

    sections.push({
      machineId: machine.id,
      machineName: machine.name && machine.name.trim().length > 0 ? machine.name : machine.id,
      rows,
    });
  }

  const totalOrders = data.kpis.totalOrders;
  const ordersOnTime = data.kpis.ordersOnTime;
  const onTimeRatePct = totalOrders > 0
    ? Math.round((ordersOnTime / totalOrders) * 100)
    : 0;

  return {
    header: {
      companyName: companyName && companyName.trim().length > 0 ? companyName : 'Azienda',
      generatedAt: formatGeneratedAt(now),
      makespanHours: Math.round(data.kpis.makespan * 10) / 10,
      onTimeRatePct,
      totalOrders,
      ordersOnTime,
    },
    sections,
  };
}

/**
 * localStorage key the dashboard uses to hand off the snapshot to the
 * print route. The shape persisted is `{ data: DashboardData, companyName: string }`.
 * Slug-scoped via `src/lib/storage.ts`.
 */
export const PRINT_SNAPSHOT_KEY = 'print_snapshot';
