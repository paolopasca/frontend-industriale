#!/usr/bin/env tsx
/**
 * Wave 8 — Stress test EVALS (live Haiku + backend).
 *
 * 15 cycles end-to-end through the real BFF (`/api/apply-whatif`) with
 * realistic Italian manager utterances drawn from the constraint
 * catalog examples + hand-crafted scenarios (some formal, some
 * colloquial, some intentionally ambiguous). The pipeline exercised:
 *
 *   Haiku intent-parser → strategy-router → data-modifier / rules
 *   payload → frozen-window-builder → daino-backend-definitivo solver
 *   → INFEASIBLE recovery branch if needed → solved.
 *
 * For each cycle we record the expected intent_id (curated, used as
 * ground truth for the classification score) and verify the
 * constraint-respected predicate against the candidate solution
 * (where the predicate is meaningful — machine_unavailability needs
 * the machine free, order_priority needs the order to finish earlier
 * than its baseline-rank peers, etc).
 *
 * Targets (Paolo direttiva):
 *   - 12/15 intent classified correctly (80%+)
 *   - 13/15 constraint respected post-solve (87%+)
 *   - cost per cycle < $0.05
 *   - error rate < 5%
 *
 * Cap costo totale: $1.00 (15 × ~$0.05 + buffer per retry/aborti).
 *
 * Usage:
 *   npx tsx scripts/wave7-stress-evals.ts
 *   BASE_URL=http://localhost:8080 BACKEND_URL=http://localhost:8001 \
 *     npx tsx scripts/wave7-stress-evals.ts
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080';
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8001';
const SLUG = 'demo-commesse';
const COST_CAP_USD = Number(process.env.COST_CAP_USD ?? 1.00);

// F-W8-08 (devils 2026-05-22): the `--diverse-slugs` flag (or env
// DIVERSE_SLUGS=1) simulates onboarding multi-tenant where each cycle
// targets a different company slug. In the live evals path the Haiku
// system prompt (catalog) does not vary by slug, so the parser-side
// cache is unaffected. BUT the BFF's per-slug `_inFlightBySlug` lock
// and the backend's per-slug `companies/<slug>/plans/history` warm-
// start cache DO see new slugs as cold-start; this surfaces any
// per-tenant onboarding latency. The mock script implements a
// stronger version of the flag (it varies the system-prompt sentinel)
// to actually defeat the Haiku cache too.
const DIVERSE_SLUGS = process.env.DIVERSE_SLUGS === '1'
  || process.argv.includes('--diverse-slugs');
const SLUG_POOL = DIVERSE_SLUGS
  ? ['demo-commesse', 'demo-acme-meccanica', 'demo-rossi-spa', 'demo-bianchi-srl', 'demo-gelato-lab']
  : null;
function slugForCycle(cycleIdx: number): string {
  if (!SLUG_POOL) return SLUG;
  return SLUG_POOL[cycleIdx % SLUG_POOL.length];
}

/**
 * Per devils F-W8-02 (2026-05-22, CRITICAL revision):
 * eval set MUST be DISJOINT from `constraint-catalog.yaml examples`
 * AND it MUST include 5 ADVERSARIAL scenarios in distinct categories
 * (dialect/regional, ambiguous machine refs, multi-intent, negation,
 * typos). Catalog examples are well-formed by construction (explicit
 * ID, complete time, canonical language, single intent) so reusing
 * them inflates the "12/15 classified" target vacuously.
 *
 * Disjoint mix (15 base + 3 regression = 18):
 *   - 10 well-formed: 4 machine_unavailability + 3 order_priority +
 *     3 deadline_change. NONE reuse catalog example text.
 *   - 5 adversarial — one per devils category:
 *       adv_dialect, adv_ambiguous_ref, adv_multi_intent,
 *       adv_negation, adv_typo
 *     ALL must classify as `unknown` (or, where context allows,
 *     not-applicable; the parser is wrong to confidently map any of
 *     these onto a catalog intent).
 *   - 3 regression scenarios (B-W8-S-01, B-W8-S-02, F-W8-09) —
 *     scored against `regression_failures[]`.
 *
 * F-W8-07 (devils 2026-05-22): low-confidence + incomplete-entity
 * handling is covered in the MOCK script (where we control the Haiku
 * mock confidence). The live evals can't deterministically force low
 * confidence; we sample what the real parser emits.
 */
