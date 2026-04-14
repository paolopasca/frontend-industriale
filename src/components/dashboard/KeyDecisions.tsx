import { motion } from 'framer-motion';
import { useDashboard } from '@/data/DashboardContext';
import { Target, AlertTriangle, GitBranch, Users, Wrench } from 'lucide-react';

const iconMap = {
  priority: Target,
  bottleneck: AlertTriangle,
  sequence: GitBranch,
  operator: Users,
  maintenance: Wrench,
};

export function KeyDecisions() {
  const { keyDecisions } = useDashboard();

  if (!keyDecisions || keyDecisions.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="text-sm font-semibold text-foreground mb-2">Decisioni Chiave dell'AI</h3>
        <p className="text-xs text-muted-foreground">Nessuna decisione chiave disponibile.</p>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.8, duration: 0.5 }}
      className="rounded-lg border border-border bg-card p-4"
    >
      <h3 className="text-sm font-semibold text-foreground mb-4">Decisioni Chiave dell'AI</h3>
      <div className="space-y-3">
        {keyDecisions.map((d, i) => {
          const Icon = iconMap[d.icon] || Target;
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.9 + i * 0.08 }}
              className="flex gap-3 p-3 rounded-md bg-accent/30 border border-border/50 hover:border-primary/20 transition-colors"
            >
              <div className="flex-shrink-0 w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
                <Icon className="w-4 h-4 text-primary" />
              </div>
              <div className="min-w-0">
                <h4 className="text-xs font-semibold text-foreground">{d.title}</h4>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{d.description}</p>
                <p className="text-[10px] text-primary font-medium mt-1">↳ {d.impact}</p>
              </div>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
}
