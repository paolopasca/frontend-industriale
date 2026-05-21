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
