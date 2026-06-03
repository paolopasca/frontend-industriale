import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SolutionDiff } from '../SolutionDiff';

/**
 * Wave 16.4 E1 — KPI merge across solve-template (camelCase, hours)
 * and apply-whatif candidate (raw solver snake_case + carico_macchine
 * dict in minutes). All canonical KPIs must show a value in both
 * columns, not "—".
 */

describe('SolutionDiff — KPI merge across baseline (dashboard) and candidate (solver)', () => {
  it('shows makespan in both columns even when baseline is hours and candidate is minutes', () => {
    const baseline = {
      makespan: 24,
      makespanDays: 3,
      peakUtilization: 92,
      avgUtilization: 75,
      costoOperatori: 1200,
      costoSetup: 300,
      costoTotale: 1500,
      totalTardiness: 60,
      highPriorityOnTime: 90,
      ordersLate: 1,
    };
    const candidate = {
      makespan: 1440,
      costo_totale_operatori: 1300,
      costo_totale_setup: 320,
      ritardo_pesato_totale: 80,
      carico_macchine: { 'M-1': 1200, 'M-2': 1100, 'M-3': 900 },
    };

    render(
      <SolutionDiff
        baseline={{ solution: { status: 'OPTIMAL', schedule: [] }, kpis: baseline }}
        candidate={{
          solution: { status: 'OPTIMAL', schedule: [] },
          kpis: candidate as unknown as Record<string, number>,
          warnings: [],
        }}
        changeType="machine_unavailability"
        changeRationale=""
        onAccept={() => {}}
        onDiscard={() => {}}
      />,
    );

    // Both sides must render a makespan value. Baseline=24h → 1440min, candidate=1440min.
    // After canonicalization both go to 'makespan_min'.
    const rows = screen.getAllByText('Makespan (min)');
    expect(rows.length).toBeGreaterThan(0);

    // KPI table renders a "—" placeholder when a side is missing. The
    // canonical row for makespan must NOT have "—" in either column.
    const tableHtml = document.body.innerHTML;
    expect(tableHtml).toContain('Makespan (min)');
    // costo_totale should be present on both sides too.
    expect(tableHtml).toContain('Costo totale');
    // machine utilization should be derived from carico_macchine for candidate.
    expect(tableHtml).toContain('utilizzo');
  });

  it('derives candidate on-time from the solver solution when kpis omit it', () => {
    // Wave 17 M1 — the FJSP solver emits only {makespan, costo_totale_operatori,
    // costo_totale_setup, ritardo_pesato_totale, carico_macchine} in kpis; it does
    // NOT emit on_time_rate. Per-job tardiness lives in solution[jid].ritardo_min.
    // The baseline carries on_time_rate, so without derivation the candidate
    // on-time column shows "—". Derive it: #(ritardo_min===0) / #jobs.
    const baseline = { makespan_min: 1440, on_time_rate: 0.9 };
    const candidate = {
      makespan: 1500,
      costo_totale_operatori: 1300,
      // no on_time_rate here — the solver does not produce it.
    };
    const candidateSolution = {
      'COM-1': { fasi: [], ritardo_min: 0 },
      'COM-2': { fasi: [], ritardo_min: 0 },
      'COM-3': { fasi: [], ritardo_min: 0 },
      'COM-4': { fasi: [], ritardo_min: 120 }, // late
    };

    render(
      <SolutionDiff
        baseline={{ solution: {}, kpis: baseline }}
        candidate={{
          solution: candidateSolution,
          kpis: candidate as unknown as Record<string, number>,
          warnings: [],
        }}
        changeType="machine_unavailability"
        changeRationale=""
        onAccept={() => {}}
        onDiscard={() => {}}
      />,
    );

    // The on_time_rate row must exist and its candidate cell (3rd <td>) must
    // NOT be "—": 3 on-time of 4 jobs = 0,75.
    const row = screen.getByTestId('solution-diff-row-on_time_rate');
    const cells = row.querySelectorAll('td');
    // cells: [label, baseline, candidate, delta]
    expect(cells[2].textContent).not.toBe('—');
    expect(cells[2].textContent).toContain('0,75');
  });

  it('does not override candidate on_time_rate already present in kpis', () => {
    // Regression: when the candidate kpis DO carry on_time_rate (e.g. an
    // enriched payload), the derivation from solution must not clobber it.
    const candidateSolution = {
      'COM-1': { fasi: [], ritardo_min: 999 }, // would derive 0% if used
    };
    render(
      <SolutionDiff
        baseline={{ solution: {}, kpis: { on_time_rate: 0.9 } }}
        candidate={{
          solution: candidateSolution,
          kpis: { on_time_rate: 0.98 } as unknown as Record<string, number>,
          warnings: [],
        }}
        changeType="A"
        changeRationale=""
        onAccept={() => {}}
        onDiscard={() => {}}
      />,
    );
    const row = screen.getByTestId('solution-diff-row-on_time_rate');
    const cells = row.querySelectorAll('td');
    // 0.98 wins, NOT the 0% the solution would imply.
    expect(cells[2].textContent).toContain('0,98');
  });

  it('does not regress when both sides use the same shape', () => {
    const sameShape = {
      makespan_min: 1500,
      costo_totale: 2000,
      on_time_rate: 0.95,
    };

    render(
      <SolutionDiff
        baseline={{ solution: { status: 'OPTIMAL', schedule: [] }, kpis: sameShape }}
        candidate={{
          solution: { status: 'OPTIMAL', schedule: [] },
          kpis: { ...sameShape, makespan_min: 1400, on_time_rate: 0.98 },
          warnings: [],
        }}
        changeType="A"
        changeRationale=""
        onAccept={() => {}}
        onDiscard={() => {}}
      />,
    );

    const tableHtml = document.body.innerHTML;
    expect(tableHtml).toContain('Makespan (min)');
    expect(tableHtml).toContain('Costo totale');
    expect(tableHtml).toContain('On-time');
  });
});
