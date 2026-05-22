import { useEffect, useRef, useState, useCallback, type KeyboardEvent } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { FlaskConical, Send, Copy, RotateCw, AlertCircle, Lightbulb } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { sseStream } from '@/lib/streamingFetch';

interface WhatIfAnalysisProps {
  slug: string | null;
  solution: unknown;
  kpis: Record<string, number>;
  consultationMd?: string;
  dataSchemaMd?: string;
}

interface ChunkPayload { text: string }
interface DonePayload { cost_usd?: number; tokens_in?: number; tokens_out?: number }
interface ErrorPayload { code?: string; message: string }

const MAX_SCENARIO_CHARS = 2000;

const EXAMPLES = [
  'Posso fermare la linea 2 oggi dalle 14 alle 18 per manutenzione, conviene?',
  'Cosa succede se anticipo COM-007 prima di tutte le altre?',
  'Se aggiungo una macchina M-3 secondaria, quanto recupero sul makespan?',
  'Sposto il turno serale di mercoledì al venerdì: rischio ritardi?',
];

export function WhatIfAnalysis({
  slug,
  solution,
  kpis,
  consultationMd,
  dataSchemaMd,
}: WhatIfAnalysisProps) {
  const [scenario, setScenario] = useState('');
  const [response, setResponse] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const responseRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();

  const planReady = !!solution && Object.keys(kpis).length > 0;
  const tooLong = scenario.length > MAX_SCENARIO_CHARS;
  const tooShort = scenario.trim().length < 5;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [scenario]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const runWhatIf = useCallback(async () => {
    if (!planReady || tooLong || tooShort || streaming || !slug) return;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setResponse('');
    setError(null);
    setCostUsd(null);
    setStreaming(true);

    try {
      const stream = sseStream<ChunkPayload | DonePayload | ErrorPayload>(
        '/api/whatif',
        {
          slug,
          solution,
          kpis,
          consultationMd,
          dataSchemaMd,
          scenario: scenario.trim(),
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
      toast.error(`What-If: ${msg}`);
    }
    setStreaming(false);
    abortRef.current = null;
  }, [slug, solution, kpis, consultationMd, dataSchemaMd, scenario, planReady, tooLong, tooShort, streaming]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void runWhatIf();
    }
  };

  const handleCopy = useCallback(() => {
    if (!response) return;
    void navigator.clipboard.writeText(response)
      .then(() => toast.success('Copiato'))
      .catch(() => toast.error('Impossibile copiare'));
  }, [response]);

  const handleRetry = useCallback(() => {
    void runWhatIf();
  }, [runWhatIf]);

  const sectionAriaLabel = streaming ? 'Analisi in corso' : 'Analisi What-If';

  if (!planReady) {
    return null;
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-5 w-5 text-primary" aria-hidden />
          Analisi What-If
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Scrivi uno scenario in italiano. Opus 4.7 analizza impatti, trade-off e dà una raccomandazione.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <textarea
            ref={textareaRef}
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Esempio: 'Posso fermare la linea 2 oggi dalle 14 alle 18, conviene?'"
            disabled={streaming}
            rows={3}
            maxLength={MAX_SCENARIO_CHARS + 50}
            aria-label="Scenario What-If"
            className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
          />
          <div className="mt-1.5 flex items-center justify-between text-xs">
            <span className={tooLong ? 'text-destructive font-medium' : 'text-muted-foreground'} aria-live="polite">
              {scenario.length}/{MAX_SCENARIO_CHARS}
              {tooLong && ' — troppo lungo'}
            </span>
            <Button
              size="sm"
              onClick={() => void runWhatIf()}
              disabled={streaming || tooLong || tooShort}
            >
              <Send className="h-3.5 w-3.5 mr-1.5" aria-hidden />
              {streaming ? 'Analisi…' : 'Analizza scenario'}
            </Button>
          </div>
        </div>

        {!response && !streaming && !error && (
          <div className="rounded-md border border-dashed bg-muted/30 p-3 space-y-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Lightbulb className="h-3.5 w-3.5" aria-hidden />
              Scenari di esempio
            </div>
            <ul className="text-xs space-y-1">
              {EXAMPLES.map((ex, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => setScenario(ex)}
                    disabled={streaming}
                    className="text-left text-primary hover:underline disabled:opacity-50"
                  >
                    {ex}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {(streaming || response || error) && (
          <div
            role="region"
            aria-label={sectionAriaLabel}
            aria-live="polite"
            className="rounded-md border bg-muted/20"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b">
              <span className="text-xs font-medium">
                {streaming ? '🧠 Opus sta analizzando…' : 'Analisi'}
              </span>
              <div className="flex items-center gap-1">
                {!streaming && response && (
                  <>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleCopy} aria-label="Copia">
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={handleRetry} aria-label="Rigenera">
                      <RotateCw className="h-3.5 w-3.5" aria-hidden />
                    </Button>
                  </>
                )}
              </div>
            </div>
            <ScrollArea className="max-h-[480px]">
              <div ref={responseRef} className="p-3 text-sm whitespace-pre-wrap break-words leading-relaxed">
                {response || (streaming ? '' : '')}
                {streaming && (
                  reducedMotion ? null : <span className="ml-0.5 inline-block animate-pulse">▋</span>
                )}
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

// Default export removed — index.tsx imports the named export.
