import { useEffect, useRef, useState, useCallback, type KeyboardEvent } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { MessageCircle, X, Send, Trash2, Bot, User, Wrench, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { sseStream, friendlyErrorMessage } from '@/lib/streamingFetch';
import {
  getSlugScoped,
  setSlugScoped,
  removeSlugScoped,
} from '@/lib/storage';

interface ManagerChatPanelProps {
  slug: string | null;
  solution: unknown;
  kpis: Record<string, number>;
  consultationMd?: string;
  dataSchemaMd?: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolsUsed?: string[];
  costUsd?: number;
}

const STORAGE_KEY = 'manager_chat_messages';
const MAX_HISTORY = 100;
const MAX_MESSAGE_CHARS = 2000;

// timestamp:0 marks the canonical welcome — used to filter it out of API history.
const WELCOME: Message = {
  role: 'assistant',
  content:
    "👋 Ciao! Posso aiutarti con domande sulla pianificazione corrente. Prova: \"Quante commesse sono in ritardo?\", \"Quanto è saturata M-3?\", \"Quale è la prossima scadenza?\"",
  timestamp: 0,
};

function isMessage(x: unknown): x is Message {
  if (!x || typeof x !== 'object') return false;
  const m = x as Record<string, unknown>;
  return (
    (m.role === 'user' || m.role === 'assistant') &&
    typeof m.content === 'string' &&
    typeof m.timestamp === 'number'
  );
}

function loadStored(slug: string | null): Message[] {
  if (!slug) return [WELCOME];
  try {
    const raw = getSlugScoped(STORAGE_KEY, slug);
    if (!raw) return [WELCOME];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return [WELCOME];
    const safe = parsed.filter(isMessage).slice(-MAX_HISTORY);
    return safe.length > 0 ? safe : [WELCOME];
  } catch {
    return [WELCOME];
  }
}

function trimHistoryForApi(messages: Message[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  // Drop welcome (timestamp=0) — UI affordance, not model turn.
  // BFF caps history at 20 turns; send the last 10 to stay well below.
  return messages
    .filter((m) => m.timestamp > 0)
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

interface ChunkPayload { text: string }
interface DonePayload { cost_usd?: number; tokens_in?: number; tokens_out?: number; tools_used?: string[] }
interface ToolUsePayload { name: string; iteration: number }
interface ErrorPayload { code?: string; message: string }
interface AbortedPayload { reason?: string }

export function ManagerChatPanel({
  slug,
  solution,
  kpis,
  consultationMd,
  dataSchemaMd,
}: ManagerChatPanelProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>(() => loadStored(slug));
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [draftAssistant, setDraftAssistant] = useState('');
  const [draftToolsUsed, setDraftToolsUsed] = useState<string[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSentMessage, setLastSentMessage] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();

  const planReady = !!solution && Object.keys(kpis).length > 0;

  useEffect(() => {
    setMessages(loadStored(slug));
    setInput('');
    setDraftAssistant('');
    setDraftToolsUsed([]);
    setLastError(null);
    setLastSentMessage(null);
    setStreaming(false);
    abortRef.current?.abort();
  }, [slug]);

  useEffect(() => {
    if (!slug) return;
    try {
      const toStore = messages.slice(-MAX_HISTORY);
      setSlugScoped(STORAGE_KEY, slug, JSON.stringify(toStore));
    } catch {
      /* quota / private browsing */
    }
  }, [messages, slug]);

  // Auto-scroll only when the user is already near the bottom — avoids
  // yanking them back if they scrolled up to re-read an earlier turn.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [open, messages, draftAssistant, draftToolsUsed, streaming]);

  // Autosize textarea up to ~4 rows.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const max = 4 * 22 + 18; // ~22px per row + padding
    el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  }, [input, open]);

  // Focus the textarea when panel opens.
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => textareaRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, [open]);

  // Esc closes; Tab is trapped inside the panel while open.
  useEffect(() => {
    if (!open) return;
    const handler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        return;
      }
      if (e.key === 'Tab') {
        const panel = panelRef.current;
        if (!panel) return;
        const focusables = panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const runTurn = useCallback(
    async (msg: string, historyBase: Message[]) => {
      if (!slug || !planReady) return;
      setDraftAssistant('');
      setDraftToolsUsed([]);
      setLastError(null);
      setStreaming(true);
      setLastSentMessage(msg);

      const controller = new AbortController();
      abortRef.current?.abort();
      abortRef.current = controller;

      let acc = '';
      const liveTools: string[] = [];
      let costUsd: number | undefined;
      let toolsFinal: string[] = [];
      let serverError: string | null = null;
      let serverErrorCode: string | undefined;
      let aborted = false;

      try {
        const stream = sseStream<
          ChunkPayload | DonePayload | ToolUsePayload | ErrorPayload | AbortedPayload
        >(
          '/api/manager-chat',
          {
            slug,
            solution,
            kpis,
            consultationMd,
            dataSchemaMd,
            message: msg,
            history: trimHistoryForApi(historyBase),
          },
          controller.signal,
        );

        for await (const { event, data } of stream) {
          if (controller.signal.aborted) break;
          if (event === 'chunk') {
            const t = (data as ChunkPayload).text;
            if (typeof t === 'string') {
              acc += t;
              setDraftAssistant(acc);
            }
          } else if (event === 'tool_use') {
            const info = data as ToolUsePayload;
            if (info?.name && !liveTools.includes(info.name)) {
              liveTools.push(info.name);
              setDraftToolsUsed(liveTools.slice());
            }
          } else if (event === 'done') {
            const d = data as DonePayload;
            costUsd = d.cost_usd;
            toolsFinal = d.tools_used ?? liveTools;
          } else if (event === 'aborted') {
            aborted = true;
            break;
          } else if (event === 'error') {
            const payload = data as ErrorPayload;
            serverError = payload.message ?? 'Errore sconosciuto dal server.';
            serverErrorCode = payload.code;
            break;
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          serverError = err instanceof Error ? err.message : String(err);
          serverErrorCode = (err as { code?: string })?.code;
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }

      if (controller.signal.aborted || aborted) {
        setDraftAssistant('');
        setDraftToolsUsed([]);
        setStreaming(false);
        return;
      }

      if (serverError) {
        // Prefer the structured friendly map (handles rate_limited, chat_failed,
        // ANTHROPIC_API_KEY leaks, etc.). Keep the legacy substring fallback
        // as a safety net for older BFF responses that don't surface a code.
        const friendly =
          friendlyErrorMessage({ code: serverErrorCode, message: serverError })
          ?? (/rate.?limit|429/i.test(serverError)
            ? 'Limite richieste/ora superato. Riprova fra qualche minuto.'
            : serverError);
        setLastError(friendly);
        toast.error(`Chat: ${friendly}`);
        setDraftAssistant('');
        setDraftToolsUsed([]);
        setStreaming(false);
        return;
      }

      if (acc.length === 0) {
        setLastError('Nessuna risposta dal server.');
        setDraftAssistant('');
        setDraftToolsUsed([]);
        setStreaming(false);
        return;
      }

      const assistantMsg: Message = {
        role: 'assistant',
        content: acc,
        timestamp: Date.now(),
        toolsUsed: toolsFinal.length > 0 ? toolsFinal : undefined,
        costUsd,
      };
      setMessages((prev) => [...prev, assistantMsg].slice(-MAX_HISTORY));
      setDraftAssistant('');
      setDraftToolsUsed([]);
      setStreaming(false);
      setLastError(null);
      setLastSentMessage(null);
    },
    [slug, planReady, solution, kpis, consultationMd, dataSchemaMd],
  );

  const handleSend = useCallback(async () => {
    const msg = input.trim();
    if (!msg || msg.length > MAX_MESSAGE_CHARS || streaming || !slug || !planReady) return;

    const userMsg: Message = { role: 'user', content: msg, timestamp: Date.now() };
    const updated = [...messages, userMsg].slice(-MAX_HISTORY);
    setMessages(updated);
    setInput('');
    await runTurn(msg, updated);
  }, [input, messages, streaming, slug, planReady, runTurn]);

  const handleRetry = useCallback(async () => {
    if (streaming || !lastSentMessage) return;
    // The user message is still in `messages` — retry sends the same text
    // with the existing history (which already includes that user turn).
    await runTurn(lastSentMessage, messages);
  }, [streaming, lastSentMessage, messages, runTurn]);

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([WELCOME]);
    setDraftAssistant('');
    setDraftToolsUsed([]);
    setLastError(null);
    setLastSentMessage(null);
    setStreaming(false);
    if (slug) {
      try { removeSlugScoped(STORAGE_KEY, slug); } catch { /* noop */ }
    }
  }, [slug]);

  const handleKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const tooLong = input.length > MAX_MESSAGE_CHARS;
  const charsLeftWarning = input.length > 1500;

  return (
    <>
      {!open && (
        <Button
          onClick={() => setOpen(true)}
          disabled={!planReady}
          title={planReady ? 'Apri Chat Manager' : 'Esegui un\'ottimizzazione per attivare la chat'}
          aria-label="Apri Chat Manager"
          className="fixed bottom-6 right-6 z-50 h-14 w-14 rounded-full shadow-lg p-0"
        >
          <MessageCircle className="h-6 w-6" aria-hidden />
        </Button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            ref={panelRef}
            initial={reducedMotion ? false : { opacity: 0, y: 20, scale: 0.95 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.18 }}
            className="fixed bottom-6 right-6 z-50 w-[360px] max-w-[calc(100vw-2rem)] h-[560px] max-h-[calc(100vh-2rem)]"
            role="dialog"
            aria-label="Chat Manager"
            aria-modal="false"
          >
            <Card className="flex flex-col h-full shadow-2xl ring-1 ring-border/50 bg-card/95 backdrop-blur-sm">
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <div className="flex items-center gap-2">
                  <MessageCircle className="h-5 w-5 text-primary" aria-hidden />
                  <h2 className="font-semibold text-sm">Chat Manager</h2>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={handleClear}
                    disabled={streaming}
                    title="Pulisci chat"
                    aria-label="Pulisci chat"
                    className="h-8 w-8"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                  <Button
                    ref={closeButtonRef}
                    size="icon"
                    variant="ghost"
                    onClick={() => setOpen(false)}
                    title="Chiudi"
                    aria-label="Chiudi chat"
                    className="h-8 w-8"
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </Button>
                </div>
              </div>

              <ScrollArea className="flex-1">
                <div
                  ref={scrollRef}
                  role="log"
                  aria-live="polite"
                  aria-atomic="false"
                  aria-busy={streaming}
                  aria-relevant="additions"
                  className="p-4 space-y-3"
                >
                  {messages.map((m, i) => (
                    <ChatBubble key={`${m.timestamp}-${i}`} message={m} />
                  ))}
                  {streaming && (
                    <StreamingBubble
                      text={draftAssistant}
                      tools={draftToolsUsed}
                      reducedMotion={!!reducedMotion}
                    />
                  )}
                  {!streaming && lastError && (
                    <div
                      role="alert"
                      className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 flex items-start gap-2"
                    >
                      <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" aria-hidden />
                      <div className="text-xs flex-1 min-w-0">
                        <p className="font-medium text-destructive">Errore</p>
                        <p className="text-muted-foreground mt-0.5 break-words">{lastError}</p>
                        {lastSentMessage && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void handleRetry()}
                            className="text-xs h-6 mt-2"
                          >
                            Riprova
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </ScrollArea>

              <form
                onSubmit={(e) => { e.preventDefault(); void handleSend(); }}
                className="border-t p-3 space-y-2"
              >
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKey}
                  disabled={streaming || !planReady}
                  placeholder={
                    planReady
                      ? 'Scrivi una domanda… (Enter per inviare, Shift+Enter per a capo)'
                      : 'Esegui un\'ottimizzazione prima.'
                  }
                  rows={1}
                  maxLength={MAX_MESSAGE_CHARS + 200}
                  aria-label="Messaggio per il Chat Manager"
                  className="w-full resize-none rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60"
                />
                <div className="flex items-center justify-between gap-2">
                  {(charsLeftWarning || tooLong) ? (
                    <span
                      className={`text-xs ${tooLong ? 'text-destructive font-medium' : 'text-amber-600'}`}
                      aria-live="polite"
                    >
                      {input.length}/{MAX_MESSAGE_CHARS}
                      {tooLong && ' — troppo lungo'}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">&nbsp;</span>
                  )}
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!input.trim() || tooLong || streaming || !planReady}
                    aria-label="Invia messaggio"
                  >
                    <Send className="h-3.5 w-3.5 mr-1.5" aria-hidden />
                    Invia
                  </Button>
                </div>
              </form>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function StreamingBubble({
  text,
  tools,
  reducedMotion,
}: {
  text: string;
  tools: string[];
  reducedMotion: boolean;
}) {
  const empty = text.length === 0;
  const status = tools.length > 0 ? 'DAINO sta cercando' : 'DAINO sta scrivendo';
  return (
    <div className="flex gap-2 flex-row">
      <div
        className="shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs bg-muted"
        aria-hidden
      >
        <Bot className="h-4 w-4" />
      </div>
      <div className="flex-1 text-left max-w-[85%]">
        <div className="inline-block rounded-lg px-3 py-2 text-sm bg-muted whitespace-pre-wrap break-words">
          {empty ? (
            <span className="text-muted-foreground italic inline-flex items-center gap-1">
              {status}
              <TypingDots reducedMotion={reducedMotion} />
            </span>
          ) : (
            <>
              {text}
              <span
                className={`ml-0.5 inline-block w-1.5 h-3.5 bg-primary/70 align-middle ${reducedMotion ? '' : 'animate-pulse'}`}
                aria-hidden
              />
            </>
          )}
        </div>
        {tools.length > 0 && (
          <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Wrench className="h-3 w-3" aria-hidden />
            <span className="truncate">usando: {tools.join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TypingDots({ reducedMotion }: { reducedMotion: boolean }) {
  if (reducedMotion) return <span>…</span>;
  return (
    <span className="inline-flex gap-0.5" aria-hidden>
      <span className="w-1 h-1 rounded-full bg-current animate-pulse" style={{ animationDelay: '0ms' }} />
      <span className="w-1 h-1 rounded-full bg-current animate-pulse" style={{ animationDelay: '150ms' }} />
      <span className="w-1 h-1 rounded-full bg-current animate-pulse" style={{ animationDelay: '300ms' }} />
    </span>
  );
}

function ChatBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <div className={`flex gap-2 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}>
      <div
        className={`shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-xs ${isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
        aria-hidden
      >
        {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
      </div>
      <div className={`flex-1 ${isUser ? 'text-right' : 'text-left'} max-w-[85%]`}>
        <div
          className={`inline-block rounded-lg px-3 py-2 text-sm ${isUser ? 'bg-primary text-primary-foreground' : 'bg-muted'} whitespace-pre-wrap break-words`}
        >
          {message.content}
        </div>
        {message.toolsUsed && message.toolsUsed.length > 0 && (
          <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
            <Wrench className="h-3 w-3" aria-hidden />
            <span className="truncate">ha usato: {message.toolsUsed.join(', ')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
