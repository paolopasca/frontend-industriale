import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { Lightbulb, RefreshCw, Copy, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { sseStream, friendlyErrorMessage } from '@/lib/streamingFetch';

interface AdvisorPanelProps {
  slug: string | null;
  solution: unknown;
  kpis: Record<string, number>;
  consultationMd?: string;
  dataSchemaMd?: string;
}

interface ChunkPayload { text: string }
interface DonePayload { cost_usd: number; tokens_in: number; tokens_out: number }
interface ErrorPayload { code?: string; message: string }

function makeSig(slug: string | null, solution: unknown, kpis: Record<string, number>): string {
  if (!slug) return '';
  const kpiKeys = Object.keys(kpis).sort();
  const kpiSig = kpiKeys.map((k) => `${k}:${kpis[k]}`).join('|');
  let solSize = 0;
  try { solSize = JSON.stringify(solution ?? null).length; } catch { solSize = -1; }
  return `${slug}::${solSize}::${kpiSig}`;
}

// Split the streamed text into paragraphs. The advisor prompt emits one
// numbered bullet per blank-line-separated block (e.g. "1. 🔧 ..."). We
// detect a leading emoji + space and lift it into a separate <span>.
function splitParagraphs(text: string): Array<{ emoji?: string; body: string }> {
  if (!text.trim()) return [];
  // Pull apart on blank lines (two or more newlines).
  const blocks = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  // Match optional leading numbering "1." or "1)" and an emoji or symbol.
  const emojiRe = /^(\d+[.)]\s*)?([\p{Extended_Pictographic}\p{Emoji_Presentation}]+)\s*/u;
  return blocks.map((block) => {
    const m = block.match(emojiRe);
    if (m) {
      return { emoji: m[2], body: block.slice(m[0].length).trim() };
    }
    return { body: block };
  });
}

export function AdvisorPanel({
  slug,
  solution,
  kpis,
  consultationMd,
  dataSchemaMd,
}: AdvisorPanelProps) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [costUsd, setCostUsd] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const reducedMotion = useReducedMotion();
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const sig = useMemo(() => makeSig(slug, solution, kpis), [slug, solution, kpis]);

  useEffect(() => {
    if (!slug || !solution || Object.keys(kpis).length === 0) {
      setLoading(false);
      setText('');
      setError(null);
      return;
    }

    const controller = new AbortController();
    let aborted = false;

    setText('');
    setError(null);
    setCostUsd(null);
    setLoading(true);

    (async () => {
      try {
        const stream = sseStream<ChunkPayload | DonePayload | ErrorPayload>(
          '/api/advise',
          { slug, solution, kpis, consultationMd, dataSchemaMd },
          controller.signal,
        );

        for await (const { event, data } of stream) {
          if (aborted) break;
          if (event === 'chunk') {
            const t = (data as ChunkPayload).text;
            if (typeof t === 'string') {
              setText((prev) => prev + t);
            }
          } else if (event === 'done') {
            const d = data as DonePayload;
            setCostUsd(typeof d.cost_usd === 'number' ? d.cost_usd : null);
            setLoading(false);
          } else if (event === 'error') {
            const e = data as ErrorPayload;
            setError({ message: e.message ?? 'Errore sconosciuto', code: e.code });
            setLoading(false);
          } else if (event === 'aborted') {
            setLoading(false);
          }
        }
        if (!aborted) setLoading(false);
      } catch (err) {
        if (aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string })?.code;
        if (msg.toLowerCase().includes('abort')) return;
        setError({ message: msg, code });
        setLoading(false);
      }
    })();

    return () => {
      aborted = true;
      controller.abort();
    };
  }, [sig, reloadKey, slug, solution, kpis, consultationMd, dataSchemaMd]);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  const handleRegenerate = () => setReloadKey((k) => k + 1);

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Consigli copiati negli appunti');
    } catch {
      toast.error('Impossibile copiare negli appunti');
    }
  };

  const hasInputs = !!slug && !!solution && Object.keys(kpis).length > 0;
  const paragraphs = useMemo(() => splitParagraphs(text), [text]);

  return (
    <motion.div
      initial={reducedMotion ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.4, delay: reducedMotion ? 0 : 0.1 }}
      className="h-full"
    >
      <Card className="h-full flex flex-col">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <Lightbulb className="w-4 h-4 text-amber-500" />
            <span>Consigli AI</span>
            {costUsd != null && (
              <span className="text-[10px] font-normal text-muted-foreground ml-1">
                · ${costUsd.toFixed(4)}
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRegenerate}
              disabled={loading || !hasInputs}
              className="h-7 px-2 text-xs"
              aria-label="Rigenera consigli"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading && !reducedMotion ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopy}
              disabled={!text || loading}
              className="h-7 px-2 text-xs"
              aria-label="Copia consigli"
            >
              <Copy className="w-3.5 h-3.5" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex-1 p-4 pt-2">
          {!hasInputs ? (
            <p className="text-xs text-muted-foreground italic">
              Pianificazione non ancora disponibile.
            </p>
          ) : error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 p-3 space-y-2"
            >
              <div className="flex items-start gap-2">
                <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
                <div className="flex-1 text-xs">
                  <p className="font-medium text-destructive">
                    Consigli non disponibili
                  </p>
                  <p className="text-muted-foreground mt-1">
                    {friendlyErrorMessage(error) ?? error.message}
                  </p>
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={handleRegenerate} className="text-xs h-7">
                Riprova
              </Button>
            </div>
          ) : (
            <ScrollArea className="h-[360px]">
              <div
                ref={scrollContainerRef}
                aria-live="polite"
                aria-busy={loading}
                className="pr-3"
              >
                {loading && paragraphs.length === 0 && (
                  <div className="space-y-3">
                    <p className="text-xs text-muted-foreground italic mb-3">
                      DAINO AI sta cercando opportunita...
                    </p>
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-10/12" />
                    <Skeleton className="h-3 w-11/12" />
                    <Skeleton className="h-3 w-9/12" />
                  </div>
                )}
                {paragraphs.length > 0 && (
                  <ul className="space-y-3">
                    {paragraphs.map((p, i) => (
                      <li
                        key={i}
                        className="flex gap-2.5 items-start text-sm leading-relaxed text-foreground"
                      >
                        {p.emoji && (
                          <span className="text-base flex-shrink-0 leading-snug" aria-hidden="true">
                            {p.emoji}
                          </span>
                        )}
                        <span className="flex-1 whitespace-pre-wrap">{p.body}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {loading && paragraphs.length > 0 && (
                  <span
                    className={`inline-block w-1.5 h-3.5 bg-primary/70 ml-0.5 mt-2 align-middle ${reducedMotion ? '' : 'animate-pulse'}`}
                    aria-hidden="true"
                  />
                )}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
