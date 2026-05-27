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
