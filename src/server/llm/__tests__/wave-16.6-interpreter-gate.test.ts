import { describe, it, expect } from 'vitest';
import { interpretToolOutput } from '../instruction-interpreter';
import { buildMachineAliases, type SolutionContext } from '@/lib/solutionContext';

/**
 * Wave 16.6 — deterministic anti-hallucination gate (e2e-tester, task #4).
 *
 * Drives `interpretToolOutput` (the PURE post-Haiku gate, no network) with
 * synthetic tool inputs that mimic what Haiku could emit. This pins the hard
 * contract the live scenario relies on, WITHOUT a live LLM call:
 *
 *   - valid in-set intent ("m2 rotta" → machine_id M02) → HIT/GRAY, payload set.
 *   - off-set target ("M99") flagged via unresolved_target → REJECT, NEVER solves,
 *     NEVER fabricates, carries a clarify message.
 *   - off-set id that somehow lands in the id field (enum bypassed) → REJECT via
 *     the deterministic resolveX gate.
 *   - non-catalog request (intent_id="unknown", e.g. prompt injection) → REJECT.
 *
 * Closed set mirrors the live demo-commesse plan (M01..M05, COM-001..COM-015).
 */

const DEMO_MACHINES = ['M01', 'M02', 'M03', 'M04', 'M05'];
const DEMO_ORDERS = Array.from({ length: 15 }, (_, i) => `COM-${String(i + 1).padStart(3, '0')}`);

function demoCtx(): SolutionContext {
  return {
    machines: DEMO_MACHINES,
    machine_aliases: buildMachineAliases(DEMO_MACHINES),
    orders: DEMO_ORDERS,
    shifts: ['mattina', 'pomeriggio'],
    time_config: { day_length_min: 960, start_date: '2026-04-01' },
    shift_types: { mattina: { start: 0, end: 480 }, pomeriggio: { start: 480, end: 960 } },
    // Provide a horizon so bounds validation has an upper edge.
    order_deadlines: { 'COM-007': 5000 },
  };
}

describe('Wave 16.6 interpreter gate — HIT path (in-set machine resolves)', () => {
  it('"m2 rotta giorno 2" shape → resolves machine_id to M02, builds unavailable_machines', () => {
    // Haiku already mapped the loose "m2" onto the enum value; the gate
    // re-resolves it. We pass "M2" to also prove the deterministic re-resolve
    // (M2 → M02) is a real second line of defence.
    const r = interpretToolOutput(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M2',
        start_min: 960, // giorno 2 (day_length 960)
        confidence: 'high',
      },
      demoCtx(),
    );
    expect(r.result).not.toBe('reject');
    expect(r.intent_id).toBe('machine_unavailability');
    // The canonical machine id MUST be the in-set M02, never the raw "M2".
    expect(r.entities?.machine_id).toBe('M02');
    // Payload must be the canonical rules slot the solver/ledger consume.
    expect(r.payload.unavailable_machines).toBeDefined();
    expect(Object.keys(r.payload.unavailable_machines as object)).toContain('M02');
  });

  it('order_priority "anticipa la commessa 7" shape → resolves COM-007', () => {
    const r = interpretToolOutput(
      { intent_id: 'order_priority', order_ids: ['COM7'], confidence: 'high' },
      demoCtx(),
    );
    expect(r.result).not.toBe('reject');
    expect(r.payload.priority_orders).toEqual(['COM-007']);
  });

  it('an explicit assumption downgrades a high parse to GRAY (confirm before solve)', () => {
    const r = interpretToolOutput(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M02',
        start_min: 0,
        confidence: 'high',
        assumption: 'nessun orario esplicito: blocco da inizio orizzonte',
      },
      demoCtx(),
    );
    expect(r.result).toBe('gray');
    expect(r.confirmation_message).toBeTruthy();
    // Even GRAY must carry a valid payload (the manager confirms, then we solve).
    expect(r.payload.unavailable_machines).toBeDefined();
  });
});

describe('Wave 16.6 interpreter gate — REJECT path (anti-hallucination)', () => {
  it('off-set target via unresolved_target ("M99") → REJECT, empty payload, NEVER fabricates', () => {
    const r = interpretToolOutput(
      {
        intent_id: 'machine_unavailability',
        unresolved_target: 'M99',
        confidence: 'high',
      },
      demoCtx(),
    );
    expect(r.result).toBe('reject');
    expect(r.unresolved_target).toBe('M99');
    // Hard contract: nothing to solve, no invented machine.
    expect(r.payload).toEqual({});
    expect(r.confirmation_message).toMatch(/M99/);
  });

  it('off-set machine_id that bypassed the enum ("M99" in machine_id) → REJECT via deterministic gate', () => {
    // Defence-in-depth: even if the enum failed and Haiku put "M99" straight in
    // machine_id with NO unresolved_target, resolveMachineAlias returns null →
    // the gate rejects rather than passing a non-member to the solver.
    const r = interpretToolOutput(
      {
        intent_id: 'machine_unavailability',
        machine_id: 'M99',
        start_min: 100,
        confidence: 'high',
      },
      demoCtx(),
    );
    expect(r.result).toBe('reject');
    expect(r.payload).toEqual({});
    expect(r.unresolved_target).toBe('M99');
  });

  it('off-set order id in order_priority ("COM-099") → REJECT', () => {
    const r = interpretToolOutput(
      { intent_id: 'order_priority', order_ids: ['COM-099'], confidence: 'high' },
      demoCtx(),
    );
    expect(r.result).toBe('reject');
    expect(r.payload).toEqual({});
  });

  it('non-catalog request (intent_id="unknown", e.g. prompt injection) → REJECT', () => {
    const r = interpretToolOutput(
      { intent_id: 'unknown', confidence: 'high' },
      demoCtx(),
    );
    expect(r.result).toBe('reject');
    expect(r.payload).toEqual({});
    expect(r.confirmation_message).toBeTruthy();
  });

  it('null/garbage tool input → REJECT (never throws, never solves)', () => {
    expect(interpretToolOutput(null, demoCtx()).result).toBe('reject');
    expect(interpretToolOutput({}, demoCtx()).result).toBe('reject');
    // A tool input missing required entities for its intent must also reject.
    const missing = interpretToolOutput(
      { intent_id: 'deadline_change', confidence: 'high' },
      demoCtx(),
    );
    expect(missing.result).toBe('reject');
    expect(missing.payload).toEqual({});
  });

  it('empty closed set (no plan loaded) → any machine token REJECTs', () => {
    const empty: SolutionContext = {
      machines: [], machine_aliases: {}, orders: [], shifts: [],
      time_config: null, shift_types: null, order_deadlines: null,
    };
    const r = interpretToolOutput(
      { intent_id: 'machine_unavailability', machine_id: 'M02', start_min: 0, confidence: 'high' },
      empty,
    );
    expect(r.result).toBe('reject');
  });
});
