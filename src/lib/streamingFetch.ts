/**
 * SSE stream parser for the BFF endpoints (/api/explain, /api/advise).
 * Format produced by the server:
 *   event: chunk\ndata: {"text":"..."}\n\n
 *   event: done\ndata: {"cost_usd":..,"tokens_in":..,"tokens_out":..}\n\n
 *   event: error\ndata: {"code":"..","message":".."}\n\n
 *   event: aborted\ndata: {"reason":".."}\n\n
 *
 * Yields events one by one. Caller is responsible for honoring AbortSignal.
 */
export interface SseEvent<T = unknown> {
  event: string;
  data: T;
}

/**
 * Wave 16.3 #37 — classify whether a panel-level error is transient enough
 * to warrant an automatic client-side retry. Without this, when the BFF
 * surfaces an upstream 503 (Anthropic overloaded) or its own SSE
 * `explainer_failed`/`advisor_failed` event, the manager has to manually
 * hit "Riprova" — even though the next attempt usually works. We hard-list
 * the codes/statuses observed during Wave 16.x stress runs.
 *
 * Conservative on purpose: never retry permanent failures (invalid body,
 * payload too large, auth) — those won't get better and would burn the
 * BFF rate-limit budget.
 */
export function isTransientPanelError(
  err: { code?: string; status?: number; message?: string },
): boolean {
  const code = err.code ?? '';
  const status = err.status ?? 0;
  const message = err.message ?? '';
  // BFF SSE error codes that come from upstream / transient runtime failures.
  if (
    code === 'explainer_failed'
    || code === 'advisor_failed'
    || code === 'whatif_failed'
    || code === 'split_failed'
    || code === 'chat_failed'
  ) {
    return true;
  }
  // HTTP status surfaced by sseStream when the response is !res.ok.
  if (status === 502 || status === 503 || status === 504 || status === 529) {
    return true;
  }
  // Network-layer leaks that survived the friendly translator (defence in depth).
  if (/HTTP\s+5\d\d\b|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(message)) {
    return true;
  }
  // Explicit non-transient cases: rate-limit (won't clear within retry window),
  // invalid input, payload size — caller surfaces immediately.
  return false;
}

/**
 * F-W11-LIVE-02 — translate raw BFF error codes/messages into manager-friendly
 * text for the explainer/advisor/whatif/split/chat banners. Without this, the
 * SSE error event (code: 'explainer_failed' / 'advisor_failed' / 'whatif_failed'
 * / 'split_failed' / 'chat_failed') leaks raw server-side strings like
 * "ANTHROPIC_API_KEY not set (server-only env var)" straight into the UI,
 * which confuses managers (they think THEY have to set a key).
 *
 * Returns null when no translation applies — caller falls back to the raw
 * message. The translator is conservative: it only intervenes when the raw
 * text is a known technical leak or one of the BFF's structured error codes.
 */
export function friendlyErrorMessage(err: { code?: string; message?: string }): string | null {
  const code = err.code ?? '';
  const message = err.message ?? '';
  if (code === 'rate_limited') {
    return 'Limite di richieste superato. Riprova fra qualche minuto.';
  }
  if (code === 'invalid_body' || code === 'invalid_json') {
    return 'Richiesta non valida. Ricarica la pagina e riprova.';
  }
  if (code === 'payload_too_large') {
    return 'Piano troppo grande per essere analizzato. Contatta il supporto.';
  }
  // Server-side runtime failures (LLM client init, network, etc.) come back
  // as code='explainer_failed' / 'advisor_failed' / etc. with the underlying
  // Error message verbatim. Suppress technical strings (API key envvar,
  // stack-y node errors) — show a generic transient-failure message.
  if (
    code === 'explainer_failed'
    || code === 'advisor_failed'
    || code === 'whatif_failed'
    || code === 'split_failed'
    || code === 'chat_failed'
    || code === 'apply_whatif_failed'
    || /ANTHROPIC_API_KEY|server-only env var|process\.env\b/i.test(message)
  ) {
    return 'Servizio AI temporaneamente non disponibile. Riprova fra qualche minuto.';
  }
  // Defence in depth: catch raw HTTP / network leaks that managers should
  // never see.
  if (/HTTP\s+5\d\d\b|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(message)) {
    return 'Servizio temporaneamente non raggiungibile. Riprova fra qualche minuto.';
  }
  return null;
}

export async function* sseStream<T = unknown>(
  url: string,
  body: unknown,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent<T>> {
  const res = await fetch(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    signal,
  });

  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { message?: string; error?: string };
      if (j?.message) message = j.message;
      if (j?.error) code = j.error;
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(message) as Error & { status?: number; code?: string };
    err.status = res.status;
    err.code = code;
    throw err;
  }

  if (!res.body) {
    throw new Error('Stream non disponibile: nessun body nella risposta.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop() ?? '';
      for (const ev of events) {
        if (!ev.trim()) continue;
        const m = ev.match(/^event:\s*(\w+)\s*\ndata:\s*([\s\S]+)$/);
        if (!m) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(m[2]);
        } catch {
          continue;
        }
        yield { event: m[1], data: parsed as T };
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