interface Scenario {
  id: string;
  /**
   * Buckets:
   *   - `standard`: well-formed catalog-intent-targeted utterance.
   *     Parser should classify confidently.
   *   - `adversarial`: dialect, ambiguous-ref, multi-intent, negation,
   *     or typo. Parser should bail to `unknown` (or, for typos, may
   *     recover). See `adversarial_kind`.
   *   - `regression`: pinned to a specific bug fix (B-W8-S-01,
   *     B-W8-S-02, F-W8-09). Scored via `regression` predicates.
   */
  category: 'standard' | 'adversarial' | 'regression';
  /**
   * Devils F-W8-02 adversarial sub-category. Required when
   * `category === 'adversarial'`.
   */
  adversarial_kind?: 'dialect_regional' | 'ambiguous_machine_ref' | 'multi_intent' | 'negation' | 'typo';
  utterance: string;
  /** Set of intent ids considered a correct classification. */
  expected_intent_ids: ReadonlyArray<string>;
  /** If set, the strategy axis is also scored. */
  expected_strategy?: 'A' | 'B' | 'unsupported';
  /** Optional verification hint for the candidate schedule. */
  verify_hint?: {
    machine_id?: string;
    window_start_min?: number;
    window_end_min?: number;
    order_id?: string;
    new_deadline_min?: number;
    order_ids?: string[];
  };
  /**
   * Regression fix predicates (team-lead 2026-05-22, post B-W8-S fixes).
   * - `max_cost_usd`: assert cost_usd <= this. Used by B-W8-S-01 regression
   *   ("M2" canonicalisation must not push to Opus translator path).
   * - `min_locked_count`: assert locked_count >= this. Used by F-W8-09
   *   regression (frozen-window phases must hard-lock when
   *   currentTimeMin>0 and baseline has phases before cutoff).
   * - `must_be_classified_not_unsupported`: assert strategy !== 'unsupported'.
   *   Used by B-W8-S-02 regression (entity completeness — vague window
   *   utterances should still classify+route, not bail to unsupported).
   */
  regression?: {
    max_cost_usd?: number;
    min_locked_count?: number;
    must_be_classified_not_unsupported?: boolean;
    notes?: string;
  };
}

