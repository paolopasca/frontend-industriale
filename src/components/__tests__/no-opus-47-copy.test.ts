import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * W15-05 — copy obsoleta "Opus 4.7" su What-If e Sotto-commesse.
 *
 * Decisione Paolo 2026-05-26: il constraint-translator (src/server/llm)
 * resta intenzionalmente Opus 4.7 — accuracy critica, costo accettabile.
 * Ma il rame visibile su What-If (alimentato da whatif.ts, Sonnet 4.6) e
 * su SplitSuggestion (alimentato da split.ts, Sonnet 4.6) NON deve più
 * dire "Opus 4.7". Replace generico → "il sistema AI" così non dobbiamo
 * aggiornare ad ogni model swap.
 *
 * Test static-content: garantiamo che la stringa "Opus 4.7" e "Opus sta
 * analizzando" non compaiano in WhatIfAnalysis.tsx né in
 * SplitSuggestion.tsx (file di componente, NON file di backend).
 */

const ROOT = resolve(__dirname, '..');

const FILES_TO_CHECK = [
  resolve(ROOT, 'dashboard', 'WhatIfAnalysis.tsx'),
  resolve(ROOT, 'dashboard', 'SplitSuggestion.tsx'),
];

describe('W15-05 — Opus 4.7 copy removed from user-visible components', () => {
  for (const filePath of FILES_TO_CHECK) {
    const baseName = filePath.split('/').pop() ?? filePath;
    describe(baseName, () => {
      const source = readFileSync(filePath, 'utf8');

      it('does not contain the obsolete "Opus 4.7" copy', () => {
        // The model behind these panels is Sonnet 4.6 since Wave 14.
        // Any literal "Opus 4.7" in the rendered output is a stale label.
        expect(source).not.toMatch(/Opus\s*4\.7/i);
      });

      it('does not contain the legacy "Opus sta analizzando" loader hint', () => {
        // The streaming-in-progress hint was "🧠 Opus sta analizzando…".
        // Replace with a generic AI-system label so future model swaps
        // do not break the copy again.
        expect(source).not.toMatch(/Opus\s+sta\s+analizzando/i);
      });
    });
  }
});
