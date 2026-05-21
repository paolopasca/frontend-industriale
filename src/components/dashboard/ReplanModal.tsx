import { useState, useRef, useEffect } from 'react';
import { X, Send, Loader2, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { chatReschedule, autoLogin, type ChatRescheduleResponse } from '@/lib/api';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  action?: ChatRescheduleResponse['action'];
}

const STORAGE_KEY = 'replan_chat_messages';
const WELCOME: Message = {
  id: 'welcome',
  role: 'assistant',
  content:
    "Ciao! Scrivimi cosa è cambiato e ricalcolo il piano. Esempi:\n• \"Macchina M1 è rotta\"\n• \"Operatore W2 malato oggi\"\n• \"Stato attuale\"",
  timestamp: Date.now(),
};

function loadStored(): Message[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Message[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // ignore
  }
  return [WELCOME];
}

function actionBadge(a?: ChatRescheduleResponse['action']): { label: string; color: string } | null {
  switch (a) {
    case 'reschedule':
      return { label: '🔄 Piano aggiornato', color: 'bg-green-500/15 text-green-700 dark:text-green-400' };
    case 'data_query':
      return { label: '📊 Stato', color: 'bg-blue-500/15 text-blue-700 dark:text-blue-400' };
    case 'infeasible':
      return { label: '⚠️ Infeasible', color: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' };
    case 'clarification':
      return { label: '❓ Chiarimento', color: 'bg-gray-500/15 text-gray-700 dark:text-gray-400' };
    case 'error':
      return { label: '❌ Errore', color: 'bg-red-500/15 text-red-700 dark:text-red-400' };
    default:
      return null;
  }
}

export function ReplanModal({
  open,
  onClose,
  companySlug,
  onResult,
}: {
  open: boolean;
  onClose: () => void;
  companySlug: string | null;
  onResult?: (result: unknown) => void;
}) {
  const [messages, setMessages] = useState<Message[]>(loadStored);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 80);
    }
  }, [open]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, busy]);

  const handleClear = () => {
    setMessages([WELCOME]);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!companySlug) {
      setMessages(prev => [
        ...prev,
        { id: `${Date.now()}-u`, role: 'user', content: text, timestamp: Date.now() },
        {
          id: `${Date.now()}-a`,
          role: 'assistant',
          content: 'Nessuna azienda selezionata — la chat richiede uno slug.',
          timestamp: Date.now(),
          action: 'error',
        },
      ]);
      setInput('');
      return;
    }

    const userMsg: Message = { id: `${Date.now()}-u`, role: 'user', content: text, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setBusy(true);

    try {
      // The new /api/analysis/{sid}/reschedule endpoint is authenticated.
      // Re-auth as the demo tenant (no-op if already logged in) before
      // calling, and pull the session/run IDs persisted by the loader.
      await autoLogin(companySlug);
      const sessionId = localStorage.getItem('daino_last_session_id');
      const runIdRaw = localStorage.getItem('daino_last_run_id');
      const runId = runIdRaw ? Number(runIdRaw) : null;
      const res = await chatReschedule({
        message: text,
        sessionId,
        runId: Number.isFinite(runId) ? runId : null,
      });
      const assistantMsg: Message = {
        id: `${Date.now()}-a`,
        role: 'assistant',
        content: res.reply,
        timestamp: Date.now(),
        action: res.action,
      };
      setMessages(prev => [...prev, assistantMsg]);

      if (res.action === 'reschedule' && onResult) {
        // Shape matches /api/public/solve-template so adaptResult works.
        onResult({
          status: res.status,
          method: 'deterministic-template',
          solution: res.solution ?? {},
          kpis: res.kpis ?? {},
          objective_value: res.objective_value,
          warnings: res.warnings ?? [],
          cost_usd: res.cost_usd ?? 0,
          rules_used: res.rules_used,
          time_config: res.time_config,
          maintenance: res.maintenance,
          operator_config: res.operator_config,
          shift_types: res.shift_types,
          cp_sat_stats: res.cp_sat_stats,
          warm_start: res.warm_start,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Errore di rete';
      setMessages(prev => [
        ...prev,
        { id: `${Date.now()}-e`, role: 'assistant', content: msg, timestamp: Date.now(), action: 'error' },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 12 }}
            className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg h-[560px] rounded-xl border border-border bg-card shadow-2xl flex flex-col overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-3 border-b border-border">
              <div>
                <h2 className="text-base font-bold text-foreground">Ripianifica</h2>
                <p className="text-[11px] text-muted-foreground">
                  Warm-start • {companySlug ?? 'nessuna azienda'}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleClear}
                  title="Pulisci conversazione"
                  className="p-1.5 rounded-md hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
                <button onClick={onClose} className="p-1.5 rounded-md hover:bg-accent transition-colors">
                  <X className="w-4 h-4 text-muted-foreground" />
                </button>
              </div>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
              {messages.map(m => {
                const badge = m.role === 'assistant' ? actionBadge(m.action) : null;
                return (
                  <div key={m.id} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
                    <div
                      className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
                        m.role === 'user'
                          ? 'bg-primary text-primary-foreground rounded-br-sm'
                          : 'bg-accent/70 text-foreground rounded-bl-sm'
                      }`}
                    >
                      {m.content}
                    </div>
                    {badge && (
                      <span className={`mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${badge.color}`}>
                        {badge.label}
                      </span>
                    )}
                  </div>
                );
              })}
              {busy && (
                <div className="flex items-start">
                  <div className="bg-accent/70 rounded-xl px-3 py-2 rounded-bl-sm flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">Ricalcolo in corso…</span>
                  </div>
                </div>
              )}
            </div>

            <form
              onSubmit={e => {
                e.preventDefault();
                handleSend();
              }}
              className="border-t border-border p-3 flex items-end gap-2"
            >
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder='Es: "macchina M1 è rotta, risolvi"'
                rows={2}
                disabled={busy}
                className="flex-1 rounded-lg bg-input border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" />
                Invia
              </button>
            </form>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
