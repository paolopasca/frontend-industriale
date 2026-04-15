import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Loader2, AlertTriangle } from 'lucide-react';
import { type SolverMethod } from './SolverMethodSelect';
import { type SetupData } from './SetupPage';
import { solveLLMOnly, solveTemplate, autoLogin, pipelineStart, pipelineAdvance, pipelineRespond, pipelineResults } from '@/lib/api';

// Phases shown for each method
const METHOD_PHASES: Record<SolverMethod, { label: string; duration: number }[]> = {
  'llm-only': [
    { label: 'Caricamento consultation', duration: 1500 },
    { label: 'Invio a Claude Sonnet', duration: 3000 },
    { label: 'Generazione piano diretto', duration: 8000 },
    { label: 'Parsing risultati', duration: 1500 },
  ],
  'codegen-pipeline': [
    { label: 'Caricamento dati', duration: 2000 },
    { label: 'Analisi vincoli (UNDERSTAND)', duration: 5000 },
    { label: 'Elicitation domande', duration: 4000 },
    { label: 'Generazione constraints.md', duration: 3000 },
    { label: 'Codegen CP-SAT (OR-Tools)', duration: 8000 },
    { label: 'Esecuzione solver', duration: 5000 },
    { label: 'Validazione soluzione', duration: 3000 },
    { label: 'Generazione narrative', duration: 3000 },
  ],
  'deterministic-json': [
    { label: 'Caricamento regole JSON', duration: 1000 },
    { label: 'Mappatura vincoli parametrici', duration: 1500 },
    { label: 'Esecuzione CP-SAT template', duration: 2000 },
    { label: 'Calcolo KPI', duration: 1000 },
  ],
};

