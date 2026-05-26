import type { SolutionContext } from '@/lib/solutionContext';

export interface ExtractConstraintRequest {
  instruction: string;
  solution_context: SolutionContext;
}

export interface ExtractConstraintResponse {
  result: 'hit' | 'gray_zone' | 'miss';
  confidence: number;
  payload: Record<string, unknown> | null;
  rationale: string;
  pattern_id: string | null;
  confirmation_message: string | null;
}

export async function extractConstraintFromBackend(
  instruction: string,
  context: SolutionContext,
): Promise<ExtractConstraintResponse | null> {
  const secret = process.env.DAINO_INTERNAL_SECRET;
  const backendUrl = process.env.VITE_API_BASE_URL;

  // Skip if no secret — avoids unauthenticated calls and preserves backward compat.
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[extract-constraint] DAINO_INTERNAL_SECRET unset in production — falling back to Opus');
    }
    return null;
  }

  // In production refuse to fall back to localhost — ECONNREFUSED would silently
  // drain cost through Opus on every request. Require explicit VITE_API_BASE_URL.
  if (!backendUrl) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[extract-constraint] VITE_API_BASE_URL unset in production — falling back to Opus');
    }
    return null;
  }

  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, '')}/api/internal/extract-constraint`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'X-Internal-Secret': secret } : {}),
      },
      body: JSON.stringify({ instruction, solution_context: context }),
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      console.warn(`[extract-constraint] backend ${res.status}: ${await res.text().catch(() => '')}`);
      return null;
    }
    return (await res.json()) as ExtractConstraintResponse;
  } catch (err) {
    console.warn(
      `[extract-constraint] error: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
