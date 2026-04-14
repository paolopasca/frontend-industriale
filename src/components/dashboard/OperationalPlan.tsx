import { motion } from 'framer-motion';
import { useDashboard } from '@/data/DashboardContext';
import { getOperationsForMachine, minutesToTimeStr, getJobColorHex } from '@/data/resultAdapter';
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

export function OperationalPlan() {
  const { machines, operators, operations } = useDashboard();
  const [expanded, setExpanded] = useState<string | null>(machines.length > 0 ? machines[0].id : null);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.9, duration: 0.5 }}
      className="rounded-lg border border-border bg-card overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Piano Operativo Dettagliato</h3>
      </div>
      <div>
        {machines.map(m => {
          const ops = getOperationsForMachine(operations, m.id);
          const isOpen = expanded === m.id;
          return (
            <div key={m.id} className="border-b border-border/50 last:border-0">
              <button
                className="w-full px-4 py-3 flex items-center justify-between hover:bg-accent/30 transition-colors"
                onClick={() => setExpanded(isOpen ? null : m.id)}
              >
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-primary font-semibold">{m.id}</span>
                  <span className="text-sm font-medium text-foreground">{m.name}</span>
                  <span className="text-xs text-muted-foreground">{ops.length} operazioni</span>
                </div>
                {isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
              </button>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-muted/20 border-y border-border/50">
                        <th className="px-4 py-2 text-left text-muted-foreground font-medium">#</th>
                        <th className="px-4 py-2 text-left text-muted-foreground font-medium">Ordine</th>
                        <th className="px-4 py-2 text-left text-muted-foreground font-medium">Operazione</th>
                        <th className="px-4 py-2 text-left text-muted-foreground font-medium">Operatore</th>
                        <th className="px-4 py-2 text-right text-muted-foreground font-medium">Setup</th>
                        <th className="px-4 py-2 text-right text-muted-foreground font-medium">Lavorazione</th>
                        <th className="px-4 py-2 text-left text-muted-foreground font-medium">Inizio</th>
                        <th className="px-4 py-2 text-left text-muted-foreground font-medium">Fine</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ops.map((op, i) => {
                        const operator = operators.find(o => o.id === op.operatorId);
                        return (
                          <tr key={op.id} className="border-b border-border/30 hover:bg-accent/20 transition-colors">
                            <td className="px-4 py-2 font-mono text-muted-foreground">{i + 1}</td>
                            <td className="px-4 py-2">
                              <span className="inline-flex items-center gap-1.5">
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: getJobColorHex(op.orderId) }} />
                                <span className="font-mono font-semibold text-foreground">{op.orderId}</span>
                              </span>
                            </td>
                            <td className="px-4 py-2 text-foreground">{op.description}</td>
                            <td className="px-4 py-2 text-muted-foreground">{operator?.name || op.operatorId}</td>
                            <td className="px-4 py-2 text-right font-mono text-muted-foreground">{op.setupMinutes} min</td>
                            <td className="px-4 py-2 text-right font-mono text-foreground">{op.processingMinutes} min</td>
                            <td className="px-4 py-2 font-mono text-muted-foreground">{minutesToTimeStr(op.startMinute)}</td>
                            <td className="px-4 py-2 font-mono text-muted-foreground">{minutesToTimeStr(op.startMinute + op.setupMinutes + op.processingMinutes)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </motion.div>
              )}
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