// 15 scenarios, disjoint from catalog YAML; 10 well-formed + 5 adversarial.
const SCENARIOS: Scenario[] = [
  // -- (A) WELL-FORMED — 10 catalog-intent-targeted but disjoint -----------
  // 4 machine_unavailability
  {
    id: 'wf_mu_01_smoke',
    category: 'standard',
    utterance: 'Senti, M03 ha cominciato a fumare stamattina, dobbiamo lasciarla ferma fino a stasera',
    expected_intent_ids: ['machine_unavailability'],
    expected_strategy: 'B',
    verify_hint: { machine_id: 'M03', window_start_min: 0, window_end_min: 1080 },
  },
  {
    id: 'wf_mu_02_maintenance',
    category: 'standard',
    utterance: 'Fermo M02 dalle 14 alle 18 di domani per manutenzione programmata',
    expected_intent_ids: ['machine_unavailability'],
    expected_strategy: 'B',
    verify_hint: { machine_id: 'M02', window_start_min: 2280, window_end_min: 2520 },
  },
  {
    id: 'wf_mu_03_full_gg2',
    category: 'standard',
    utterance: 'M04 indisponibile tutto il gg2 per intervento elettricista',
    expected_intent_ids: ['machine_unavailability'],
    expected_strategy: 'B',
    verify_hint: { machine_id: 'M04', window_start_min: 1440, window_end_min: 2880 },
  },
  {
    id: 'wf_mu_04_pomeriggio',
    category: 'standard',
    utterance: 'Stop a M01 nel pomeriggio di oggi fino a fine giornata',
    expected_intent_ids: ['machine_unavailability'],
    expected_strategy: 'B',
    verify_hint: { machine_id: 'M01', window_start_min: 840, window_end_min: 1080 },
  },

  // 3 order_priority
  {
    id: 'wf_op_01_urgent_client',
    category: 'standard',
    utterance: 'Il caposquadra dice che dobbiamo sbrigarci con COM-007, il cliente sta facendo un casino al telefono',
    expected_intent_ids: ['order_priority'],
    expected_strategy: 'B',
    verify_hint: { order_ids: ['COM-007'] },
  },
  {
    id: 'wf_op_02_explicit',
    category: 'standard',
    utterance: 'Dai priorità alla commessa COM-003 rispetto alle altre',
    expected_intent_ids: ['order_priority'],
    expected_strategy: 'B',
    verify_hint: { order_ids: ['COM-003'] },
  },
  {
    id: 'wf_op_03_two_orders',
    category: 'standard',
    utterance: 'Tira fuori prima COM-001 e COM-008, sono in scadenza',
    expected_intent_ids: ['order_priority'],
    expected_strategy: 'B',
    verify_hint: { order_ids: ['COM-001', 'COM-008'] },
  },

  // 3 deadline_change
  {
    id: 'wf_dc_01_explicit_day',
    category: 'standard',
    utterance: 'Aggiorna la scadenza di COM-005: deve essere finita entro fine giornata di domani',
    expected_intent_ids: ['deadline_change'],
    expected_strategy: 'A',
    verify_hint: { order_id: 'COM-005', new_deadline_min: 2520 },
  },
  {
    id: 'wf_dc_02_two_days',
    category: 'standard',
    utterance: 'Sposta in avanti la scadenza di COM-002 a fine gg3',
    expected_intent_ids: ['deadline_change'],
    expected_strategy: 'A',
    verify_hint: { order_id: 'COM-002', new_deadline_min: 3960 },
  },
  {
    id: 'wf_dc_03_anticipate',
    category: 'standard',
    utterance: 'COM-004 deve essere chiusa entro mezzogiorno di domani',
    expected_intent_ids: ['deadline_change'],
    expected_strategy: 'A',
    verify_hint: { order_id: 'COM-004', new_deadline_min: 2160 },
  },

  // -- (B) ADVERSARIAL — 5 distinct categories per devils F-W8-02 ---------
  // All MUST classify as `unknown` (or fail-soft to unsupported); the
  // parser is wrong to map any of these onto a catalog intent confidently.
  {
    id: 'adv_dialect',
    category: 'adversarial',
    utterance: "Sta camola fa scintille, fermala finché nu vengo a 'ddà",
    expected_intent_ids: ['unknown'],
    expected_strategy: 'unsupported',
    adversarial_kind: 'dialect_regional',
  },
  {
    id: 'adv_ambiguous_ref',
    category: 'adversarial',
    utterance: "La macchina nuova, quella vicino alla porta del magazzino, lasciamola spenta oggi pomeriggio",
    expected_intent_ids: ['unknown'],
    expected_strategy: 'unsupported',
    adversarial_kind: 'ambiguous_machine_ref',
  },
  {
    id: 'adv_multi_intent',
    category: 'adversarial',
    utterance: 'M02 è rotta dalle 10 e ho un operatore in più stasera, anticipa anche COM-001',
    expected_intent_ids: ['unknown'],
    expected_strategy: 'unsupported',
    adversarial_kind: 'multi_intent',
  },
  {
    id: 'adv_negation',
    category: 'adversarial',
    utterance: 'NON spostare la scadenza di COM-002, lascia tutto come sta',
    expected_intent_ids: ['unknown'],
    expected_strategy: 'unsupported',
    adversarial_kind: 'negation',
  },
  {
    id: 'adv_typo',
    category: 'adversarial',
    utterance: 'anitcipa la commesa COM 007 prma delle altre',
    // Typos may still classify correctly if the parser is robust — the
    // devils ask is "becomes unknown" but if the parser recovers we
    // accept order_priority too. The other 4 adversarial kinds are
    // strictly unknown.
    expected_intent_ids: ['unknown', 'order_priority'],
    adversarial_kind: 'typo',
  },

  // -- (6) regression scenarios — verify B-W8-S-01/02 + F-W8-09 fixes (3) -
  // (team-lead 2026-05-22 bonus: these MUST pass after w8-infeasible-
  // recovery's consolidated fix lands; before the fix they reproduce the
  // exact bug signature seen in the obsolete partial run.)
  {
    id: 'reg_01_m2_no_zero',
    category: 'regression',
    // B-W8-S-01: "M2" (no leading zero) — pre-fix this parsed correctly
    // by Haiku but failed `must_exist_in_solution_machines` against
    // baseline `M01..M05`, cascading to Opus translator (cost $0.25).
    // Post-fix expectation: canonicalised to M02 → Strategy B → $0.001.
    utterance: 'M2 si è rotto stamattina, fermala fino a fine giornata',
    expected_intent_ids: ['machine_unavailability'],
    expected_strategy: 'B',
    verify_hint: { machine_id: 'M02', window_start_min: 0, window_end_min: 1080 },
    regression: {
      max_cost_usd: 0.01, // anything > $0.01 means Opus translator fired
      must_be_classified_not_unsupported: true,
      notes: 'B-W8-S-01: M2→M02 canonicalisation (Haiku post-process or fuzzy validator). Pre-fix: $0.25. Post-fix target: $0.001.',
    },
  },
  {
    id: 'reg_02_vague_window_gg3',
    category: 'regression',
    // B-W8-S-02: pre-fix this parsed `machine_unavailability MEDIUM` then
    // routed to `unsupported` AND cost $0.19 (Opus also gave up).
    // Post-fix expectation: entity completeness fix lets start_min default
    // to gg3 boundary + end_min to horizon_end → Strategy B → $0.001.
    utterance: 'M05 in panne, vincolo da consolidare per il gg3',
    expected_intent_ids: ['machine_unavailability'],
    // We don't pin expected_strategy here because the post-fix decision
    // (B vs C) depends on whether the parser emits a concrete start_min
    // for "gg3" (then router routes to B) or leaves it ambiguous (then
    // C is acceptable). What MUST NOT happen is `unsupported`.
    verify_hint: { machine_id: 'M05' },
    regression: {
      max_cost_usd: 0.05, // forgiving — allows a C Opus call if needed, but not $0.19
      must_be_classified_not_unsupported: true,
      notes: 'B-W8-S-02: entity-completeness fix. Pre-fix: $0.19 + unsupported. Post-fix target: any non-unsupported outcome at <= $0.05.',
    },
  },
  {
    id: 'reg_03_frozen_lock',
    category: 'regression',
    // F-W8-09 (critical off-by-one seq fix). The BFF builds frozen_phases
    // from the baseline's pre-cutoff phases; the backend hard-locks them.
    // Pre-fix: locked_count == 0 even when frozen_count > 0 because the
    // seq index drifted. Post-fix: locked_count should equal frozen_count.
    // We use a utterance that triggers a normal apply (so the solve goes
    // through the locked branch), and verify locked_count > 0.
    //
    // NOTE: the BFF computes frozen_phases from `originalSolution` +
    // `currentTimeMin`. Our caller (callApplyWhatIf below) sends
    // currentTimeMin=0 by default — which gives cutoff=30, and the
    // demo-commesse baseline almost certainly has no phase finishing at
    // or before minute 30. To make this scenario meaningful we override
    // currentTimeMin for this cycle (see main loop's per-scenario hook).
    utterance: 'Fermo M03 dalle 14 alle 18 di domani per manutenzione',
    expected_intent_ids: ['machine_unavailability'],
    expected_strategy: 'B',
    verify_hint: { machine_id: 'M03', window_start_min: 2280, window_end_min: 2520 },
    regression: {
      min_locked_count: 1, // pre-fix: 0; post-fix: should be >=1 given currentTimeMin=600
      notes: 'F-W8-09: off-by-one seq fix. Cycle uses currentTimeMin=600 to put cutoff well past several baseline phases.',
    },
  },
];

