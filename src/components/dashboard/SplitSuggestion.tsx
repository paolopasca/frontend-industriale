import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Scissors, Copy, RotateCw, AlertCircle, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { sseStream } from '@/lib/streamingFetch';

interface SplitSuggestionProps {
  slug: string | null;
  solution: unknown;
  kpis: Record<string, number>;
  consultationMd?: string;
  dataSchemaMd?: string;
}

interface ChunkPayload { text: string }
interface DonePayload { cost_usd?: number; tokens_in?: number; tokens_out?: number }
interface ErrorPayload { code?: string; message: string }

interface CommessaCandidate {
  id: string;
  nOps: number;
  durationMin: number;
  machines: string[];
}

function extractCandidates(solution: unknown): CommessaCandidate[] {
  if (!solution || typeof solution !== 'object') return [];
  const fasi: Array<{ commessa?: string; macchina?: string; start_min?: number; end_min?: number; processing_min?: number }> = [];

  const sol = solution as Record<string, unknown>;
  if (Array.isArray(sol.fasi)) {
    fasi.push(...(sol.fasi as typeof fasi));
  } else {
    for (const v of Object.values(sol)) {
      if (v && typeof v === 'object' && Array.isArray((v as { fasi?: unknown }).fasi)) {
        fasi.push(...((v as { fasi: typeof fasi }).fasi));
      }
    }
  }

  const byCommessa = new Map<string, CommessaCandidate>();
  for (const f of fasi) {
    if (!f.commessa) continue;
    const existing = byCommessa.get(f.commessa) ?? { id: f.commessa, nOps: 0, durationMin: 0, machines: [] };
    existing.nOps += 1;
    if (typeof f.end_min === 'number' && typeof f.start_min === 'number') {
      existing.durationMin = Math.max(existing.durationMin, f.end_min);
    } else if (typeof f.processing_min === 'number') {
      existing.durationMin += f.processing_min;
    }
    if (f.macchina && !existing.machines.includes(f.macchina)) existing.machines.push(f.macchina);
    byCommessa.set(f.commessa, existing);
  }
  return [...byCommessa.values()].sort((a, b) => b.nOps - a.nOps);
}

export function SplitSuggestion({
  slug,
  solution,
  kpis,
  consultationMd,
  dataSchemaMd,
}: SplitSuggestionProps) {
  const [selected, setSelected] = useState<string>('');
  const [response, setResponse] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const responseRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  const planReady = !!solution && Object.keys(kpis).length > 0;
  const candidates = useMemo(() => extractCandidates(solution), [solution]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (candidates.length > 0 && !selected) {
      setSelected(candidates[0].id);
    }
  }, [candidates, selected]);

  const runSplit = useCallback(async () => {
    if (!slug || !planReady || streaming || !selected) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setResponse('');
    setError(null);
    setCostUsd(null);
    setStreaming(true);

    try {
      const stream = sseStream<ChunkPayload | DonePayload | ErrorPayload>(
        '/api/split',
        {
          slug,
          commessa: selected,
          solution,
          kpis,
          consultationMd,
          dataSchemaMd,
        },
        controller.signal,
      );
      for await (const { event, data } of stream) {
        if (event === 'chunk') {
          const t = (data as ChunkPayload).text;
          if (typeof t === 'string') setResponse((prev) => prev + t);
        } else if (event === 'done') {
          const d = data as DonePayload;
          if (d.cost_usd != null) setCostUsd(d.cost_usd);
        } else if (event === 'error') {
          const e = data as ErrorPayload;
          throw new Error(e.message ?? 'Errore sconosciuto dal server.');
        }
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setStreaming(false);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error(`Split: ${msg}`);
    }
    setStreaming(false);
    abortRef.current = null;
  }, [slug, selected, solution, kpis, consultationMd, dataSchemaMd, streaming, planReady]);

  const handleCopy = useCallback(() => {
    if (!response) return;
    void navigator.clipboard.writeText(response)
      .then(() => toast.success('Copiato'))
      .catch(() => toast.error('Impossibile copiare'));
  }, [response]);

  if (!planReady || candidates.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Scissors className="h-5 w-5 text-primary" aria-hidden />
          Sotto-commesse
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Seleziona una commessa "grossa" e Opus 4.7 propone una decomposizione su macchine diverse.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2">
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={streaming}
            aria-label="Commessa da decomporre"
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
          >
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id} — {c.nOps} op., {c.durationMin} min, {c.machines.length} macchina/e
              </option>
            ))}
          </select>
          <Button onClick={() => void runSplit()} disabled={streaming || !selected}>
            <Send className="h-3.5 w-3.5 mr-1.5" aria-hidden />
            {streaming ? 'Analisi…' : 'Suggerisci split'}
          </Button>
        </div>

        {(streaming || response || error) && (
          <div
            role="region"
            aria-label={streaming ? 'Analisi split in corso' : 'Proposta di split'}
            aria-live="polite"
            className="rounded-md border bg-muted/20"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <span className="text-xs font-medium">
                {streaming ? '🧠 Opus sta analizzando…' : 'Proposta'}
              </span>
              {!streaming && response && (
                <div className="flex items-center gap-1">
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleCopy} aria-label="Copia">
                    <Copy className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => void runSplit()} aria-label="Rigenera">
                    <RotateCw className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                </div>
              )}
            </div>
            <ScrollArea className="max-h-[480px]">
              <div ref={responseRef} className="p-3 text-sm whitespace-pre-wrap break-words leading-relaxed">
                {response}
                {streaming && !reducedMotion && <span className="ml-0.5 inline-block animate-pulse">▋</span>}
                {error && (
                  <div role="alert" className="mt-2 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2.5">
                    <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" aria-hidden />
                    <span className="text-xs">{error}</span>
                  </div>
                )}
              </div>
            </ScrollArea>
            {!streaming && costUsd != null && (
              <div className="px-3 py-2 border-t text-[10px] text-muted-foreground">
                Costo: ${costUsd.toFixed(4)}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
