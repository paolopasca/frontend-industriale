import type { AiSolutionEnvelope } from './aiInputs';

export interface SolutionContext {
  machines: string[];
  machine_aliases: Record<string, string>;
  orders: string[];
  shifts: string[];
  time_config: { day_length_min: number; start_date: string } | null;
  shift_types: Record<string, { start: number; end: number }> | null;
  order_deadlines: Record<string, number> | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function extractMachines(fasi: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  for (const f of fasi) {
    const m = f.macchina ?? f.machine ?? f.machine_id ?? f.machineId;
    if (typeof m === 'string' && m.trim()) seen.add(m.trim());
  }
  return [...seen];
}

function buildMachineAliases(machines: string[]): Record<string, string> {
  const aliases: Record<string, string> = {};
  for (const m of machines) {
    // Case-folding alias so backend extractor can match lowercase queries.
    const lower = m.toLowerCase();
    if (lower !== m) aliases[lower] = m;

    // NL aliases: "linea N" / "macchina N" / "machine N" → exact canonical string.
    // Extract first integer from canonical name and build common Italian/English phrasings.
    // Value is always one of the strings in machines[] — never fabricated.
    const numMatch = m.match(/(\d+)/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      aliases[`linea ${n}`] = m;
      aliases[`macchina ${n}`] = m;
      aliases[`machine ${n}`] = m;
    }
  }
  return aliases;
}

function extractOrders(commesse: Record<string, unknown>): string[] {
  return Object.keys(commesse);
}

function extractOrderDeadlines(
  commesse: Record<string, unknown>,
): Record<string, number> | null {
  const deadlines: Record<string, number> = {};
  let found = false;
  for (const [id, jobRaw] of Object.entries(commesse)) {
    if (!isObject(jobRaw)) continue;
    const dl = jobRaw.scadenza_min ?? jobRaw.deadline_min;
    if (typeof dl === 'number' && Number.isFinite(dl)) {
      deadlines[id] = dl;
      found = true;
    }
  }
  return found ? deadlines : null;
}

function extractTimeConfig(
  raw: unknown,
): { day_length_min: number; start_date: string } | null {
  if (!isObject(raw)) return null;
  const tc = raw.time_config;
  if (isObject(tc)) {
    const dl = tc.day_length_min ?? tc.dayLengthMin;
    const sd = tc.start_date ?? tc.startDate;
    if (typeof dl === 'number' && typeof sd === 'string') {
      return { day_length_min: dl, start_date: sd };
    }
  }
  return null;
}

function extractShiftTypes(
  raw: unknown,
): Record<string, { start: number; end: number }> | null {
  if (!isObject(raw)) return null;
  const st = raw.shift_types ?? raw.shiftTypes;
  if (!isObject(st)) return null;
  const result: Record<string, { start: number; end: number }> = {};
  let found = false;
  for (const [name, body] of Object.entries(st)) {
    if (!isObject(body)) continue;
    const start = body.start ?? body.start_min;
    const end = body.end ?? body.end_min;
    if (typeof start === 'number' && typeof end === 'number') {
      result[name] = { start, end };
      found = true;
    }
  }
  return found ? result : null;
}

// Extract the commessa-keyed map from both raw backend responses and
// normalised AiSolutionEnvelope objects.
//
// Raw shape (from apply-whatif route): { status, solution: { COM-001: { fasi, scadenza_min }, ... }, kpis }
// Normalised shape (AiSolutionEnvelope): { commesse: { COM-001: { fasi, ... } }, fasi: [...], ... }
function extractCommesse(solution: unknown): Record<string, unknown> {
  if (!isObject(solution)) return {};
  // Normalised AiSolutionEnvelope — commesse field is set by buildAiSolutionEnvelope
  if (isObject(solution.commesse)) return solution.commesse as Record<string, unknown>;
  // Raw backend response — commessa map lives under solution.solution
  if (isObject(solution.solution)) return solution.solution as Record<string, unknown>;
  return {};
}

export function buildSolutionContext(
  solution: AiSolutionEnvelope | unknown,
  _kpis: Record<string, number>,
  _consultation?: string,
): SolutionContext {
  const envelope = solution as AiSolutionEnvelope | null;

  const fasi: Array<Record<string, unknown>> =
    Array.isArray(envelope?.fasi) ? envelope!.fasi : [];
  const commesse = extractCommesse(solution);

  const machines = extractMachines(fasi);
  const machine_aliases = buildMachineAliases(machines);
  const orders = extractOrders(commesse);
  const order_deadlines = extractOrderDeadlines(commesse);

  const raw = isObject(solution) ? solution : {};
  const time_config = extractTimeConfig(raw);
  const shift_types = extractShiftTypes(raw);

  // Return empty when shift_types is unknown — the backend extractor degrades
  // gracefully to MISS on shift-related patterns rather than matching invented names.
  const shifts: string[] = shift_types ? Object.keys(shift_types) : [];

  return {
    machines,
    machine_aliases,
    orders,
    shifts,
    time_config,
    shift_types,
    order_deadlines,
  };
}
