import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-W8-S-02 — intent parser whole-day default for "ggN senza ora" inputs
 * (Wave 9 w9-bff-frontend).
 *
 * The system prompt now carries dedicated few-shot examples teaching
 * Haiku that "M05 in panne gg3" (no explicit time) means start_min=2880,
 * end_min=4320 with confidence="medium" and a `whole_day_default_*`
 * fallback_reasoning. Before this fix, the model would either:
 *   - leave end_min empty (router downstream guesses fine orizzonte), or
 *   - default to 0..something narrow,
 * leading to false "machine still scheduled gg3 afternoon" complaints
 * from the manager.
 *
 * These tests pin down:
 *   1. The few-shot examples ARE present in the system prompt sent to
 *      Haiku — verified by inspecting the createMock call args.
 *   2. The expected JSON shape (start_min, end_min, confidence, reasoning)
 *      is faithfully passed through the parser when Haiku returns it.
 *   3. Multiple variants (gg2, gg3, gg4, "domani", "mercoledi") all map
 *      to the whole-day window.
 *
 * The actual classification quality (Haiku obeying the few-shot) is
 * covered by the integration test owned by w9-tester.
 */

const createMock = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    public messages = { create: createMock };
    constructor(_: unknown) {
      void _;
    }
  }
  return { default: FakeAnthropic };
});

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  vi.resetModules();
  createMock.mockReset();
});

afterEach(() => {
  delete process.env.ANTHROPIC_API_KEY;
});

interface FakeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function fakeReply(text: string, usage?: FakeUsage) {
  return {
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: usage?.input_tokens ?? 200,
      output_tokens: usage?.output_tokens ?? 40,
      cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    },
  };
}

describe('B-W8-S-02 — gg N senza ora → whole-day default', () => {
  it('system prompt contains the whole_day_default few-shot block', async () => {
    createMock.mockResolvedValueOnce(
      fakeReply(JSON.stringify({ intent_id: 'unknown', entities: {}, confidence: 'high' })),
    );
    const mod = await import('../intent-parser');
    await mod.parseIntent('placeholder');

    expect(createMock).toHaveBeenCalled();
    const callArgs = createMock.mock.calls[0][0];
    const systemBlocks = callArgs.system as Array<{ text: string }>;
    const systemText = systemBlocks.map((b) => b.text).join('\n');

    // Few-shot block header
    expect(systemText).toMatch(/ESEMPI DI GESTIONE "gg N" SENZA ORA ESPLICITA/);
    // The whole_day_default reasoning marker that classifier outputs
    expect(systemText).toContain('whole_day_default_no_explicit_time');
    // gg3 concrete example (2880-4320)
    expect(systemText).toContain('"start_min":2880');
    expect(systemText).toContain('"end_min":4320');
    // gg2 / "domani" example (1440-2880)
    expect(systemText).toContain('"start_min":1440');
    expect(systemText).toContain('"end_min":2880');
  });

  it('parses "M05 in panne gg3" classification as whole-day machine_unavailability', async () => {
    createMock.mockResolvedValueOnce(
      fakeReply(JSON.stringify({
        intent_id: 'machine_unavailability',
        entities: { machine_id: 'M05', start_min: 2880, end_min: 4320 },
        confidence: 'medium',
        fallback_reasoning: "whole_day_default_no_explicit_time: 'gg3' senza ora → intero giorno",
      })),
    );
    const mod = await import('../intent-parser');
    const r = await mod.parseIntent('M05 in panne gg3, vincolo da consolidare');

    expect(r.intent.intent_id).toBe('machine_unavailability');
    expect(r.intent.entities).toMatchObject({
      machine_id: 'M05',
      start_min: 2880,
      end_min: 4320,
    });
    expect(r.intent.confidence).toBe('medium');
    expect(r.intent.fallback_reasoning).toContain('whole_day_default');
  });

  it('parses "Blocca la M02 mercoledi" as gg3 whole-day window', async () => {
    createMock.mockResolvedValueOnce(
      fakeReply(JSON.stringify({
        intent_id: 'machine_unavailability',
        entities: { machine_id: 'M02', start_min: 2880, end_min: 4320 },
        confidence: 'medium',
        fallback_reasoning: 'whole_day_default_no_explicit_time',
      })),
    );
    const mod = await import('../intent-parser');
    const r = await mod.parseIntent('Blocca la M02 mercoledi');

    expect(r.intent.intent_id).toBe('machine_unavailability');
    expect(r.intent.entities).toMatchObject({
      machine_id: 'M02',
      start_min: 2880,
      end_min: 4320,
    });
    expect(r.intent.confidence).toBe('medium');
  });

  it('parses "M-1 fuori uso domani" as gg2 whole-day window (1440-2880)', async () => {
    createMock.mockResolvedValueOnce(
      fakeReply(JSON.stringify({
        intent_id: 'machine_unavailability',
        entities: { machine_id: 'M-1', start_min: 1440, end_min: 2880 },
        confidence: 'medium',
        fallback_reasoning: "whole_day_default_no_explicit_time: 'domani' = gg2 senza ora",
      })),
    );
    const mod = await import('../intent-parser');
    const r = await mod.parseIntent('M-1 fuori uso domani');

    expect(r.intent.intent_id).toBe('machine_unavailability');
    expect(r.intent.entities).toMatchObject({
      machine_id: 'M-1',
      start_min: 1440,
      end_min: 2880,
    });
    expect(r.intent.confidence).toBe('medium');
  });

  it('preserves whole_day_default reasoning verbatim (not stripped during normalisation)', async () => {
    // The normaliser caps fallback_reasoning at 500 chars; a typical
    // whole_day reasoning is ~80 chars so it must survive intact.
    const reasoning = "whole_day_default_no_explicit_time: 'gg4' senza ora → intero giorno 4 (4320-5760 min)";
    createMock.mockResolvedValueOnce(
      fakeReply(JSON.stringify({
        intent_id: 'machine_unavailability',
        entities: { machine_id: 'M01', start_min: 4320, end_min: 5760 },
        confidence: 'medium',
        fallback_reasoning: reasoning,
      })),
    );
    const mod = await import('../intent-parser');
    const r = await mod.parseIntent('M01 fuori uso gg4');

    expect(r.intent.fallback_reasoning).toBe(reasoning);
    expect(r.intent.fallback_reasoning?.startsWith('whole_day_default')).toBe(true);
  });
});
