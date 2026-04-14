import { useState } from 'react';
import { motion } from 'framer-motion';
import { MessageSquare, Code2, FileJson, ArrowLeft, Zap, Clock, Shield, Sparkles } from 'lucide-react';

export type SolverMethod = 'llm-only' | 'codegen-pipeline' | 'deterministic-json';

const methods: {
  id: SolverMethod;
  icon: typeof MessageSquare;
  title: string;
  subtitle: string;
  description: string;
  pros: string[];
  speed: string;
  accuracy: string;
  status: 'attivo' | 'attivo' | 'in sviluppo';
  statusColor: string;
}[] = [
  {
    id: 'llm-only',
    icon: MessageSquare,
    title: 'Solo LLM',
    subtitle: 'Prompt diretto',
    description:
      'Il modello linguistico genera direttamente il piano di produzione tramite ragionamento. Veloce, ma approssimativo su istanze grandi.',
    pros: ['Risposta in ~10 secondi', 'Nessun solver necessario', 'Ideale per stime rapide'],
    speed: 'Velocissimo',
    accuracy: 'Approssimativo',
    status: 'attivo',
    statusColor: 'bg-primary/15 text-primary border-primary/30',
  },
  {
    id: 'codegen-pipeline',
    icon: Code2,
    title: 'Pipeline CP Solver',
    subtitle: 'Elicitation + Codegen + OR-Tools',
    description:
      'Pipeline completa: elicitation dei vincoli, generazione codice CP-SAT, esecuzione OR-Tools, validazione e debug automatico. Soluzione ottimale garantita.',
    pros: ['Elicitation guidata dei vincoli', 'Codegen + solver CP-SAT (OR-Tools)', 'Validazione e debug automatico'],
    speed: '2-5 minuti',
    accuracy: 'Ottimale',
    status: 'attivo',
    statusColor: 'bg-primary/15 text-primary border-primary/30',
  },
  {
    id: 'deterministic-json',
    icon: FileJson,
    title: 'JSON Deterministico',
    subtitle: 'Mappatura strutturata',
    description:
      'I dati vengono mappati in un formato JSON strutturato e risolti con un algoritmo deterministico. Nessuna variabilità, risultati riproducibili.',
    pros: ['100% riproducibile', 'Nessuna chiamata LLM in solve', 'Latenza minima'],
    speed: 'Istantaneo',
    accuracy: 'Deterministico',
    status: 'in sviluppo',
    statusColor: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  },
];

export function SolverMethodSelect({
  onSelect,
  onBack,
  companySlug,
  hasConsultation,
}: {
  onSelect: (method: SolverMethod) => void;
  onBack: () => void;
  companySlug: string | null;
  hasConsultation: boolean;
}) {
  const [hoveredId, setHoveredId] = useState<SolverMethod | null>(null);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-4xl">
        {/* Hero Logo */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col items-center mb-10"
        >
          <div className="relative">
            <div className="absolute inset-0 blur-[80px] bg-primary/25 rounded-full scale-[2]" />
            <img
              src="/logo.png"
              alt="DAINO"
              className="relative w-48 h-48 object-contain drop-shadow-[0_0_40px_var(--teal-glow)]"
            />
          </div>
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="text-muted-foreground text-xs tracking-[0.25em] uppercase mt-1"
          >
            Scegli il metodo di risoluzione
          </motion.p>
        </motion.div>

        {/* Method cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-8">
          {methods.map((method, i) => (
            <motion.button
              key={method.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.1 }}
              onMouseEnter={() => setHoveredId(method.id)}
              onMouseLeave={() => setHoveredId(null)}
              onClick={() => onSelect(method.id)}
              className={`relative text-left p-6 rounded-2xl border transition-all duration-300 cursor-pointer group ${
                hoveredId === method.id
                  ? 'bg-card border-primary/40 shadow-lg shadow-primary/5 scale-[1.02]'
                  : 'bg-card border-border hover:border-primary/20'
              }`}
            >
              {/* Status badge */}
              <div className="flex items-center justify-between mb-4">
                <div
                  className={`w-11 h-11 rounded-xl flex items-center justify-center transition-all ${
                    hoveredId === method.id
                      ? 'bg-primary/15 border border-primary/30'
                      : 'bg-accent/50 border border-border'
                  }`}
                >
                  <method.icon
                    className={`w-5 h-5 transition-colors ${
                      hoveredId === method.id ? 'text-primary' : 'text-muted-foreground'
                    }`}
                  />
                </div>
                <span
                  className={`text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border ${method.statusColor}`}
                >
                  {method.status}
                </span>
              </div>

              {/* Title */}
              <h3 className="text-lg font-bold text-foreground mb-0.5">{method.title}</h3>
              <p className="text-xs font-medium text-primary/70 mb-3">{method.subtitle}</p>

              {/* Description */}
              <p className="text-sm text-muted-foreground leading-relaxed mb-4">{method.description}</p>

              {/* Pros */}
              <ul className="space-y-1.5 mb-5">
                {method.pros.map((pro, j) => (
                  <li key={j} className="flex items-start gap-2 text-xs text-muted-foreground">
                    <Sparkles className="w-3 h-3 text-primary/50 mt-0.5 flex-shrink-0" />
                    <span>{pro}</span>
                  </li>
                ))}
              </ul>

              {/* Metrics */}
              <div className="grid grid-cols-2 gap-3 pt-4 border-t border-border">
                <div className="flex items-center gap-1.5">
                  <Clock className="w-3 h-3 text-muted-foreground" />
                  <span className="text-[11px] text-muted-foreground">{method.speed}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Shield className="w-3 h-3 text-muted-foreground" />
                  <span className="text-[11px] text-muted-foreground">{method.accuracy}</span>
                </div>
              </div>

              {/* Hover CTA */}
              <motion.div
                initial={false}
                animate={{ opacity: hoveredId === method.id ? 1 : 0, y: hoveredId === method.id ? 0 : 5 }}
                className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-2 py-3 rounded-b-2xl bg-primary/10 text-primary text-xs font-semibold"
              >
                <Zap className="w-3.5 h-3.5" />
                Usa questo metodo
              </motion.div>
            </motion.button>
          ))}
        </div>

        {/* Back button */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.4 }} className="text-center">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Torna alla configurazione
          </button>
        </motion.div>
      </div>
    </div>
  );
}
