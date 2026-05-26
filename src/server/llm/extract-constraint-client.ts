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
  const backendUrl = process.env.VITE_API_BASE_URL || 'http://localhost:8001';
  const secret = process.env.DAINO_INTERNAL_SECRET;

  // Skip the backend extractor if no secret is configured — treats it as a MISS
  // so the caller falls back to Opus. This avoids unauthenticated calls and
  // preserves backward compat with environments that haven't set the secret yet.
  if (!secret) return null;

  try {
    const res = await fetch(`${backendUrl}/api/internal/extract-constraint`, {
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
