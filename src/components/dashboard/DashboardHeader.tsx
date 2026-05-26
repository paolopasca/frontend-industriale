import { motion } from 'framer-motion';
import { RefreshCw, FileDown, Plus, ArrowLeft, CheckCircle2, AlertTriangle, HelpCircle, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { clearSlugScoped, setSlugScoped } from '@/lib/storage';
import { useDashboard } from '@/data/DashboardContext';
import { PRINT_SNAPSHOT_KEY } from '@/lib/printSchedule';

const STATUS_BADGE: Record<string, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  OPTIMAL: {
    label: 'OTTIMALE',
    className: 'bg-primary/15 text-primary border-primary/30',
    Icon: CheckCircle2,
  },
  FEASIBLE: {
    label: 'FATTIBILE',
    className: 'bg-primary/10 text-primary border-primary/20',
    Icon: CheckCircle2,
  },
  INFEASIBLE: {
    label: 'NON FATTIBILE',
    className: 'bg-destructive/15 text-destructive border-destructive/30',
    Icon: XCircle,
  },
  UNKNOWN: {
    label: 'PARZIALE',
    className: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
    Icon: HelpCircle,
  },
  EMPTY: {
    label: 'NESSUN PIANO',
    className: 'bg-muted text-muted-foreground border-border',
    Icon: AlertTriangle,
  },
};

export function DashboardHeader({
  onReplan,
  onAddData,
  onReset,
  companySlug,
  companyName,
  solverStatus,
}: {
  onReplan: () => void;
  onAddData: () => void;
  onReset?: () => void;
  companySlug?: string | null;
  companyName?: string | null;
  solverStatus?: string | null;
}) {
  const dashboard = useDashboard();
  // Wave 15 — W15-03: "Esporta PDF" no longer prints the whole dashboard.
  // Persist a snapshot of the current schedule to slug-scoped storage and
  // open the dedicated print route in a new tab; that route auto-fires
  // `window.print()` on load. Falls back to a generic "current" key when
  // no slug is wired through (legacy DataInputModal path).
  const handleExportPdf = () => {
    const slug = (companySlug && companySlug.trim().length > 0) ? companySlug : 'current';
    try {
      const snapshot = JSON.stringify({
        data: dashboard,
        companyName: companyName ?? '',
      });
      setSlugScoped(PRINT_SNAPSHOT_KEY, slug, snapshot);
    } catch {
      toast.error('Impossibile preparare il piano per la stampa.');
      return;
    }
    const url = `/print/${encodeURIComponent(slug)}`;
    const win = window.open(url, '_blank', 'noopener,noreferrer');
    if (!win) {
      // popup blocked: keep the manager unblocked with a manual fallback.
      toast.error('Il browser ha bloccato la nuova finestra. Consenti i popup per esportare il PDF.');
    }
  };
  const handleReset = () => {
    if (companySlug) clearSlugScoped(companySlug);
    onReset?.();
  };
  return (
    <motion.header
      initial={{ opacity: 0, y: -20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5 }}
      className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
    >
      <div className="flex items-center gap-3">
        <img src="/logo.png" alt="DAINO" className="w-10 h-10 object-contain drop-shadow-[0_0_10px_var(--teal-glow)]" />
        <div>
          <h1 className="text-xl font-bold text-foreground tracking-tight flex items-center gap-2 flex-wrap">
            Piano di Produzione
            <span className="text-xs font-normal text-muted-foreground bg-accent px-2 py-0.5 rounded-full">v2.1</span>
            {solverStatus && STATUS_BADGE[solverStatus] && (() => {
              const cfg = STATUS_BADGE[solverStatus];
              const Icon = cfg.Icon;
              return (
                <span
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold tracking-wider ${cfg.className}`}
                  title={`Stato solver: ${solverStatus}`}
                >
                  <Icon className="w-3 h-3" />
                  {cfg.label}
                </span>
              );
            })()}
          </h1>
          <p className="text-xs text-muted-foreground">
            {companyName && companyName.trim().length > 0 ? companyName : 'Pianificazione'} — Ottimizzato
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 no-print">
        {onReset && (
          <button
            onClick={handleReset}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Nuova Ottimizzazione
          </button>
        )}
        <button
          onClick={onAddData}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Inserisci Dati
        </button>
        <button
          onClick={onReplan}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border border-primary/30 text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          Ripianifica
        </button>
        <button
          onClick={handleExportPdf}
          className="no-print flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-sm font-medium text-foreground hover:bg-accent/80 transition-colors"
        >
          <FileDown className="w-4 h-4" />
          Esporta PDF
        </button>
      </div>
    </motion.header>
  );
}
