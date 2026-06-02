/**
 * Transforms backend solver results into the dashboard data format.
 * Supports all 3 solver methods: llm-only, codegen-pipeline, deterministic-json.
 */
import type { Machine, Operator, Operation, Order, MaintenanceWindow, KeyDecision, Priority, OrderStatus, Shift } from './mockData';
import { JOB_COLORS } from './mockData';

// Backend "model time" anchor — operations carry start_min relative to
// company opening (06:00 in the demo). day_length_min is 960 (16h),
// not 1440. The adapter forwards this so the UI can convert correctly.
export interface TimeConfig {
  company_start_hour: number;
  company_end_hour: number;
  day_length_min: number;
  start_date: string;        // "YYYY-MM-DD" — schedule day 0
  start_weekday: number;     // 0=Mon … 6=Sun
  machine_windows?: Record<string, { start: number; end: number }>;
}

export interface DashboardData {
  machines: Machine[];
  operators: Operator[];
  operations: Operation[];
  orders: Order[];
  maintenanceWindows: MaintenanceWindow[];
  keyDecisions: KeyDecision[];
  kpis: {
    makespan: number;
    makespanDays: number;
    totalTardiness: number;
    highPriorityOnTime: number;
    peakUtilization: number;
    avgUtilization: number;
    totalOperations: number;
    totalSetupTime: number;
    totalProcessingTime: number;
    ordersOnTime: number;
    ordersLate: number;
    totalOrders: number;
    // Cost KPIs in € — populated from the FJSP solver objective
    // (costo_totale_operatori / costo_totale_setup). 0 when the solver
    // path doesn't expose them (legacy llm-only).
    costoOperatori: number;
    costoSetup: number;
    costoTotale: number;
  };
  narrative: string;
  method: string;
  costUsd: number;
  timeConfig?: TimeConfig;
}

// Backend encodes priority as int (1=bassa, 2=media, 5=alta) per
// _PRIORITY_MAP in daino/data_normalizer.py. Some legacy paths still
// emit strings — accept both.
function normalizePriority(raw: unknown): Priority {
  if (typeof raw === 'string') {
    const s = raw.toLowerCase();
    if (s === 'alta' || s === 'high' || s === 'urgente') return 'alta';
    if (s === 'bassa' || s === 'low') return 'bassa';
    return 'media';
  }
  if (typeof raw === 'number') {
    if (raw >= 4) return 'alta';
    if (raw <= 1) return 'bassa';
    return 'media';
  }
  return 'media';
}

const WEEKDAY_IT = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

