import { motion } from 'framer-motion';
import { RefreshCw, FileDown, Plus } from 'lucide-react';

export function DashboardHeader({ onReplan, onAddData }: { onReplan: () => void; onAddData: () => void }) {
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
          <h1 className="text-xl font-bold text-foreground tracking-tight flex items-center gap-2">
            Piano di Produzione
            <span className="text-xs font-normal text-muted-foreground bg-accent px-2 py-0.5 rounded-full">v2.1</span>
          </h1>
          <p className="text-xs text-muted-foreground">
            Caseificio Fratelli Sorrentino — Ottimizzato
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
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
        <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-accent text-sm font-medium text-foreground hover:bg-accent/80 transition-colors">
          <FileDown className="w-4 h-4" />
          Esporta PDF
        </button>
      </div>
    </motion.header>
  );
}
