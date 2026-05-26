import { describe, expect, it } from 'vitest';
import { friendlyErrorMessage, isTransientPanelError } from '../streamingFetch';

/**
 * F-W11-LIVE-02 — verify the explainer/advisor banner translator
 * substitutes raw technical errors with manager-friendly text.
 *
 * The bug: BFF runtime failures (e.g. ANTHROPIC_API_KEY missing on the
 * server) come back as SSE `event: error` payloads with the raw Error
 * message verbatim — that string then leaks into the UI banner and
 * confuses managers (they think THEY have to set a key). The helper
 * substitutes those raw strings; we pin the substitution here.
 */
describe('friendlyErrorMessage', () => {
  it('returns translated copy for rate_limited code (pre-existing behaviour preserved)', () => {
    expect(friendlyErrorMessage({ code: 'rate_limited', message: 'whatever' }))
      .toMatch(/Limite.*richieste/i);
  });

  it('returns translated copy for invalid_body (UI never legitimately hits this — guide manager to retry)', () => {
    expect(friendlyErrorMessage({ code: 'invalid_body', message: 'kpis: Required' }))
      .toMatch(/Richiesta.*non valida/i);
  });

  it('returns translated copy for invalid_json', () => {
    expect(friendlyErrorMessage({ code: 'invalid_json', message: 'Body non e JSON valido.' }))
      .toMatch(/Richiesta.*non valida/i);
  });

  it('returns translated copy for payload_too_large', () => {
    expect(friendlyErrorMessage({ code: 'payload_too_large', message: 'Body massimo 256 KB.' }))
      .toMatch(/troppo grande|supporto/i);
  });

  it('F-W11-LIVE-02 KEY case — explainer_failed with raw ANTHROPIC_API_KEY message returns generic transient-failure copy', () => {
    const result = friendlyErrorMessage({
      code: 'explainer_failed',
      message: 'ANTHROPIC_API_KEY not set (server-only env var)',
    });
    expect(result).toMatch(/Servizio AI.*non disponibile/i);
    // The raw technical string MUST NOT leak into the manager-facing copy.
    expect(result).not.toMatch(/ANTHROPIC_API_KEY/);
    expect(result).not.toMatch(/server-only/);
  });

  it('F-W11-LIVE-02 KEY case — advisor_failed gets the same generic transient-failure copy', () => {
    const result = friendlyErrorMessage({
      code: 'advisor_failed',
      message: 'ANTHROPIC_API_KEY not set (server-only env var)',
    });
    expect(result).toMatch(/Servizio AI.*non disponibile/i);
    expect(result).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it('defence in depth — even WITHOUT explainer_failed code, an ANTHROPIC_API_KEY-flavoured message is intercepted', () => {
    // If a future error path forwards the raw message under a different
    // code, the message-content sniff still catches it before it reaches
    // the manager.
    const result = friendlyErrorMessage({
      code: 'something_else',
      message: 'ANTHROPIC_API_KEY not set',
    });
    expect(result).toMatch(/Servizio AI/i);
    expect(result).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it('returns null for unknown codes with safe messages — caller falls back to raw text', () => {
    expect(friendlyErrorMessage({ code: 'slug_conflict', message: 'Another manager is recomputing.' }))
      .toBeNull();
  });

  it('returns null for empty error object', () => {
    expect(friendlyErrorMessage({})).toBeNull();
  });

  it('handles missing message gracefully', () => {
    expect(friendlyErrorMessage({ code: 'rate_limited' })).toMatch(/Limite/i);
  });

  it('Wave 13 — whatif_failed with raw env leak returns generic transient copy', () => {
    const result = friendlyErrorMessage({
      code: 'whatif_failed',
      message: 'ANTHROPIC_API_KEY not set (server-only env var)',
    });
    expect(result).toMatch(/Servizio AI.*non disponibile/i);
    expect(result).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it('Wave 13 — split_failed gets transient copy regardless of message', () => {
    expect(friendlyErrorMessage({ code: 'split_failed', message: 'random server boom' }))
      .toMatch(/Servizio AI.*non disponibile/i);
  });

  it('Wave 13 — chat_failed gets transient copy', () => {
    expect(friendlyErrorMessage({ code: 'chat_failed', message: 'undefined is not a function' }))
      .toMatch(/Servizio AI.*non disponibile/i);
  });

  it('Wave 13 — apply_whatif_failed gets transient copy', () => {
    expect(friendlyErrorMessage({ code: 'apply_whatif_failed', message: 'internal' }))
      .toMatch(/Servizio AI.*non disponibile/i);
  });

  it('Wave 13 — HTTP 500-ish raw leak returns generic network copy', () => {
    const result = friendlyErrorMessage({ message: 'HTTP 502 Bad Gateway' });
    expect(result).toMatch(/non raggiungibile|riprova/i);
    expect(result).not.toMatch(/502/);
  });

  it('Wave 13 — ECONNREFUSED node error returns generic network copy', () => {
    const result = friendlyErrorMessage({ message: 'connect ECONNREFUSED 127.0.0.1:8000' });
    expect(result).toMatch(/non raggiungibile|riprova/i);
    expect(result).not.toMatch(/ECONNREFUSED/);
  });
});

describe('isTransientPanelError (Wave 16.3 #37)', () => {
  it('classifies BFF SSE error codes (explainer_failed / advisor_failed / etc.) as transient', () => {
    expect(isTransientPanelError({ code: 'explainer_failed', message: 'boom' })).toBe(true);
    expect(isTransientPanelError({ code: 'advisor_failed', message: 'boom' })).toBe(true);
    expect(isTransientPanelError({ code: 'whatif_failed', message: 'boom' })).toBe(true);
    expect(isTransientPanelError({ code: 'split_failed', message: 'boom' })).toBe(true);
    expect(isTransientPanelError({ code: 'chat_failed', message: 'boom' })).toBe(true);
  });

  it('classifies 5xx upstream statuses as transient', () => {
    expect(isTransientPanelError({ status: 502, message: 'Bad Gateway' })).toBe(true);
    expect(isTransientPanelError({ status: 503, message: 'Service Unavailable' })).toBe(true);
    expect(isTransientPanelError({ status: 504, message: 'Gateway Timeout' })).toBe(true);
    expect(isTransientPanelError({ status: 529, message: 'Overloaded' })).toBe(true);
  });

  it('classifies network-leak messages as transient (defence in depth, even if status missing)', () => {
    expect(isTransientPanelError({ message: 'HTTP 503 Service Unavailable' })).toBe(true);
    expect(isTransientPanelError({ message: 'connect ECONNREFUSED 127.0.0.1' })).toBe(true);
    expect(isTransientPanelError({ message: 'fetch failed' })).toBe(true);
    expect(isTransientPanelError({ message: 'request timed out: ETIMEDOUT' })).toBe(true);
  });

  it('classifies permanent failures (4xx, rate-limit, payload size) as NON-transient — caller surfaces immediately', () => {
    expect(isTransientPanelError({ code: 'rate_limited', status: 429, message: 'limit' })).toBe(false);
    expect(isTransientPanelError({ code: 'invalid_body', status: 400, message: 'bad' })).toBe(false);
    expect(isTransientPanelError({ code: 'invalid_json', status: 400, message: 'bad' })).toBe(false);
    expect(isTransientPanelError({ code: 'payload_too_large', status: 413, message: 'big' })).toBe(false);
  });

  it('returns false for empty / unknown errors — conservative default keeps the retry budget for clear transient signals', () => {
    expect(isTransientPanelError({})).toBe(false);
    expect(isTransientPanelError({ message: 'some random unstructured error' })).toBe(false);
  });
});