// Interactive factory mini-game
function FactoryGame({ onBoost }: { onBoost: () => void }) {
  const [gears, setGears] = useState<{ id: number; x: number; y: number; size: number; clicked: boolean }[]>([]);
  const nextId = useRef(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setGears(prev => {
        const filtered = prev.filter(g => !g.clicked || Date.now() % 100 !== 0);
        if (filtered.length < 6) {
          return [...filtered, {
            id: nextId.current++,
            x: 10 + Math.random() * 80,
            y: 10 + Math.random() * 80,
            size: 24 + Math.random() * 20,
            clicked: false,
          }];
        }
        return filtered;
      });
    }, 1200);
    return () => clearInterval(interval);
  }, []);

  const handleClick = (id: number) => {
    setGears(prev => prev.map(g => g.id === id ? { ...g, clicked: true } : g));
    onBoost();
    setTimeout(() => {
      setGears(prev => prev.filter(g => g.id !== id));
    }, 500);
  };

  return (
    <div className="relative w-full h-40 rounded-xl bg-accent/30 border border-border overflow-hidden select-none">
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <p className="text-xs text-muted-foreground/60">Clicca gli ingranaggi per accelerare</p>
      </div>
      <AnimatePresence>
        {gears.map(g => (
          <motion.button
            key={g.id}
            initial={{ opacity: 0, scale: 0, rotate: 0 }}
            animate={{ opacity: g.clicked ? 0 : 1, scale: g.clicked ? 1.5 : 1, rotate: 360 }}
            exit={{ opacity: 0, scale: 0 }}
            transition={{ rotate: { duration: 4, repeat: Infinity, ease: 'linear' }, scale: { duration: 0.3 } }}
            onClick={() => handleClick(g.id)}
            style={{ left: `${g.x}%`, top: `${g.y}%`, width: g.size, height: g.size }}
            className="absolute cursor-pointer"
          >
            <svg viewBox="0 0 24 24" fill="none" className="w-full h-full text-primary/60 hover:text-primary transition-colors">
              <path d="M12 15a3 3 0 100-6 3 3 0 000 6z" stroke="currentColor" strokeWidth="1.5" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            {g.clicked && (
              <motion.span
                initial={{ opacity: 1, y: 0 }}
                animate={{ opacity: 0, y: -30 }}
                className="absolute -top-2 left-1/2 -translate-x-1/2 text-primary font-bold text-xs"
              >
                +1
              </motion.span>
            )}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function OptimizationLoader({
  method,
  companySlug,
  setupData,
  onComplete,
}: {
  method: SolverMethod;
  companySlug: string | null;
  setupData: SetupData;
  onComplete: (result?: unknown) => void;
}) {
  const [currentPhase, setCurrentPhase] = useState(0);
  const [progress, setProgress] = useState(0);
  const [boostCount, setBoostCount] = useState(0);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backendLog, setBackendLog] = useState<string[]>([]);
  const calledRef = useRef(false);

  const PHASES = METHOD_PHASES[method];
  const TOTAL_DURATION = PHASES.reduce((a, p) => a + p.duration, 0);

  // Visual progress timer
  useEffect(() => {
    if (done || error) return;
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min((elapsed / TOTAL_DURATION) * 100, 95); // cap at 95 until backend finishes
      setProgress(pct);

      let acc = 0;
      for (let i = 0; i < PHASES.length; i++) {
        acc += PHASES[i].duration;
        if (elapsed < acc) { setCurrentPhase(i); break; }
        if (i === PHASES.length - 1) setCurrentPhase(i);
      }
    }, 50);
    return () => clearInterval(interval);
  }, [done, error, PHASES, TOTAL_DURATION]);

  // Actual backend call
  useEffect(() => {
    if (calledRef.current) return;
    calledRef.current = true;

    const addLog = (msg: string) => setBackendLog(prev => [...prev, msg]);

    async function runSolve() {
      try {
        if (method === 'llm-only') {
          addLog('Chiamata Solo LLM...');
          if (!companySlug) {
            addLog('Nessuna azienda selezionata — uso dati locali');
            // Simulate for non-backend companies
            await new Promise(r => setTimeout(r, TOTAL_DURATION));
            setProgress(100);
            setDone(true);
            setTimeout(() => onComplete(), 1500);
            return;
          }
          const result = await solveLLMOnly(companySlug);
          addLog(`Risultato: ${result.status} — costo: $${result.cost_usd?.toFixed(3) ?? '?'}`);
          if (result.status === 'error') {
            setError(result.result?.narrative || 'Errore LLM');
            return;
          }
          setProgress(100);
          setDone(true);
          setTimeout(() => onComplete(result), 1500);

        } else if (method === 'codegen-pipeline') {
          addLog('Avvio pipeline CP Solver...');
          if (!companySlug) {
            addLog('Pipeline richiede azienda con consultation — uso simulazione');
            await new Promise(r => setTimeout(r, TOTAL_DURATION));
            setProgress(100);
            setDone(true);
            setTimeout(() => onComplete(), 1500);
            return;
          }

          // Auto-login for pipeline (needs JWT auth)
          if (companySlug) {
            const loggedIn = await autoLogin(companySlug);
            if (!loggedIn) {
              addLog('Login fallito — pipeline richiede autenticazione');
              setError('Autenticazione fallita');
              return;
            }
            addLog('Autenticato come demo user');
          }

          // Start pipeline session
          const startRes = await pipelineStart(
            setupData.companyName,
            `Ottimizza produzione per ${setupData.companyName}`,
            'compose',  // Use Arm C compose pipeline
          );
          addLog(`Sessione: ${startRes.session_id} — stato: ${startRes.state}`);

          // Advance through pipeline states
          let state = startRes;
          let maxIterations = 20;
          while (state.state !== 'done' && state.state !== 'error' && maxIterations-- > 0) {
            if (state.waiting_for_manager) {
              // Auto-confirm for demo
              const autoAnswer = state.manager_options?.[0] || 'confermo, procedi';
              addLog(`Auto-risposta: "${autoAnswer.slice(0, 50)}..."`);
              state = await pipelineRespond(state.session_id, autoAnswer);
            } else {
              state = await pipelineAdvance(state.session_id);
            }
            addLog(`Stato: ${state.state}${state.step_label ? ` — ${state.step_label}` : ''}`);
          }

          if (state.state === 'done') {
            const results = await pipelineResults(state.session_id);
            addLog(`Completato — costo: $${results.cost_usd?.toFixed(3) ?? '?'}`);
            setProgress(100);
            setDone(true);
            setTimeout(() => onComplete(results), 1500);
          } else {
            setError(`Pipeline terminata in stato: ${state.state}`);
          }

        } else if (method === 'deterministic-json') {
          addLog('Template deterministico — 0 LLM calls');
          if (!companySlug) {
            addLog('Nessuna azienda selezionata — servono dati');
            setError('Seleziona un\'azienda con dati per il template solve');
            return;
          }
          addLog(`Chiamata template_solve per ${companySlug}...`);
          const result = await solveTemplate(companySlug);
          addLog(`Status: ${result.status} — objective: ${result.objective_value ?? 'N/A'}`);
          if (result.warnings?.length) {
            addLog(`Warnings: ${result.warnings.join(', ')}`);
          }
          addLog(`Costo: $${result.cost_usd}`);
          if (result.status === 'OPTIMAL' || result.status === 'FEASIBLE') {
            setProgress(100);
            setDone(true);
            setTimeout(() => onComplete(result), 1500);
          } else {
            setError(`Template solve: ${result.status}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog(`ERRORE: ${msg}`);
        setError(msg);
      }
    }

    runSolve();
  }, [method, companySlug, setupData, onComplete, TOTAL_DURATION]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-lg text-center space-y-8"
      >
        {/* Hero Logo */}
        <div className="flex justify-center">
          <div className="relative">
            <motion.div
              animate={{ opacity: done ? 0 : [0.15, 0.3, 0.15] }}
              transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute inset-0 blur-[70px] bg-primary rounded-full scale-[2]"
            />
            <motion.img
              src="/logo.png"
              alt="DAINO"
              animate={done ? { scale: [1, 1.1, 1] } : { rotate: [0, 3, -3, 0] }}
              transition={done
                ? { duration: 0.5 }
                : { duration: 4, repeat: Infinity, ease: 'easeInOut' }
              }
              className="relative w-32 h-32 object-contain drop-shadow-[0_0_30px_var(--teal-glow)]"
            />
            {done && (
              <motion.div
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="absolute -bottom-1 -right-1 w-10 h-10 rounded-full bg-primary flex items-center justify-center shadow-lg shadow-primary/30"
              >
                <CheckCircle2 className="w-6 h-6 text-primary-foreground" />
              </motion.div>
            )}
            {error && (
              <motion.div
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="absolute -bottom-1 -right-1 w-10 h-10 rounded-full bg-destructive flex items-center justify-center shadow-lg shadow-destructive/30"
              >
                <AlertTriangle className="w-6 h-6 text-destructive-foreground" />
              </motion.div>
            )}
          </div>
        </div>

        <div>
          <h2 className="text-xl font-bold text-foreground mb-2">
            {error
              ? 'Errore durante l\'ottimizzazione'
              : done
                ? 'Ottimizzazione Completata!'
                : 'Ottimizzazione in Corso...'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {error
              ? error
              : done
                ? 'Il piano di produzione e pronto'
                : `Metodo: ${method === 'llm-only' ? 'Solo LLM' : method === 'codegen-pipeline' ? 'Pipeline CP Solver' : 'JSON Deterministico'}`}
          </p>
        </div>

        {/* Progress bar */}
        <div className="space-y-3">
          <div className="relative h-3 w-full rounded-full bg-accent overflow-hidden">
            <motion.div
              className={`absolute inset-y-0 left-0 rounded-full ${error ? 'bg-destructive' : 'bg-primary'}`}
              style={{ width: `${progress}%` }}
              transition={{ duration: 0.1 }}
            />
            {!done && !error && (
              <div className="absolute inset-0 rounded-full bg-gradient-to-r from-transparent via-white/10 to-transparent animate-pulse" />
            )}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground font-mono">
            <span>{progress.toFixed(0)}%</span>
            {boostCount > 0 && (
              <span className="text-primary">+{boostCount} boost</span>
            )}
          </div>
        </div>

        {/* Phase list */}
        <div className="space-y-2 text-left">
          {PHASES.map((phase, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: i <= currentPhase ? 1 : 0.3, x: 0 }}
              transition={{ delay: i * 0.1 }}
              className="flex items-center gap-3 text-sm"
            >
              <div className="w-5 h-5 flex-shrink-0">
                {i < currentPhase || done ? (
                  <CheckCircle2 className="w-5 h-5 text-primary" />
                ) : i === currentPhase && !done && !error ? (
                  <Loader2 className="w-5 h-5 text-primary animate-spin" />
                ) : (
                  <div className="w-5 h-5 rounded-full border border-border" />
                )}
              </div>
              <span className={i <= currentPhase ? 'text-foreground' : 'text-muted-foreground'}>
                {phase.label}
              </span>
            </motion.div>
          ))}
        </div>

        {/* Backend log */}
        {backendLog.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-left bg-accent/30 rounded-lg p-3 max-h-32 overflow-y-auto"
          >
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Backend log</p>
            {backendLog.map((log, i) => (
              <p key={i} className="text-xs font-mono text-muted-foreground leading-relaxed">
                {log}
              </p>
            ))}
          </motion.div>
        )}

        {/* Interactive game */}
        {!done && !error && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1 }}
          >
            <FactoryGame onBoost={() => setBoostCount(c => c + 1)} />
          </motion.div>
        )}

        {/* Retry on error */}
        {error && (
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-all"
          >
            Riprova
          </button>
        )}
      </motion.div>
    </div>
  );
}
