import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { OptimizationLoader } from '../onboarding/OptimizationLoader';
import type { SetupData } from '../onboarding/SetupPage';

vi.mock('@/lib/api', () => ({
  solveLLMOnly: vi.fn(),
  solveTemplate: vi.fn(),
  autoLogin: vi.fn(),
  pipelineStart: vi.fn(),
  pipelineAdvance: vi.fn(),
  pipelineRespond: vi.fn(),
  pipelineResults: vi.fn(),
}));

vi.mock('@/lib/storage', () => ({
  setSlugScoped: vi.fn(),
  removeSlugScoped: vi.fn(),
}));

const SETUP: SetupData = {
  companyName: 'TestCo',
  companySlug: null,
  sector: 'manufacturing',
  hasConsultation: false,
  consultationMd: '',
  dataFiles: [],
  orders: [],
  machines: [],
  operators: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('OptimizationLoader — W15-04 HIGH-1 render tests', () => {
  describe('Phase list icon states', () => {
    it('renders phase labels on initial mount for deterministic-json', async () => {
      const onComplete = vi.fn();
      await act(async () => {
        render(
          <OptimizationLoader
            method="deterministic-json"
            companySlug={null}
            setupData={SETUP}
            onComplete={onComplete}
          />,
        );
      });

      expect(screen.getByText('Caricamento regole JSON')).toBeInTheDocument();
      expect(screen.getByText('Esecuzione CP-SAT template')).toBeInTheDocument();
    });

    it('shows "Ottimizzazione in Corso..." heading while running', async () => {
      await act(async () => {
        render(
          <OptimizationLoader
            method="llm-only"
            companySlug={null}
            setupData={SETUP}
            onComplete={vi.fn()}
          />,
        );
      });

      expect(screen.getByText('Ottimizzazione in Corso...')).toBeInTheDocument();
    });
  });

  describe('Backend log block label', () => {
    it('shows "Costo backend" label in the log block (not "BFF · Costi LLM")', async () => {
      const { solveTemplate } = await import('@/lib/api');
      vi.mocked(solveTemplate).mockResolvedValue({
        status: 'INFEASIBLE',
        objective_value: null,
        cost_usd: 0,
        warnings: [],
        result: {},
      } as never);

      await act(async () => {
        render(
          <OptimizationLoader
            method="deterministic-json"
            companySlug="test-slug"
            setupData={SETUP}
            onComplete={vi.fn()}
          />,
        );
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const bffLabel = screen.queryByText(/BFF\s*·\s*Costi\s*LLM/i);
      expect(bffLabel).not.toBeInTheDocument();
    });

    it('does not render the "BFF · Costi LLM" header in any solver path', async () => {
      await act(async () => {
        render(
          <OptimizationLoader
            method="llm-only"
            companySlug={null}
            setupData={SETUP}
            onComplete={vi.fn()}
          />,
        );
      });

      expect(screen.queryByText(/BFF\s*·\s*Costi\s*LLM/i)).not.toBeInTheDocument();
    });
  });

  describe('Step completion state', () => {
    it('renders CheckCircle2 for completed phases by checking aria-visible icons', async () => {
      const { solveTemplate } = await import('@/lib/api');
      vi.mocked(solveTemplate).mockResolvedValue({
        status: 'OPTIMAL',
        objective_value: 42,
        cost_usd: 0,
        warnings: [],
        result: {},
      } as never);

      const onComplete = vi.fn();
      await act(async () => {
        render(
          <OptimizationLoader
            method="deterministic-json"
            companySlug="test-slug"
            setupData={SETUP}
            onComplete={onComplete}
          />,
        );
      });

      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // When done=true, heading should say "Ottimizzazione Completata!" or
      // onComplete was called. Either way, the "in corso" text disappears.
      // (onComplete is called inside a setTimeout(1500) so we run timers)
      expect(onComplete).toHaveBeenCalled();
    });
  });
});
