import { useState, useRef, useEffect } from 'react';
import { X, Send, Loader2, Trash2, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { chatReschedule, autoLogin, type ChatRescheduleResponse } from '@/lib/api';
import type { SolverMethod } from '@/components/onboarding/SolverMethodSelect';
import { getSlugScoped, setSlugScoped, migrateLegacyKeys } from '@/lib/storage';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  action?: ChatRescheduleResponse['action'];
  // Wave 16.4 C4 — when chatReschedule fails with session_not_found we
  // offer an inline fallback button that re-solves from scratch using
  // the manager utterance the message was paired with.
  freshFallbackText?: string;
}

const STORAGE_KEY_BASE = 'replan_chat_messages';
const SESSION_KEY = 'daino_last_session_id';
const RUN_KEY = 'daino_last_run_id';
const WELCOME: Message = {
  id: 'welcome',
  role: 'assistant',
  content:
    "Ciao! Scrivimi cosa è cambiato e ricalcolo il piano. Esempi:\n• \"Macchina M1 è rotta\"\n• \"Operatore W2 malato oggi\"\n• \"Stato attuale\"",
  timestamp: Date.now(),
};

function loadStored(slug: string | null): Message[] {
  if (!slug) return [WELCOME];
  try {
    const raw = getSlugScoped(STORAGE_KEY_BASE, slug);
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
  originalSolution,
  solverMethod,
  onResult,
}: {
  open: boolean;
  onClose: () => void;
  companySlug: string | null;
  // Wave 16.4 HIGH-3 (devil-advocate fix-then-merge) — pass the baseline
  // solution so /api/reschedule-fresh can build a non-empty
  // SolutionContext. Without it the BE extractor sees empty
  // operators/machines/orders and every entity-referencing utterance
  // collapses to MISS/GRAY-sentinel, killing the HIT path.
  originalSolution?: unknown;
  // Wave 16.5 B1 — the active solver method decides the reschedule path.
  // deterministic-template plans (deterministic-json / llm-only) cannot use
  // the authenticated warm-start endpoint (it needs a generated_code artifact
  // they never emit, TD-022 → "Run not found"), so they go straight to the
  // fresh-solve route. Only codegen-pipeline keeps the warm-start chat path.
  solverMethod?: SolverMethod | null;
  onResult?: (result: unknown) => void;
}) {
  const [messages, setMessages] = useState<Message[]>(() => loadStored(companySlug));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // Wave 16.5 B1 — the fresh cold solve (~25 s) gets its own progress label
  // so the manager knows the longer wait is expected, not a hang.
  const [busyLabel, setBusyLabel] = useState('Ricalcolo in corso…');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // The product runs deterministic-template (deterministic-json / llm-only)
  // by default. Those plans have no functional warm-start handle, so the
  // fresh-solve route is the primary path. codegen-pipeline keeps warm-start.
  const usesFreshSolve = solverMethod !== 'codegen-pipeline';

  useEffect(() => {
    migrateLegacyKeys();
  }, []);

  useEffect(() => {
    setMessages(loadStored(companySlug));
  }, [companySlug]);

  useEffect(() => {
    if (!companySlug) return;
    setSlugScoped(STORAGE_KEY_BASE, companySlug, JSON.stringify(messages));
  }, [messages, companySlug]);

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

    // Wave 16.5 B1 — deterministic-template plans go straight to the fresh
    // cold solve. The warm-start chat endpoint needs a generated_code
    // artifact these plans never produce, so it always answers "Run not
    // found". codegen-pipeline keeps the warm-start path below.
    if (usesFreshSolve) {
      const userMsg: Message = { id: `${Date.now()}-u`, role: 'user', content: text, timestamp: Date.now() };
      setMessages(prev => [...prev, userMsg]);
      setInput('');
      await runFreshReschedule(text);
      return;
    }

    const userMsg: Message = { id: `${Date.now()}-u`, role: 'user', content: text, timestamp: Date.now() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setBusy(true);
    setBusyLabel('Ricalcolo in corso…');

    try {
      // The /api/analysis/{sid}/reschedule endpoint is authenticated.
      // autoLogin always re-issues POST /api/auth/login — see uploadData()
      // in api.ts for why a token-presence gate is incorrect here.
      await autoLogin(companySlug);
      const sessionId = getSlugScoped(SESSION_KEY, companySlug);
      const runIdRaw = getSlugScoped(RUN_KEY, companySlug);
      const runId = runIdRaw ? Number(runIdRaw) : null;
      const res = await chatReschedule({
        message: text,
        sessionId,
        runId: Number.isFinite(runId) && (runId ?? 0) > 0 ? runId : null,
      });
      // Wave 16.4 C4 / Wave 16.5 B2 — when the warm-start path cannot find
      // the session/run, attach a fresh-fallback hint so the user can opt
      // into the ~25 s cold solve. Broadened to include the backend's
      // "Run not found" wording (B2) so the codegen-pipeline path degrades
      // to the fresh fallback instead of dead-ending on a raw error.
      const replyLower = res.reply.toLowerCase();
      const isSessionNotFound =
        res.action === 'error'
        && (
          res.reply.includes('Sessione non trovata')
          || replyLower.includes('session_not_found')
          || res.reply.includes('Reschedule non disponibile')
          || replyLower.includes('run not found')
          || replyLower.includes('run_not_found')
        );
      const assistantMsg: Message = {
        id: `${Date.now()}-a`,
        role: 'assistant',
        content: res.reply,
        timestamp: Date.now(),
        action: res.action,
        freshFallbackText: isSessionNotFound ? text : undefined,
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

  // Wave 16.5 B1 — fresh cold solve. Primary path for deterministic-template
  // plans (see usesFreshSolve) and the Wave 16.4 C4 fallback button for the
  // warm-start path. Re-solves from scratch using the manager's free-text
  // disruption: freeze the schedule up to the cutoff, then replan the rest.
  // Slower (~25 s) but never depends on a warm-start session/run handle.
  //
  // Assumes the user message was already appended by the caller (handleSend
  // adds it before branching; the fallback button adds its own framing).
  const runFreshReschedule = async (originalText: string) => {
    if (!companySlug) {
      setMessages(prev => [
        ...prev,
        {
          id: `${Date.now()}-fa`,
          role: 'assistant',
          content: 'Nessuna azienda selezionata — impossibile ricalcolare il piano.',
          timestamp: Date.now(),
          action: 'error',
        },
      ]);
      return;
    }
    setBusy(true);
    setBusyLabel('Ricalcolo completo del piano… (~25 s)');
    try {
      const res = await fetch('/api/reschedule-fresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slug: companySlug,
          message: originalText,
          // Wave 16.4 HIGH-3 / Wave 16.5 B3 — thread the baseline so the BFF
          // can build a non-empty SolutionContext (machines, machine_aliases,
          // orders) for the extractor and a frozen-window from the baseline
          // phases. Without it the HIT path and the freeze both collapse.
          baselineSolution: originalSolution,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`reschedule-fresh HTTP ${res.status}: ${text}`);
      }
      const payload = await res.json() as {
        ok: boolean;
        code?: string;
        rationale?: string;
        confirmationMessage?: string;
        result?: {
          status: string;
          method: string;
          solution: Record<string, unknown>;
          kpis: Record<string, number>;
          objective_value: number | null;
          warnings: string[];
          cost_usd: number;
        };
      };
      if (!payload.ok || !payload.result) {
        // gray_zone carries a confirmation prompt; miss carries a rationale.
        const detail = payload.confirmationMessage ?? payload.rationale ?? payload.code ?? 'estrazione vincolo fallita';
        setMessages(prev => [
          ...prev,
          {
            id: `${Date.now()}-fa`,
            role: 'assistant',
            content: `Non sono riuscito a ricalcolare il piano: ${detail}. Riformula la richiesta in modo piu specifico (es. "Macchina M1 ferma oggi").`,
            timestamp: Date.now(),
            action: payload.code === 'extract_gray_zone' ? 'clarification' : 'error',
          },
        ]);
        return;
      }
      const r = payload.result;
      setMessages(prev => [
        ...prev,
        {
          id: `${Date.now()}-fa`,
          role: 'assistant',
          content: `Piano ricalcolato. Stato: ${r.status}.`,
          timestamp: Date.now(),
          action: 'reschedule',
        },
      ]);
      if (onResult) {
        onResult({
          status: r.status,
          method: r.method,
          solution: r.solution,
          kpis: r.kpis,
          objective_value: r.objective_value,
          warnings: r.warnings,
          cost_usd: r.cost_usd,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Errore di rete';
      setMessages(prev => [
        ...prev,
        { id: `${Date.now()}-fe`, role: 'assistant', content: `Errore ricalcolo del piano: ${msg}`, timestamp: Date.now(), action: 'error' },
      ]);
    } finally {
      setBusy(false);
    }
  };

  // Wave 16.4 C4 fallback button — adds its own "Ricalcolo da zero" framing
  // message, then delegates to the shared fresh-solve routine.
  const handleFreshReschedule = async (originalText: string) => {
    if (busy) return;
    setMessages(prev => [
      ...prev,
      {
        id: `${Date.now()}-fu`,
        role: 'user',
        content: `Ricalcolo da zero con: "${originalText}"`,
        timestamp: Date.now(),
      },
    ]);
    await runFreshReschedule(originalText);
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
                  {usesFreshSolve ? 'Ricalcolo completo' : 'Warm-start'} • {companySlug ?? 'nessuna azienda'}
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
                    {m.freshFallbackText && (
                      <button
                        type="button"
                        onClick={() => handleFreshReschedule(m.freshFallbackText!)}
                        disabled={busy}
                        data-testid="replan-fresh-fallback"
                        className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-primary/10 hover:bg-primary/20 text-primary text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Ricalcola da zero (~25 s)
                      </button>
                    )}
                  </div>
                );
              })}
              {busy && (
                <div className="flex items-start">
                  <div className="bg-accent/70 rounded-xl px-3 py-2 rounded-bl-sm flex items-center gap-2">
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                    <span className="text-xs text-muted-foreground">{busyLabel}</span>
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
