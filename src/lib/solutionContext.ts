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

function collectMachinesFromFasi(
  fasi: Array<Record<string, unknown>>,
  seen: Set<string>,
): void {
  for (const f of fasi) {
    const m = f.macchina ?? f.machine ?? f.machine_id ?? f.machineId;
    if (typeof m === 'string' && m.trim()) seen.add(m.trim());
  }
}

// Wave 16.6: the machine closed set must populate for EVERY originalSolution
// shape the BFF passes, not just the flat AiSolutionEnvelope. The what-if route
// hands buildSolutionContext either a flat `{fasi:[...]}`, a nested
// `{COM-001:{fasi:[...]}}`, or a raw backend `{solution:{COM-001:{fasi}}}`.
// Pre-fix, extractMachines read ONLY the top-level fasi[], so nested/raw shapes
// produced machines=[] → the interpreter's machine enum was omitted and every
// machine instruction silently failed the gate. Harvest from BOTH the flat
// fasi[] AND each commessa's nested fasi[] so the set is shape-agnostic. Orders
// already came from the commesse map (extractOrders); now machines mirror that.
function extractMachines(
  flatFasi: Array<Record<string, unknown>>,
  commesse: Record<string, unknown>,
): string[] {
  const seen = new Set<string>();
  collectMachinesFromFasi(flatFasi, seen);
  for (const jobRaw of Object.values(commesse)) {
    if (!isObject(jobRaw)) continue;
    const jobFasi = jobRaw.fasi;
    if (Array.isArray(jobFasi)) {
      collectMachinesFromFasi(jobFasi as Array<Record<string, unknown>>, seen);
    }
  }
  return [...seen];
}

export function buildMachineAliases(machines: string[]): Record<string, string> {
  // Collision-safe alias builder. The backend extractor resolves an entity
  // ("m1") only via an exact (case-insensitive) match in `machines` OR a key
  // in this map. When two machines would claim the same alias we DROP it
  // rather than let last-write-wins fabricate a wrong resolution — an
  // ambiguous alias is worse than a GRAY "?" (the manager just re-phrases).
  const proposals = new Map<string, string>(); // aliasKey -> canonical
  const ambiguous = new Set<string>();
  const add = (key: string, canonical: string) => {
    if (ambiguous.has(key)) return;
    const existing = proposals.get(key);
    if (existing !== undefined && existing !== canonical) {
      proposals.delete(key);
      ambiguous.add(key);
      return;
    }
    proposals.set(key, canonical);
  };

  for (const m of machines) {
    // Case-folding alias so the extractor matches lowercase queries.
    const lower = m.toLowerCase();
    if (lower !== m) add(lower, m);

    // Compact forms that strip the separator and (de-)pad the number, so a
    // canonical "M-001" also resolves "m1", "m01", "m001", "m-1" — the way
    // managers actually type. Value is always one of machines[]; never
    // fabricated. Devil/be-temporal Wave 16.5: with machines=["M-001"] alone,
    // "m1" fell to GRAY because no such alias existed, defeating the HIT path.
    const prefixNum = m.match(/^([A-Za-z]+)\D*?(\d+)$/);
    if (prefixNum) {
      const prefix = prefixNum[1].toLowerCase();
      const n = parseInt(prefixNum[2], 10);
      if (Number.isFinite(n)) {
        const raw = prefixNum[2]; // preserve original padding, e.g. "001"
        add(`${prefix}${n}`, m); // m1
        add(`${prefix}${raw}`, m); // m001 (no separator, original padding)
        add(`${prefix}-${n}`, m); // m-1
        add(`${prefix} ${n}`, m); // "m 1"
      }
    }

    // NL aliases: "linea N" / "macchina N" / "machine N".
    const numMatch = m.match(/(\d+)/);
    if (numMatch) {
      const n = parseInt(numMatch[1], 10);
      add(`linea ${n}`, m);
      add(`macchina ${n}`, m);
      add(`machine ${n}`, m);
    }
  }
  return Object.fromEntries(proposals);
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
// Bare-nested shape (what-if originalSolution): { COM-001: { fasi, scadenza_min }, ... }
function extractCommesse(solution: unknown): Record<string, unknown> {
  if (!isObject(solution)) return {};
  // Normalised AiSolutionEnvelope — commesse field is set by buildAiSolutionEnvelope
  if (isObject(solution.commesse)) return solution.commesse as Record<string, unknown>;
  // Raw backend response — commessa map lives under solution.solution
  if (isObject(solution.solution)) return solution.solution as Record<string, unknown>;
  // Bare-nested map `{COM-001:{fasi:[...]}}` (the what-if route hands this shape
  // directly — buildBaselineForRouter flattens it the same way). Only when there
  // is no top-level fasi[] (flat envelope) and the root's OWN values look like
  // commessa entries (objects carrying a `fasi` array). Guarded against false
  // positives: a stray `time_config`/`kpis` key without `fasi` is never treated
  // as a commessa. Wave 16.6 — without this the bare-nested shape produced an
  // empty closed set (machines & orders both []), starving the interpreter enum.
  if (!Array.isArray(solution.fasi)) {
    const entries = Object.entries(solution).filter(
      ([, v]) => isObject(v) && Array.isArray((v as { fasi?: unknown }).fasi),
    );
    if (entries.length > 0) return Object.fromEntries(entries);
  }
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

  const machines = extractMachines(fasi, commesse);
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
