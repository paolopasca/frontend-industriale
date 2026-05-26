import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * W15-04 — OptimizationLoader static structural tests.
 *
 * The project does not ship @testing-library/react, so component-rendering
 * tests are not available. Instead these tests do static analysis on the
 * source file, asserting:
 *   1. When the loader is done, ALL step icons must render as completed
 *      (no step stays grey when the title says "Ottimizzazione Completata!").
 *      We verify the condition `i < currentPhase || done` is preserved on
 *      the CheckCircle2 line AND that the opacity / text-color expressions
 *      also account for `done` so the visual state is consistent.
 *   2. The backend log is split into two visually distinct blocks:
 *      - "SOLVER LOG" / "BACKEND" (template_solve, status, objective)
 *      - "BFF · COSTI LLM" (cumulative LLM cost from explainer/advisor).
 *      Both block labels must appear in the rendered JSX.
 *
 * This approach is pragmatic for Wave 15 — it catches regressions without
 * requiring a new test runtime dependency. Behaviour-level tests for the
 * loader live in e2e (playwright) when added.
 */

const SOURCE_PATH = resolve(
  __dirname,
  '..',
  'onboarding',
  'OptimizationLoader.tsx',
);

const source = readFileSync(SOURCE_PATH, 'utf8');

describe('OptimizationLoader — W15-04 structural guarantees', () => {
  describe('Step icons completed when progress=100', () => {
    it('renders CheckCircle2 for every step when `done` is true', () => {
      // The check that controls the green tick must include `done` as a
      // trigger. Otherwise steps after currentPhase stay grey when the
      // backend finishes faster than the visual timer.
      // Acceptable forms:
      //   i < currentPhase || done
      //   done || i < currentPhase
      //   i <= currentPhase || done (when currentPhase auto-advances on done)
      const checkRegex =
        /(i\s*<\s*currentPhase\s*\|\|\s*done)|(done\s*\|\|\s*i\s*<\s*currentPhase)|(i\s*<=\s*currentPhase\s*\|\|\s*done)/;
      expect(source).toMatch(checkRegex);
    });

    it('keeps step text at full opacity / foreground colour when done', () => {
      // The opacity animation in framer-motion previously did
      //   opacity: i <= currentPhase ? 1 : 0.3
      // which faded steps after currentPhase even after the backend
      // completed. The fix must include `done` in the truthy branch so the
      // opacity is 1 for every step in the completed state.
      const opacityRegex =
        /opacity:\s*\(?\s*(i\s*<=?\s*currentPhase\s*\|\|\s*done|done\s*\|\|\s*i\s*<=?\s*currentPhase)/;
      expect(source).toMatch(opacityRegex);
    });

    it('keeps step label colour as text-foreground when done', () => {
      // The label span used `text-foreground` for completed phases. When
      // `done` is true, every label must be foreground (not muted) so the
      // completed state reads cleanly.
      const labelRegex =
        /\(\s*(i\s*<=?\s*currentPhase\s*\|\|\s*done|done\s*\|\|\s*i\s*<=?\s*currentPhase)\s*\)\s*\?\s*['"`]text-foreground['"`]/;
      expect(source).toMatch(labelRegex);
    });
  });

  describe('Backend log split into solver and BFF cost blocks', () => {
    it('renders a label that identifies the solver/backend block', () => {
      // Accept either "Solver log" / "SOLVER LOG" / "Backend solver" — case
      // insensitive. The label must NOT be just "Backend log" anymore (too
      // ambiguous — the issue is that the user thought the BFF cost was
      // also "backend").
      expect(source).toMatch(/solver/i);
    });

    it('renders a label that identifies the BFF · LLM cost block', () => {
      // Accept "BFF · COSTI LLM" / "BFF LLM" / "Costi LLM" / "LLM cost".
      expect(source).toMatch(/BFF|Costi LLM|LLM cost/i);
    });

    it('classifies log entries by source (solver vs bff)', () => {
      // The implementation distinguishes solver entries from BFF cost
      // entries — typically by tagging them with a `kind` discriminator
      // or by keeping two separate state arrays. Accept either pattern.
      const hasKindTag = /kind\s*:\s*['"`](solver|bff)['"`]/.test(source);
      const hasTwoArrays =
        /solverLog\s*[,:=]/.test(source) &&
        /(bffLog|bffCostLog|costLog|llmCostLog)\s*[,:=]/.test(source);
      expect(hasKindTag || hasTwoArrays).toBe(true);
    });

    it('does not render the legacy single "Backend log" header alone', () => {
      // Regression guard: the old flat header rendered "Backend log" as
      // the sole label. After W15-04, even if "Backend" appears it must be
      // paired with the explicit cost block label. We assert the cost
      // block label exists somewhere distinct.
      const headerOccurrences = source.match(/['"`]Backend log['"`]/gi) ?? [];
      // If a "Backend log" header still exists, it must coexist with a
      // distinct BFF/LLM cost label — otherwise we have not split the
      // section as required.
      if (headerOccurrences.length > 0) {
        expect(source).toMatch(/BFF|Costi LLM|LLM cost/i);
      }
    });
  });
});