// Convert solver "model minutes" into a real wall-clock string using the
// time_config the backend emits. Falls back to a minute counter when no
// config is available (mock data path).
export function formatModelMinute(min: number, tc?: TimeConfig): string {
  if (!tc) {
    const h = Math.floor(min / 60);
    return `min ${min} (~${h}h)`;
  }
  const dayIdx = Math.floor(min / tc.day_length_min);
  const minInDay = min % tc.day_length_min;
  const hour = tc.company_start_hour + Math.floor(minInDay / 60);
  const mm = minInDay % 60;
  const wd = WEEKDAY_IT[(tc.start_weekday + dayIdx) % 7];
  return `g${dayIdx} ${wd} ${String(hour).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// Wave 16.8 — convert a makespan in HOURS to WORKING DAYS using the company's
// REAL working-day length (time_config.day_length_min). Scalable to ANY plant
// (8h, 10h, 16h, 24h…): NO hardcoded day length. The old `/8` assumed an 8h day
// and doubled the count on a 16h plant (KPI 7.5gg vs Gantt ~4gg). The Gantt
// already uses day_length_min, so this keeps the makespan KPI consistent with it.
// Falls back to 8h only when time_config is absent (mock / LLM-only path).
export function makespanToWorkingDays(makespanHours: number, tc?: TimeConfig): number {
  const hoursPerDay = tc && tc.day_length_min > 0 ? tc.day_length_min / 60 : 8;
  return Math.round((makespanHours / hoursPerDay) * 10) / 10;
}

// ── FJSP Template result (apex-toy, demo-commesse) ──────────────────

function adaptFJSP(raw: Record<string, unknown>): DashboardData {
  const solution = (raw.solution ?? {}) as Record<string, { fasi: Array<{
    operazione: string; macchina: string; operatore: string;
    start_min: number; end_min: number; processing_min: number;
    setup_min: number; costo_operatore?: number; costo_setup?: number;
    start_datetime?: string; end_datetime?: string;
  }>; ritardo_min?: number; completamento_min?: number; scadenza_min?: number;
       priorita?: string | number }>;
  const rawKpis = (raw.kpis ?? {}) as Record<string, number>;
  const timeConfig = (raw.time_config as TimeConfig | undefined) ?? undefined;
  const maintenance = (raw.maintenance as Record<string, number[]> | undefined) ?? undefined;
  const operatorConfig = (raw.operator_config as Array<{
    operatore_id: string; turno?: string; macchine?: string[];
  }> | undefined) ?? undefined;

  // Extract unique machines and operators
  const machineSet = new Map<string, Machine>();
  const operatorSet = new Map<string, Operator>();
  const allOps: Operation[] = [];
  const orders: Order[] = [];
  let opCounter = 0;

  for (const [jobId, job] of Object.entries(solution)) {
    const fasi = job.fasi ?? [];
    const lastFase = fasi[fasi.length - 1];
    const completionMin = lastFase?.end_min ?? 0;
    const deadlineMin = job.scadenza_min ?? 999999;
    const ritardo = job.ritardo_min ?? Math.max(0, completionMin - deadlineMin);
    const priorita = normalizePriority(job.priorita);

    orders.push({
      id: jobId,
      product: jobId,
      quantity: 1,
      priority: priorita,
      priorityWeight: priorita === 'alta' ? 5 : priorita === 'media' ? 2 : 1,
      deadline: deadlineMin < 999999 ? formatModelMinute(deadlineMin, timeConfig) : 'N/A',
      deadlineMinute: deadlineMin,
      completionMinute: completionMin,
      status: (ritardo > 0 ? 'in-ritardo' : 'in-tempo') as OrderStatus,
      operationCount: fasi.length,
      client: '',
    });

    fasi.forEach((fase, seq) => {
      opCounter++;
      const opId = `OP-${jobId}-${seq + 1}`;
      const mid = fase.macchina;
      const wid = fase.operatore;

      if (!machineSet.has(mid)) {
        machineSet.set(mid, { id: mid, name: mid, shortName: mid });
      }
      if (wid && wid !== 'NONE' && !operatorSet.has(wid)) {
        operatorSet.set(wid, {
          id: wid,
          name: wid,
          shift: 'Mattina' as Shift,
          qualifiedMachines: [],
        });
      }

      // Track qualified machines per operator
      if (wid && wid !== 'NONE') {
        const op = operatorSet.get(wid)!;
        if (!op.qualifiedMachines.includes(mid)) {
          op.qualifiedMachines.push(mid);
        }
      }

      allOps.push({
        id: opId,
        orderId: jobId,
        machineId: mid,
        operatorId: wid === 'NONE' ? '' : wid,
        setupMinutes: fase.setup_min ?? 0,
        processingMinutes: fase.processing_min ?? (fase.end_min - fase.start_min),
        startMinute: fase.start_min,
        sequence: seq + 1,
        description: fase.operazione,
        startDatetime: fase.start_datetime,
        endDatetime: fase.end_datetime,
      });
    });
  }

  // Hydrate operator shifts + qualifications from the backend's
  // operator_config when available. Without this every operator was
  // displayed with a hard-coded "Mattina" shift, which contradicted the
  // schedule for any "pomeriggio" worker (OP-03/05/07 in the demo).
  if (operatorConfig) {
    for (const oc of operatorConfig) {
      const op = operatorSet.get(oc.operatore_id);
      if (!op) continue;
      const turno = (oc.turno ?? '').toLowerCase();
      op.shift = turno.startsWith('pom') ? 'Pomeriggio' : 'Mattina';
      if (Array.isArray(oc.macchine)) op.qualifiedMachines = [...oc.macchine];
    }
  }

  // Maintenance windows: backend gives us {macchina_id: [weekday_int]}
  // (0=Mon … 6=Sun). Materialise one MaintenanceWindow per occurrence in
  // the planning horizon so MachineGantt can shade the down-days.
  const maintenanceWindows: MaintenanceWindow[] = [];
  if (maintenance && timeConfig) {
    const horizonDays = Math.ceil(
      (allOps.reduce((m, o) => Math.max(m, o.startMinute + o.setupMinutes + o.processingMinutes), 0)
        + timeConfig.day_length_min) / timeConfig.day_length_min,
    );
    for (const [machineId, weekdays] of Object.entries(maintenance)) {
      for (let day = 0; day < horizonDays; day++) {
        const wd = (timeConfig.start_weekday + day) % 7;
        if (weekdays.includes(wd)) {
          maintenanceWindows.push({
            machineId,
            startMinute: day * timeConfig.day_length_min,
            durationMinutes: timeConfig.day_length_min,
            description: `Manutenzione ${WEEKDAY_IT[wd]}`,
          });
        }
      }
    }
  }

  const machines = Array.from(machineSet.values());
  const operators = Array.from(operatorSet.values());
  const totalSetup = allOps.reduce((s, o) => s + o.setupMinutes, 0);
  const totalProc = allOps.reduce((s, o) => s + o.processingMinutes, 0);
  const maxEnd = allOps.reduce((m, o) => Math.max(m, o.startMinute + o.setupMinutes + o.processingMinutes), 0);
  const makespan = maxEnd / 60;
  const ordersLate = orders.filter(o => o.status === 'in-ritardo').length;

  // Machine utilization
  const machineUtils = machines.map(m => {
    const ops = allOps.filter(o => o.machineId === m.id);
    const busy = ops.reduce((s, o) => s + o.setupMinutes + o.processingMinutes, 0);
    return maxEnd > 0 ? (busy / maxEnd) * 100 : 0;
  });
  const peakUtil = Math.max(...machineUtils, 0);
  const avgUtil = machineUtils.length > 0 ? machineUtils.reduce((a, b) => a + b, 0) / machineUtils.length : 0;

  // highPriorityOnTime: when no high-priority orders exist, "100%" is
  // misleading (looks like a deliberate score). Surface NaN→0 with the
  // expected denominator semantics; UI shows "—" or "0/0" for empty set.
  const altaOrders = orders.filter(o => o.priority === 'alta');
  const highPriorityOnTime = altaOrders.length === 0
    ? 0
    : (altaOrders.filter(o => o.status === 'in-tempo').length / altaOrders.length) * 100;

  return {
    machines,
    operators,
    operations: allOps,
    orders,
    maintenanceWindows,
    keyDecisions: [],
    kpis: {
      makespan: Math.round(makespan * 10) / 10,
      makespanDays: makespanToWorkingDays(makespan, timeConfig),
      totalTardiness: rawKpis.tardiness_totale_min ?? rawKpis.total_tardiness ?? orders.reduce((s, o) => s + Math.max(0, o.completionMinute - o.deadlineMinute), 0),
      highPriorityOnTime,
      peakUtilization: Math.round(peakUtil * 10) / 10,
      avgUtilization: Math.round(avgUtil * 10) / 10,
      totalOperations: allOps.length,
      totalSetupTime: totalSetup,
      totalProcessingTime: totalProc,
      ordersOnTime: orders.length - ordersLate,
      ordersLate,
      totalOrders: orders.length,
      costoOperatori: rawKpis.costo_totale_operatori ?? 0,
      costoSetup: rawKpis.costo_totale_setup ?? 0,
      costoTotale: (rawKpis.costo_totale_operatori ?? 0) + (rawKpis.costo_totale_setup ?? 0),
    },
    narrative: '',
    method: 'deterministic-template',
    costUsd: (raw.cost_usd as number) ?? 0,
    timeConfig,
  };
}

// ── LLM-only result ─────────────────────────────────────────────────

function adaptLLMOnly(raw: Record<string, unknown>): DashboardData {
  const result = (raw.result ?? raw) as Record<string, unknown>;
  const piano = (result.piano ?? []) as Array<{
    commessa: string; operazione: string; macchina: string; operatore: string;
    inizio: string; fine: string; setup_min: number; lavorazione_min: number;
  }>;
  const rawKpis = (result.kpi ?? {}) as Record<string, number>;
  const narrative = (result.narrative ?? '') as string;
  // Wave 16.8 — real working-day length for the scalable makespan→days KPI
  // (absent on most LLM-only plans → helper falls back to 8h).
  const timeConfig = ((result.time_config ?? raw.time_config) as TimeConfig | undefined) ?? undefined;

  const machineSet = new Map<string, Machine>();
  const operatorSet = new Map<string, Operator>();
  const allOps: Operation[] = [];
  const orderMap = new Map<string, { ops: typeof piano; maxEnd: number }>();

  // Group by commessa
  piano.forEach(p => {
    if (!orderMap.has(p.commessa)) {
      orderMap.set(p.commessa, { ops: [], maxEnd: 0 });
    }
    orderMap.get(p.commessa)!.ops.push(p);
  });

  // Crude time parser: "YYYY-MM-DD HH:MM" → minutes from epoch of first entry
  let baseTime = 0;
  const parseMinutes = (s: string): number => {
    try {
      const d = new Date(s);
      if (!baseTime) baseTime = d.getTime();
      return Math.round((d.getTime() - baseTime) / 60000);
    } catch {
      return 0;
    }
  };

  let opCounter = 0;
  const orders: Order[] = [];

  for (const [commessa, data] of orderMap) {
    const sorted = data.ops.sort((a, b) => parseMinutes(a.inizio) - parseMinutes(b.inizio));
    let maxEnd = 0;

    sorted.forEach((p, seq) => {
      opCounter++;
      const startMin = parseMinutes(p.inizio);
      const endMin = parseMinutes(p.fine);
      maxEnd = Math.max(maxEnd, endMin);

      if (!machineSet.has(p.macchina)) {
        machineSet.set(p.macchina, { id: p.macchina, name: p.macchina, shortName: p.macchina });
      }
      if (p.operatore && !operatorSet.has(p.operatore)) {
        operatorSet.set(p.operatore, { id: p.operatore, name: p.operatore, shift: 'Mattina', qualifiedMachines: [] });
      }
      if (p.operatore) {
        const op = operatorSet.get(p.operatore)!;
        if (!op.qualifiedMachines.includes(p.macchina)) op.qualifiedMachines.push(p.macchina);
      }

      allOps.push({
        id: `OP-${commessa}-${seq + 1}`,
        orderId: commessa,
        machineId: p.macchina,
        operatorId: p.operatore ?? '',
        setupMinutes: p.setup_min ?? 0,
        processingMinutes: p.lavorazione_min ?? (endMin - startMin),
        startMinute: startMin,
        sequence: seq + 1,
        description: p.operazione,
      });
    });

    orders.push({
      id: commessa,
      product: commessa,
      quantity: 1,
      priority: 'media',
      priorityWeight: 2,
      deadline: 'N/A',
      deadlineMinute: 999999,
      completionMinute: maxEnd,
      status: 'in-tempo',
      operationCount: sorted.length,
      client: '',
    });
  }

  const machines = Array.from(machineSet.values());
  const operators = Array.from(operatorSet.values());
  const totalSetup = allOps.reduce((s, o) => s + o.setupMinutes, 0);
  const totalProc = allOps.reduce((s, o) => s + o.processingMinutes, 0);
  const maxEnd = allOps.reduce((m, o) => Math.max(m, o.startMinute + o.processingMinutes), 0);

  return {
    machines,
    operators,
    operations: allOps,
    orders,
    maintenanceWindows: [],
    keyDecisions: [],
    kpis: {
      makespan: rawKpis.makespan_ore ?? Math.round((maxEnd / 60) * 10) / 10,
      makespanDays: makespanToWorkingDays(rawKpis.makespan_ore ?? maxEnd / 60, timeConfig),
      totalTardiness: rawKpis.ritardi ?? 0,
      highPriorityOnTime: 100,
      peakUtilization: rawKpis.utilizzo_macchine_pct ?? 0,
      avgUtilization: rawKpis.utilizzo_macchine_pct ?? 0,
      totalOperations: allOps.length,
      totalSetupTime: totalSetup,
      totalProcessingTime: totalProc,
      ordersOnTime: orders.length,
      ordersLate: 0,
      totalOrders: orders.length,
      costoOperatori: 0,
      costoSetup: 0,
      costoTotale: 0,
    },
    narrative,
    method: 'llm-only',
    costUsd: (raw.cost_usd as number) ?? 0,
  };
}

// ── Pipeline result ─────────────────────────────────────────────────

function adaptPipeline(raw: Record<string, unknown>): DashboardData {
  // Pipeline returns same FJSP-like solution format
  const solution = raw.solution as Record<string, unknown> | undefined;
  if (solution && typeof solution === 'object') {
    // Check if it looks like FJSP format (job keys with fasi arrays)
    const firstVal = Object.values(solution)[0] as Record<string, unknown> | undefined;
    if (firstVal && 'fasi' in firstVal) {
      const adapted = adaptFJSP({
        solution,
        kpis: raw.kpis ?? {},
        cost_usd: raw.cost_usd,
        time_config: raw.time_config,
        maintenance: raw.maintenance,
        operator_config: raw.operator_config,
      });
      adapted.narrative = (raw.narrative as string) ?? '';
      adapted.method = 'codegen-pipeline';
      return adapted;
    }
  }
  // Fallback: treat as LLM-like
  const adapted = adaptLLMOnly(raw);
  adapted.method = 'codegen-pipeline';
  adapted.narrative = (raw.narrative as string) ?? '';
  return adapted;
}

// ── Main adapter ────────────────────────────────────────────────────

export function adaptResult(raw: unknown, method: string): DashboardData {
  const data = raw as Record<string, unknown>;
  switch (method) {
    case 'llm-only':
      return adaptLLMOnly(data);
    case 'codegen-pipeline':
      return adaptPipeline(data);
    case 'deterministic-json':
      return adaptFJSP(data);
    default:
      return adaptFJSP(data);
  }
}

// ── Helper functions (same interface as mockData) ───────────────────

export function getOperationsForMachine(ops: Operation[], machineId: string): Operation[] {
  return ops.filter(op => op.machineId === machineId).sort((a, b) => a.startMinute - b.startMinute);
}

export function getOperationsForOperator(ops: Operation[], operatorId: string): Operation[] {
  return ops.filter(op => op.operatorId === operatorId).sort((a, b) => a.startMinute - b.startMinute);
}

export function getMachineUtilization(ops: Operation[], machineId: string, makespanMinutes: number): number {
  const mOps = ops.filter(op => op.machineId === machineId);
  const busy = mOps.reduce((s, o) => s + o.setupMinutes + o.processingMinutes, 0);
  return makespanMinutes > 0 ? Math.min(99, (busy / makespanMinutes) * 100) : 0;
}

export function getOperatorUtilization(ops: Operation[], operatorId: string, makespanMinutes: number): number {
  const oOps = ops.filter(op => op.operatorId === operatorId);
  const busy = oOps.reduce((s, o) => s + o.setupMinutes + o.processingMinutes, 0);
  return makespanMinutes > 0 ? Math.min(99, (busy / makespanMinutes) * 100) : 0;
}

export function getJobColorHex(orderId: string): string {
  const colors = [
    '#00c896', '#5b8af5', '#d4a843', '#e05aa0', '#e07a3a',
    '#3aa8d4', '#4dba6e', '#8a6fd4', '#a0c44a', '#d44a6a',
  ];
  // Hash the orderId to get consistent color
  let hash = 0;
  for (let i = 0; i < orderId.length; i++) {
    hash = ((hash << 5) - hash) + orderId.charCodeAt(i);
    hash |= 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

// Wall-clock formatter — preferred path: pass the operation's
// startDatetime (already produced by the backend) and we render a
// compact string. Fallback path: derive from raw model minutes + the
// active TimeConfig from the dashboard. Last-resort fallback (mock /
// no config available) keeps the legacy 8h-day estimate so the mock
// dashboard still renders something readable.
export function minutesToTimeStr(
  minutes: number,
  tc?: TimeConfig,
  isoDatetime?: string,
): string {
  if (isoDatetime) {
    // "YYYY-MM-DD HH:MM" → "01/04 08:00" (compact, day+time)
    const m = isoDatetime.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})/);
    if (m) {
      const [, , mo, dd, hh, mm] = m;
      return `${dd}/${mo} ${hh}:${mm}`;
    }
  }
  if (tc) return formatModelMinute(minutes, tc);
  // Legacy fallback for mock dataset (8h day starting 06:00).
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const day = Math.floor(hours / 8) + 1;
  const hourInDay = (hours % 8) + 6;
  return `G${day} ${String(hourInDay).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}