if (SCENARIOS.length !== 18) {
  console.error(`Scenario count mismatch: ${SCENARIOS.length} (expected 18 = 15 + 3 regression)`);
  process.exit(2);
}

interface CycleRecord {
  index: number;
  scenario_id: string;
  category: Scenario['category'];
  adversarial_kind?: Scenario['adversarial_kind'];
  utterance: string;
  expected_intent_ids: ReadonlyArray<string>;
  expected_strategy?: 'A' | 'B' | 'unsupported';
  parsed_intent_id: string | null;
  parsed_entities: Record<string, unknown> | null;
  parsed_confidence: string | null;
  strategy: 'A' | 'B' | 'C' | 'unsupported' | null;
  solve_status: string | null;
  locked_count: number;
  modified_count: number;
  skipped_rules_count: number;
  frozen_count: number;
  intent_correct: boolean;
  strategy_correct: boolean | null;
  constraint_respected: boolean | null;
  /** Empty array = all regression predicates passed (or none defined). */
  regression_failures: string[];
  cost_usd: number;
  latency_ms: number;
  current_time_min: number;
  warnings: string[];
  error_msg?: string;
  events_seen: string[];
}

interface BackendFase {
  commessa?: string;
  operazione?: string;
  macchina?: string;
  machine_id?: string;
  start_min?: number;
  end_min?: number;
}

interface BackendSolution {
  [commessa: string]: { fasi?: BackendFase[] };
}

let _ipCounter = 300;
function nextIp(): string {
  _ipCounter++;
  return `10.51.${Math.floor(_ipCounter / 256)}.${_ipCounter % 256}`;
}

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(Math.max(Math.ceil((p / 100) * s.length) - 1, 0), s.length - 1);
  return s[i];
}

