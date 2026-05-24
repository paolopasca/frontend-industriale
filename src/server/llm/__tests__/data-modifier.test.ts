import { describe, expect, it } from 'vitest';

import { apply, canApply } from '../data-modifier';

describe('data-modifier — canApply', () => {
  it('accepts deadline_change only (machine_unavailability disabled per team-lead 2026-05-22)', () => {
    expect(canApply('deadline_change')).toBe(true);
    expect(canApply('machine_unavailability')).toBe(false);
  });

  it('rejects other intents', () => {
    expect(canApply('order_priority')).toBe(false);
    expect(canApply('capacity_addition')).toBe(false);
    expect(canApply('unknown')).toBe(false);
    expect(canApply('')).toBe(false);
  });
});

describe('data-modifier — machine_unavailability (Strategy A disabled)', () => {
  it('returns modified=false so the router cascades to rule_addition (Strategy B)', () => {
    const r = apply('machine_unavailability', {
      machine_id: 'M-2',
      start_min: 720,
      end_min: 1080,
    });
    expect(r.modified).toBe(false);
    expect(r.dataset_overrides).toBeNull();
    expect(r.rules_fallback).toBeNull();
  });
});

describe('data-modifier — deadline_change', () => {
  it('produces both dataset_overrides and rules_fallback for a single order', () => {
    const r = apply('deadline_change', {
      order_id: 'COM-007',
      new_deadline_min: 2880,
    });
    expect(r.modified).toBe(true);
    expect(r.dataset_overrides).toEqual({
      orders: { 'COM-007': { deadline_min: 2880 } },
    });
    expect(r.rules_fallback).toEqual({
      deadline_changes: { 'COM-007': { new_deadline_min: 2880 } },
    });
  });

  it('refuses missing order_id', () => {
    const r = apply('deadline_change', { new_deadline_min: 2880 });
    expect(r.modified).toBe(false);
    expect(r.dataset_overrides).toBeNull();
    expect(r.rules_fallback).toBeNull();
  });

  it('refuses negative new_deadline_min', () => {
    const r = apply('deadline_change', {
      order_id: 'COM-007',
      new_deadline_min: -10,
    });
    expect(r.modified).toBe(false);
    expect(r.dataset_overrides).toBeNull();
    expect(r.rules_fallback).toBeNull();
  });
});

describe('data-modifier — fallback', () => {
  it('returns no-op for unsupported intent', () => {
    const r = apply('order_priority', { order_id: 'COM-001' });
    expect(r.modified).toBe(false);
    expect(r.dataset_overrides).toBeNull();
    expect(r.rules_fallback).toBeNull();
  });
});
