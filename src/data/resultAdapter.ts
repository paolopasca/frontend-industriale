/**
 * Transforms backend solver results into the dashboard data format.
 * Supports all 3 solver methods: llm-only, codegen-pipeline, deterministic-json.
 */
import type { Machine, Operator, Operation, Order, MaintenanceWindow, KeyDecision, Priority, OrderStatus, Shift } from './mockData';
import { JOB_COLORS } from './mockData';

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
  };
  narrative: string;
  method: string;
  costUsd: number;
}

// ── FJSP Template result (apex-toy, demo-commesse) ──────────────────

function adaptFJSP(raw: Record<string, unknown>): DashboardData {
  const solution = (raw.solution ?? {}) as Record<string, { fasi: Array<{
    operazione: string; macchina: string; operatore: string;
    start_min: number; end_min: number; processing_min: number;
    setup_min: number; costo_operatore?: number; costo_setup?: number;
  }>; ritardo_min?: number; completamento_min?: number; scadenza_min?: number; priorita?: string }>;
  const rawKpis = (raw.kpis ?? {}) as Record<string, number>;

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
    const priorita = (job.priorita ?? 'media') as Priority;

    orders.push({
      id: jobId,
      product: jobId,
      quantity: 1,
      priority: priorita,
      priorityWeight: priorita === 'alta' ? 5 : priorita === 'media' ? 2 : 1,
      deadline: deadlineMin < 999999 ? `Min ${deadlineMin}` : 'N/A',
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
      });
    });
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

  return {
    machines,
    operators,
    operations: allOps,
    orders,
    maintenanceWindows: [],
    keyDecisions: [],
    kpis: {
      makespan: Math.round(makespan * 10) / 10,
      makespanDays: Math.round((makespan / 8) * 10) / 10,
      totalTardiness: rawKpis.tardiness_totale_min ?? rawKpis.total_tardiness ?? orders.reduce((s, o) => s + Math.max(0, o.completionMinute - o.deadlineMinute), 0),
      highPriorityOnTime: orders.filter(o => o.priority === 'alta' && o.status === 'in-tempo').length / Math.max(1, orders.filter(o => o.priority === 'alta').length) * 100,
      peakUtilization: Math.round(peakUtil * 10) / 10,
      avgUtilization: Math.round(avgUtil * 10) / 10,
      totalOperations: allOps.length,
      totalSetupTime: totalSetup,
      totalProcessingTime: totalProc,
      ordersOnTime: orders.length - ordersLate,
      ordersLate,
      totalOrders: orders.length,
    },
    narrative: '',
    method: 'deterministic-template',
    costUsd: (raw.cost_usd as number) ?? 0,
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
      makespanDays: Math.round(((rawKpis.makespan_ore ?? maxEnd / 60) / 8) * 10) / 10,
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
      const adapted = adaptFJSP({ solution, kpis: raw.kpis ?? {}, cost_usd: raw.cost_usd });
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

export function minutesToTimeStr(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const day = Math.floor(hours / 8) + 1;
  const hourInDay = (hours % 8) + 6;
  return `G${day} ${String(hourInDay).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}