async function fetchBaseline(): Promise<{ solution: BackendSolution; kpis: Record<string, number> }> {
  const res = await fetch(`${BACKEND_URL}/api/public/solve-template`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: SLUG, problem_type: 'fjsp', force_cold_start: true }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Baseline solve failed: HTTP ${res.status}`);
  const j = await res.json() as Record<string, unknown>;
  const rawKpis = (j.kpis ?? {}) as Record<string, unknown>;
  const flatKpis: Record<string, number> = {};
  for (const [k, v] of Object.entries(rawKpis)) {
    if (typeof v === 'number' && Number.isFinite(v)) flatKpis[k] = v;
  }
  const solution = (j.solution ?? {}) as BackendSolution;
  return { solution, kpis: flatKpis };
}

const WHATIF_SAMPLE = `## 1. Interpretazione
Scenario eval Wave 8.

## 2. Impatto
Da verificare con re-solve.

## 3. Trade-off
Standard.

## 4. Raccomandazione
Applicare e confrontare KPI.`;

interface ApplyResult {
  events_seen: string[];
  parsed_intent_id: string | null;
  parsed_entities: Record<string, unknown> | null;
  parsed_confidence: string | null;
  strategy: 'A' | 'B' | 'C' | 'unsupported' | null;
  solve_status: string | null;
  locked_count: number;
  modified_count: number;
  skipped_rules_count: number;
  frozen_count: number;
  solution: BackendSolution | null;
  warnings: string[];
  cost_usd: number;
  error_msg?: string;
}

async function callApplyWhatIf(
  baseline: { solution: BackendSolution; kpis: Record<string, number> },
  utterance: string,
  currentTimeMin: number = 0,
  slug: string = SLUG,
): Promise<{ result: ApplyResult; latency_ms: number }> {
  const t0 = Date.now();
  const whatifText = `${WHATIF_SAMPLE}\n\n<<scenario>> ${utterance}`;
  const body = JSON.stringify({
    slug,
    originalSolution: baseline.solution,
    kpis: baseline.kpis,
    whatifText,
    managerText: utterance,
    currentTimeMin,
    cushionMin: 30,
  });

  const events_seen: string[] = [];
  let parsed_intent_id: string | null = null;
  let parsed_entities: Record<string, unknown> | null = null;
  let parsed_confidence: string | null = null;
  let strategy: 'A' | 'B' | 'C' | 'unsupported' | null = null;
  let solve_status: string | null = null;
  let locked_count = 0;
  let modified_count = 0;
  let skipped_rules_count = 0;
  let frozen_count = 0;
  let solution: BackendSolution | null = null;
  const warnings: string[] = [];
  let cost_usd = 0;
  let error_msg: string | undefined;

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/apply-whatif`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': nextIp() },
      body,
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    return {
      result: {
        events_seen, parsed_intent_id, parsed_entities, parsed_confidence,
        strategy, solve_status, locked_count, modified_count, skipped_rules_count, frozen_count,
        solution: null, warnings, cost_usd: 0,
        error_msg: err instanceof Error ? err.message : String(err),
      },
      latency_ms: Date.now() - t0,
    };
  }

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    return {
      result: {
        events_seen, parsed_intent_id, parsed_entities, parsed_confidence,
        strategy, solve_status, locked_count, modified_count, skipped_rules_count, frozen_count,
        solution: null, warnings, cost_usd: 0,
        error_msg: `HTTP ${res.status}: ${txt.slice(0, 200)}`,
      },
      latency_ms: Date.now() - t0,
    };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    buf += dec.decode(r.value, { stream: true });
    let idxBuf: number;
    while ((idxBuf = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idxBuf);
      buf = buf.slice(idxBuf + 2);
      const eMatch = chunk.match(/^event:\s*(.+)/m);
      const dMatch = chunk.match(/^data:\s*(.+)/m);
      if (!eMatch || !dMatch) continue;
      const ev = eMatch[1].trim();
      events_seen.push(ev);
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(dMatch[1].trim()) as Record<string, unknown>; } catch { continue; }
      if (ev === 'intent_parsed') {
        parsed_intent_id = typeof data.intent_id === 'string' ? (data.intent_id as string) : null;
        parsed_entities = (data.entities ?? null) as Record<string, unknown> | null;
        parsed_confidence = typeof data.confidence === 'string' ? (data.confidence as string) : null;
      } else if (ev === 'routed') {
        const s = typeof data.strategy === 'string' ? (data.strategy as string) : null;
        if (s === 'A' || s === 'B' || s === 'C' || s === 'unsupported') strategy = s;
      } else if (ev === 'solved') {
        solve_status = typeof data.status === 'string' ? (data.status as string) : null;
        locked_count = Number(data.locked_count ?? 0);
        modified_count = Number(data.modified_count ?? 0);
        skipped_rules_count = Number(data.skipped_rules_count ?? 0);
        frozen_count = Number(data.frozen_count ?? 0);
        solution = (data.newSolution ?? null) as BackendSolution | null;
        const w = data.warnings;
        if (Array.isArray(w)) warnings.push(...(w as string[]));
      } else if (ev === 'aborted_unsupported') {
        strategy = 'unsupported';
        const w = data.warnings;
        if (Array.isArray(w)) warnings.push(...(w as string[]));
      } else if (ev === 'done') {
        cost_usd = typeof data.cost_usd === 'number' ? (data.cost_usd as number) : 0;
      } else if (ev === 'error') {
        error_msg = typeof data.message === 'string' ? (data.message as string).slice(0, 200) : 'unknown';
      }
    }
  }

  return {
    result: {
      events_seen, parsed_intent_id, parsed_entities, parsed_confidence,
      strategy, solve_status, locked_count, modified_count, skipped_rules_count, frozen_count,
      solution, warnings, cost_usd, error_msg,
    },
    latency_ms: Date.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Constraint verification per scenario hint. Returns null when we can't
// verify (e.g. backend returned empty solution, or hint not actionable).
// ---------------------------------------------------------------------------
function verifyMachineWindow(
  solution: BackendSolution,
  machine: string,
  start_min: number,
  end_min: number,
): boolean | null {
  let total = 0;
  for (const job of Object.values(solution)) total += job?.fasi?.length ?? 0;
  if (total === 0) return null;
  for (const job of Object.values(solution)) {
    for (const fase of job?.fasi ?? []) {
      const m = fase.machine_id ?? fase.macchina;
      if (m !== machine) continue;
      const s = Number(fase.start_min);
      const e = Number(fase.end_min);
      if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
      if (s < end_min && e > start_min) return false;
    }
  }
  return true;
}

function verifyDeadline(
  solution: BackendSolution,
  order_id: string,
  new_deadline_min: number,
): boolean | null {
  const job = solution[order_id];
  if (!job?.fasi || job.fasi.length === 0) return null;
  let maxEnd = -Infinity;
  for (const f of job.fasi) {
    const e = Number(f.end_min);
    if (Number.isFinite(e) && e > maxEnd) maxEnd = e;
  }
  if (!Number.isFinite(maxEnd)) return null;
  return maxEnd <= new_deadline_min;
}

function verifyPriority(
  baseline: BackendSolution,
  candidate: BackendSolution,
  order_ids: string[],
): boolean | null {
  // Approximate priority check: the prioritised order's earliest start
  // in the candidate solution should be at or before its baseline
  // earliest start. We treat ties as success.
  let allEarlierOrEqual = true;
  let any = false;
  for (const oid of order_ids) {
    const bFasi = baseline[oid]?.fasi ?? [];
    const cFasi = candidate[oid]?.fasi ?? [];
    if (bFasi.length === 0 || cFasi.length === 0) continue;
    any = true;
    const bMin = Math.min(...bFasi.map((f) => Number(f.start_min)).filter(Number.isFinite));
    const cMin = Math.min(...cFasi.map((f) => Number(f.start_min)).filter(Number.isFinite));
    if (!Number.isFinite(bMin) || !Number.isFinite(cMin)) continue;
    if (cMin > bMin) allEarlierOrEqual = false;
  }
  return any ? allEarlierOrEqual : null;
}

function verifyForScenario(
  scenario: Scenario,
  baselineSolution: BackendSolution,
  candidateSolution: BackendSolution | null,
  parsedEntities: Record<string, unknown> | null,
): boolean | null {
  if (!candidateSolution) return null;
  if (!scenario.verify_hint) return null; // not verifiable
  const h = scenario.verify_hint;
  if (h.machine_id && h.window_start_min !== undefined && h.window_end_min !== undefined) {
    return verifyMachineWindow(candidateSolution, h.machine_id, h.window_start_min, h.window_end_min);
  }
  if (h.order_id) {
    // Prefer hint's explicit deadline; otherwise fall back to whatever
    // the Haiku parser extracted (so we measure "solver respected the
    // PARSED constraint", which is the real product question for
    // utterances like "giovedì sera" whose absolute minute depends on
    // the prompt's day-labelling).
    const parsedDeadline = parsedEntities && typeof parsedEntities.new_deadline_min === 'number'
      ? (parsedEntities.new_deadline_min as number)
      : undefined;
    const target = h.new_deadline_min ?? parsedDeadline;
    if (target !== undefined) {
      return verifyDeadline(candidateSolution, h.order_id, target);
    }
    // No target available — confirm the order exists in the candidate.
    return candidateSolution[h.order_id]?.fasi?.length ? true : null;
  }
  if (h.order_ids && h.order_ids.length > 0) {
    return verifyPriority(baselineSolution, candidateSolution, h.order_ids);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main entry.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`Wave 8 stress EVALS — ${SCENARIOS.length} cycles, live Haiku + backend`);
  console.log(`BFF=${BASE_URL}  Backend=${BACKEND_URL}  slug=${SLUG}`);
  console.log(`Cost cap: $${COST_CAP_USD.toFixed(2)}\n`);

  console.log('Fetching baseline solve (cold start)...');
  const baseline = await fetchBaseline();
  console.log(`Baseline ready — ${Object.keys(baseline.solution).length} orders, KPI keys: ${Object.keys(baseline.kpis).join(',')}\n`);

  console.log('idx | cat   | scenario               | parsed                  | conf   | strat | status     | resp | cost     | latency');
  console.log('-'.repeat(140));

  const cycles: CycleRecord[] = [];
  let totalCost = 0;

  for (let i = 0; i < SCENARIOS.length; i++) {
    const sc = SCENARIOS[i];

    if (totalCost >= COST_CAP_USD) {
      console.log(`\nCost cap $${COST_CAP_USD.toFixed(2)} reached — stopping at cycle ${i}/${SCENARIOS.length}`);
      break;
    }

    if (i > 0) await new Promise((res) => setTimeout(res, 500));
    // Regression scenarios may need a non-zero planning clock to force
    // frozen_phases > 0 (F-W8-09). Other scenarios default to 0.
    const cycleCurrentTimeMin = sc.id === 'reg_03_frozen_lock' ? 600 : 0;
    const cycleSlug = slugForCycle(i);
    const { result, latency_ms } = await callApplyWhatIf(
      baseline, sc.utterance, cycleCurrentTimeMin, cycleSlug,
    );
    totalCost += result.cost_usd;

    // Intent classification check — scenario carries a SET of acceptable
    // ids (covers ambiguous + injection + out-of-scope cases). The
    // parser is "correct" if it landed on any of them.
    const intentCorrect = result.parsed_intent_id !== null
      && sc.expected_intent_ids.includes(result.parsed_intent_id);

    // Strategy check — only scored if scenario declares expected_strategy.
    // The router's `C` (Opus translator fallback) is treated as
    // unsupported for scoring purposes when the expected strategy is
    // unsupported, because both produce a refusal-shaped outcome from
    // the manager's point of view.
    let strategyCorrect: boolean | null = null;
    if (sc.expected_strategy !== undefined) {
      if (sc.expected_strategy === 'unsupported') {
        strategyCorrect = result.strategy === 'unsupported' || result.strategy === 'C';
      } else {
        strategyCorrect = result.strategy === sc.expected_strategy;
      }
    }

    // F-W8-01 (devils 2026-05-22): capacity_addition + shift_window
    // route to `unsupported` by design — no candidate solution to verify
    // against, so set respected = null.
    const isExpectedUnsupported = sc.expected_strategy === 'unsupported'
      || result.parsed_intent_id === 'capacity_addition'
      || result.parsed_intent_id === 'shift_window';

    const respected = isExpectedUnsupported
      ? null
      : verifyForScenario(sc, baseline.solution, result.solution, result.parsed_entities);

    // Regression predicates (B-W8-S-01 cost ceiling, B-W8-S-02 non-unsupported,
    // F-W8-09 locked_count floor).
    const regressionFailures: string[] = [];
    if (sc.regression) {
      const r = sc.regression;
      if (r.max_cost_usd !== undefined && result.cost_usd > r.max_cost_usd) {
        regressionFailures.push(`cost_above_ceiling:$${result.cost_usd.toFixed(5)}>$${r.max_cost_usd.toFixed(5)}`);
      }
      if (r.min_locked_count !== undefined && result.locked_count < r.min_locked_count) {
        regressionFailures.push(`locked_count_below_floor:${result.locked_count}<${r.min_locked_count}`);
      }
      if (r.must_be_classified_not_unsupported === true && result.strategy === 'unsupported') {
        regressionFailures.push('classified_as_unsupported_but_should_not_be');
      }
    }

    const cycle: CycleRecord = {
      index: i,
      scenario_id: sc.id,
      category: sc.category,
      adversarial_kind: sc.adversarial_kind,
      utterance: sc.utterance,
      expected_intent_ids: sc.expected_intent_ids,
      expected_strategy: sc.expected_strategy,
      parsed_intent_id: result.parsed_intent_id,
      parsed_entities: result.parsed_entities,
      parsed_confidence: result.parsed_confidence,
      strategy: result.strategy,
      solve_status: result.solve_status,
      locked_count: result.locked_count,
      modified_count: result.modified_count,
      skipped_rules_count: result.skipped_rules_count,
      frozen_count: result.frozen_count,
      intent_correct: intentCorrect,
      strategy_correct: strategyCorrect,
      constraint_respected: respected,
      regression_failures: regressionFailures,
      cost_usd: result.cost_usd,
      latency_ms,
      current_time_min: cycleCurrentTimeMin,
      warnings: result.warnings.slice(0, 12),
      error_msg: result.error_msg,
      events_seen: result.events_seen,
    };
    cycles.push(cycle);

    const respStr = respected === null ? '-' : respected ? 'YES' : 'NO ';
    const intStr = (result.parsed_intent_id ?? 'null').slice(0, 23).padEnd(23);
    const scStr = sc.id.slice(0, 22).padEnd(22);
    const statusStr = (result.solve_status ?? (result.error_msg ? 'err' : 'unk')).padEnd(10);
    const catStr = sc.category.slice(0, 5).padEnd(5);
    console.log(
      `${String(i).padStart(3)} | ${catStr} | ${scStr} | ${intStr} | ${(result.parsed_confidence ?? '-').padEnd(6)} | ` +
      `${(result.strategy ?? '-').padEnd(5)} | ${statusStr} | ${respStr.padEnd(4)} | $${result.cost_usd.toFixed(5)} | ${latency_ms}ms`,
    );
    if (!intentCorrect) {
      console.log(`    ↳ INTENT MISMATCH: expected one of [${sc.expected_intent_ids.join('|')}] got=${result.parsed_intent_id}`);
    }
    if (strategyCorrect === false) {
      console.log(`    ↳ STRATEGY MISMATCH: expected=${sc.expected_strategy} got=${result.strategy}`);
    }
    if (regressionFailures.length > 0) {
      console.log(`    ↳ REGRESSION FAIL: ${regressionFailures.join('; ')}`);
    }
    if (result.error_msg) {
      console.log(`    ↳ ERROR: ${result.error_msg}`);
    }
  }

  // Aggregates.
  const intentHits = cycles.filter((c) => c.intent_correct).length;
  const intentTotal = cycles.length;
  const strategyScored = cycles.filter((c) => c.strategy_correct !== null);
  const strategyCorrectCount = strategyScored.filter((c) => c.strategy_correct === true).length;
  const verifiable = cycles.filter((c) => c.constraint_respected !== null);
  const respected = verifiable.filter((c) => c.constraint_respected === true).length;
  const violations = verifiable.filter((c) => c.constraint_respected === false).length;
  const errors = cycles.filter((c) => c.error_msg).length;
  const costs = cycles.map((c) => c.cost_usd);
  const latencies = cycles.map((c) => c.latency_ms);
  const meanCost = costs.length > 0 ? costs.reduce((s, v) => s + v, 0) / costs.length : 0;
  const total = costs.reduce((s, v) => s + v, 0);

  // Per-category breakdown (devils 2026-05-22).
  const byCategory: Record<string, { total: number; intent_ok: number; strategy_ok: number }> = {};
  for (const c of cycles) {
    const b = byCategory[c.category] ?? (byCategory[c.category] = { total: 0, intent_ok: 0, strategy_ok: 0 });
    b.total += 1;
    if (c.intent_correct) b.intent_ok += 1;
    if (c.strategy_correct === true) b.strategy_ok += 1;
  }

  // F-W8-08 (devils 2026-05-22): cost p50/p95/p99, not just avg. The
  // tail dominates onboarding cost when Opus cascades fire.
  const costP50 = pct(costs, 50);
  const costP95 = pct(costs, 95);
  const costP99 = pct(costs, 99);

  console.log('\n=== Wave 8 EVALS Summary ===');
  console.log(`Cycles run:          ${cycles.length}/${SCENARIOS.length} (DIVERSE_SLUGS=${DIVERSE_SLUGS ? 'on' : 'off'})`);
  console.log(`Intent correct:      ${intentHits}/${intentTotal} (${((intentHits / intentTotal) * 100).toFixed(0)}%)`);
  console.log(`Strategy correct:    ${strategyCorrectCount}/${strategyScored.length} of scenarios with expected_strategy`);
  console.log(`Respected:           ${respected}/${verifiable.length} verifiable (${verifiable.length > 0 ? ((respected / verifiable.length) * 100).toFixed(0) + '%' : 'n/a'})`);
  console.log(`Violations:          ${violations}/${verifiable.length}`);
  console.log(`Errors:              ${errors}/${cycles.length}`);
  console.log(`Cost mean:           $${meanCost.toFixed(5)}`);
  console.log(`Cost p50/p95/p99:    $${costP50.toFixed(5)} / $${costP95.toFixed(5)} / $${costP99.toFixed(5)}`);
  console.log(`Cost total:          $${total.toFixed(5)}`);
  console.log(`Latency p50/p95/max: ${pct(latencies, 50)}ms / ${pct(latencies, 95)}ms / ${Math.max(...latencies, 0)}ms`);

  console.log('\n=== Per-category breakdown ===');
  for (const [cat, b] of Object.entries(byCategory)) {
    console.log(`  ${cat.padEnd(13)}: intent ${b.intent_ok}/${b.total}, strategy ${b.strategy_ok}/${b.total}`);
  }

  // Targets — F-W8-02 (devils 2026-05-22): the "classified correctly"
  // metric must include correctly classifying out-of-scope/injection as
  // unknown AND not_implemented intents as unsupported. The set-based
  // expected_intent_ids + strategy check capture both axes.
  const targets: Array<{ name: string; pass: boolean; detail: string }> = [];
  targets.push({
    name: 'Intent correct ≥ 80% (12/15)',
    pass: intentHits / intentTotal >= 0.80,
    detail: `${intentHits}/${intentTotal}`,
  });
  targets.push({
    name: 'Strategy correct (when scored) ≥ 80%',
    pass: strategyScored.length === 0 || strategyCorrectCount / strategyScored.length >= 0.80,
    detail: strategyScored.length > 0
      ? `${strategyCorrectCount}/${strategyScored.length}`
      : 'no scored scenarios',
  });
  targets.push({
    name: 'Constraint respected ≥ 87% (of verifiable)',
    pass: verifiable.length === 0 || respected / verifiable.length >= 0.87,
    detail: verifiable.length > 0 ? `${respected}/${verifiable.length}` : 'no verifiable cycles',
  });
  targets.push({
    name: 'Cost per cycle < $0.05',
    pass: meanCost < 0.05,
    detail: `$${meanCost.toFixed(5)}`,
  });
  targets.push({
    name: 'Error rate < 5%',
    pass: errors / cycles.length < 0.05,
    detail: `${errors}/${cycles.length}`,
  });
  targets.push({
    name: 'Total cost within cap',
    pass: total <= COST_CAP_USD,
    detail: `$${total.toFixed(4)} / $${COST_CAP_USD.toFixed(2)}`,
  });
  // F-W8-02 (devils 2026-05-22): the DOUBLE METRIC. Score "catalog-
  // intent identification" on the 10 well-formed scenarios and "unknown
  // identification" on the 5 adversarial scenarios separately. A high
  // overall % that conceals total failure on adversarial inputs would
  // mask the real bias — splitting the metric prevents that.
  const wellFormed = cycles.filter((c) => c.category === 'standard');
  const wellFormedOk = wellFormed.filter((c) => c.intent_correct).length;
  targets.push({
    name: 'Well-formed: catalog-intent classified',
    pass: wellFormed.length === 0 || wellFormedOk / wellFormed.length >= 0.80,
    detail: `${wellFormedOk}/${wellFormed.length}`,
  });
  const adversarial = cycles.filter((c) => c.category === 'adversarial');
  const adversarialOk = adversarial.filter((c) => c.intent_correct).length;
  targets.push({
    name: 'Adversarial: classified as unknown (or fail-soft)',
    pass: adversarial.length === 0 || adversarialOk / adversarial.length >= 0.80,
    detail: `${adversarialOk}/${adversarial.length}`,
  });
  // Regression scenarios are pass/fail per scenario; aggregate as a target.
  const regressionCycles = cycles.filter((c) => c.category === 'regression');
  const regressionPasses = regressionCycles.filter((c) => c.regression_failures.length === 0).length;
  targets.push({
    name: 'All regression scenarios pass',
    pass: regressionCycles.length === 0 || regressionPasses === regressionCycles.length,
    detail: regressionCycles.length > 0
      ? `${regressionPasses}/${regressionCycles.length}`
      : 'no regression scenarios run',
  });

  console.log('\n=== Wave 8 EVALS Targets ===');
  for (const t of targets) {
    console.log(`  ${t.pass ? 'PASS' : 'FAIL'}: ${t.name.padEnd(42)} ${t.detail}`);
  }

  const verdict: 'GO' | 'CONDITIONAL' | 'NO-GO' = targets.every((t) => t.pass)
    ? 'GO'
    : targets.filter((t) => !t.pass).length <= 1
      ? 'CONDITIONAL'
      : 'NO-GO';
  console.log(`\nVerdict (evals): ${verdict}`);

  const out = {
    timestamp: new Date().toISOString(),
    base_url: BASE_URL,
    backend_url: BACKEND_URL,
    slug: SLUG,
    cost_cap_usd: COST_CAP_USD,
    total_scenarios: SCENARIOS.length,
    cycles,
    summary: {
      intent_correct: intentHits,
      intent_total: intentTotal,
      intent_pct: intentTotal > 0 ? intentHits / intentTotal : 0,
      strategy_correct: strategyCorrectCount,
      strategy_scored: strategyScored.length,
      strategy_pct: strategyScored.length > 0 ? strategyCorrectCount / strategyScored.length : 0,
      respected: respected,
      verifiable: verifiable.length,
      violations,
      errors,
      by_category: byCategory,
      cost: { mean: meanCost, total, p50: costP50, p95: costP95, p99: costP99 },
      latency_ms: { p50: pct(latencies, 50), p95: pct(latencies, 95), max: Math.max(...latencies, 0) },
      diverse_slugs: DIVERSE_SLUGS,
      verdict,
      target_results: targets,
    },
  };
  const outPath = join(process.cwd(), 'scripts/wave7-stress-evals-results.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nResults: ${outPath}`);

  // Exit code reflects target pass/fail aggregate (non-zero on FAIL).
  process.exit(targets.every((t) => t.pass) ? 0 : 1);
}

// Safety guard: only auto-run main() when this file is the entry point.
// Without this, `import('./wave7-stress-evals.ts')` from another script
// (e.g. a syntax check) starts a live run and burns Anthropic credit.
const isMainEntry = (() => {
  if (typeof process === 'undefined' || !process.argv?.[1]) return false;
  // process.argv[1] is the resolved script path; import.meta.url is a file URL.
  const argv1 = process.argv[1].replace(/\\/g, '/');
  const meta = typeof import.meta !== 'undefined' && import.meta.url
    ? import.meta.url.replace(/^file:\/\//, '')
    : '';
  return meta === argv1 || argv1.endsWith('/wave7-stress-evals.ts');
})();

if (isMainEntry) {
  main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(2);
  });
}
