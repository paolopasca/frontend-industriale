import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement } from 'react';

vi.mock('@/lib/streamingFetch', () => ({
  sseStream: vi.fn(),
  friendlyErrorMessage: vi.fn(() => 'Errore'),
}));

vi.mock('@/lib/storage', () => ({
  setSlugScoped: vi.fn(),
  removeSlugScoped: vi.fn(),
  getSlugScoped: vi.fn(() => null),
  clearSlugScoped: vi.fn(),
}));

vi.mock('@/data/DashboardContext', () => ({
  useDashboard: vi.fn(() => ({ machines: [], orders: [] })),
}));

vi.mock('@/components/ui/card', () => ({
  Card: ({ children }: { children: React.ReactNode }) => createElement('div', { 'data-testid': 'card' }, children),
  CardContent: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
  CardHeader: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
  CardTitle: ({ children }: { children: React.ReactNode }) => createElement('h3', null, children),
}));

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: React.ReactNode; [k: string]: unknown }) =>
    createElement('button', { type: 'button', ...(props as object) }, children),
}));

vi.mock('@/components/ui/progress', () => ({
  Progress: (props: Record<string, unknown>) => createElement('div', props),
}));

vi.mock('../dashboard/SolutionDiff', () => ({ SolutionDiff: () => null }));
vi.mock('../dashboard/unsupported-reason-labels', () => ({
  humanizeUnsupportedReason: vi.fn(() => ''),
}));

const defaultProps = {
  slug: 'test-slug',
  solution: {},
  kpis: {},
  consultationMd: '',
  dataSchemaMd: '',
};

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * W15-05 — These tests render WhatIfAnalysis and SplitSuggestion into a real
 * DOM and assert that "Opus 4.7" / "Opus sta analizzando" do NOT appear in
 * the rendered output. This guards against the string being reintroduced in
 * JSX (a source-grep test would also catch a dead-code branch or a comment).
 */
describe('W15-05 — Opus 4.7 copy removed from rendered output', () => {
  describe('WhatIfAnalysis', () => {
    it('does not render "Opus 4.7" in visible UI text', async () => {
      const { WhatIfAnalysis } = await import('../dashboard/WhatIfAnalysis');
      const { container } = render(createElement(WhatIfAnalysis, defaultProps));
      expect(container.textContent).not.toMatch(/Opus\s*4\.7/i);
    });

    it('does not render "Opus sta analizzando" in visible UI text', async () => {
      const { WhatIfAnalysis } = await import('../dashboard/WhatIfAnalysis');
      const { container } = render(createElement(WhatIfAnalysis, defaultProps));
      expect(container.textContent).not.toMatch(/Opus\s+sta\s+analizzando/i);
    });
  });

  describe('SplitSuggestion', () => {
    it('does not render "Opus 4.7" in visible UI text', async () => {
      const { SplitSuggestion } = await import('../dashboard/SplitSuggestion');
      const { container } = render(createElement(SplitSuggestion, defaultProps));
      expect(container.textContent).not.toMatch(/Opus\s*4\.7/i);
    });

    it('does not render "Opus sta analizzando" in visible UI text', async () => {
      const { SplitSuggestion } = await import('../dashboard/SplitSuggestion');
      const { container } = render(createElement(SplitSuggestion, defaultProps));
      expect(container.textContent).not.toMatch(/Opus\s+sta\s+analizzando/i);
    });
  });
});
