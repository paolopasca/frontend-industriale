import { useState } from 'react';
import { X, Upload, Send } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export function ReplanModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');

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
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-2xl"
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-foreground">Ripianifica</h2>
              <button onClick={onClose} className="p-1 rounded-md hover:bg-accent transition-colors">
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>
            <p className="text-sm text-muted-foreground mb-4">
              Descrivi le modifiche desiderate o carica nuovi vincoli. L'AI genererà un nuovo piano ottimizzato.
            </p>
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder="Es: COM-005 deve essere completato entro Giorno 2. Aggiungi turno notturno per Fresa 5 Assi..."
              className="w-full h-32 rounded-lg bg-input border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <div className="mt-3 flex items-center gap-3">
              <button className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border text-sm text-muted-foreground hover:bg-accent transition-colors">
                <Upload className="w-4 h-4" />
                Carica file
              </button>
              <div className="flex-1" />
              <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:bg-accent transition-colors">
                Annulla
              </button>
              <button className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors">
                <Send className="w-4 h-4" />
                Invia
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
