import { motion } from 'framer-motion';
import { useState, useMemo } from 'react';
import { FlaskConical, TrendingDown, TrendingUp, Clock, Users, Wrench } from 'lucide-react';
import { useDashboard } from '@/data/DashboardContext';
import { getMachineUtilization } from '@/data/resultAdapter';

interface Scenario {
  id: string;
  icon: typeof FlaskConical;
  title: string;
  description: string;
  impact: { makespan: string; costo: string; onTime: string };
  verdict: 'positivo' | 'negativo' | 'neutro';
}

const verdictColors = {
  positivo: 'text-primary',
  negativo: 'text-destructive',
  neutro: 'text-muted-foreground',
};

function fmt(n: number): string {
  return n.toFixed(1).replace('.', ',');
}

export function WhatIfAnalysis() {
  const { machines, operators, operations, orders, kpis } = useDashboard();
  const [expanded, setExpanded] = useState<string | null>(null);

  const scenarios = useMemo(() => {
    const makespanMin = kpis.makespan || 1;
    const makespanH = makespanMin / 60;
    const totalSetup = kpis.totalSetupTime || 0;
    const onTimeCount = kpis.ordersOnTime || 0;
    const totalOrders = kpis.totalOrders || 1;
    const onTimePct = Math.round((onTimeCount / totalOrders) * 100);

    // Find bottleneck machine (highest utilization)
    const machineUtils = machines.map(m => ({
      ...m,
      util: getMachineUtilization(operations, m.id, makespanMin),
    }));
    machineUtils.sort((a, b) => b.util - a.util);
    const bottleneck = machineUtils[0];
    const bottleneckName = bottleneck?.name || bottleneck?.id || 'N/A';
    const bottleneckUtil = fmt(bottleneck?.util ?? 0);

    // Estimate: adding operator reduces makespan ~8-12%
    const reducedMakespan = makespanH * 0.9;
    const newOnTime = Math.min(totalOrders, onTimeCount + Math.ceil(totalOrders * 0.1));

    // Estimate: reducing setup 30% saves proportional time
    const setupSavingMin = totalSetup * 0.3;
    const makespanAfterSetup = makespanH - (setupSavingMin / 60);

    // Estimate: removing shift doubles makespan roughly
    const makespanNoShift = makespanH * 1.4;
    const onTimeNoShift = Math.max(0, Math.floor(onTimeCount * 0.6));

    // Estimate: adding bottleneck machine
    const makespanAddMachine = makespanH * 0.82;

    const result: Scenario[] = [];

    if (operators.length > 0) {
      result.push({
        id: 'add-operator',
        icon: Users,
        title: `Aggiungere 1 operatore`,
        description: `Un operatore extra qualificato su ${bottleneckName}, il collo di bottiglia con utilizzo al ${bottleneckUtil}%.`,
        impact: {
          makespan: `-${fmt(makespanH - reducedMakespan)}h (da ${fmt(makespanH)}h a ${fmt(reducedMakespan)}h)`,
          costo: `+costo personale aggiuntivo`,
          onTime: `${Math.round((newOnTime / totalOrders) * 100)}% (${newOnTime}/${totalOrders} ordini)`,
        },
        verdict: 'positivo',
      });
    }

    if (totalSetup > 0) {
      result.push({
        id: 'reduce-setup',
        icon: Clock,
        title: `Ridurre tempi setup del 30%`,
        description: `Setup totale attuale: ${totalSetup} min. Una riduzione del 30% risparmia ${Math.round(setupSavingMin)} min su ${bottleneckName}.`,
        impact: {
          makespan: `-${fmt(makespanH - makespanAfterSetup)}h (da ${fmt(makespanH)}h a ${fmt(makespanAfterSetup)}h)`,
          costo: `-${Math.round(setupSavingMin)} min setup/ciclo`,
          onTime: `${onTimePct}% invariato`,
        },
        verdict: totalSetup > 30 ? 'positivo' : 'neutro',
      });
    }

    if (operators.length > 2) {
      result.push({
        id: 'remove-shift',
        icon: TrendingDown,
        title: 'Eliminare un turno',
        description: `Concentrare la produzione in un unico turno. Riduce costi personale ma perde capacita.`,
        impact: {
          makespan: `+${fmt(makespanNoShift - makespanH)}h (da ${fmt(makespanH)}h a ${fmt(makespanNoShift)}h)`,
          costo: `-costo personale turno`,
          onTime: `${Math.round((onTimeNoShift / totalOrders) * 100)}% (${onTimeNoShift}/${totalOrders} ordini)`,
        },
        verdict: 'negativo',
      });
    }

    if (bottleneck) {
      result.push({
        id: 'add-machine',
        icon: Wrench,
        title: `Aggiungere secondo ${bottleneckName}`,
        description: `Raddoppiare la capacita del collo di bottiglia (${bottleneckUtil}% utilizzo). Permette lavorazioni parallele.`,
        impact: {
          makespan: `-${fmt(makespanH - makespanAddMachine)}h (da ${fmt(makespanH)}h a ${fmt(makespanAddMachine)}h)`,
          costo: `+costo ammortamento macchina`,
          onTime: `${totalOrders}/${totalOrders} ordini puntuali`,
        },
        verdict: 'positivo',
      });
    }

    return result;
  }, [machines, operators, operations, orders, kpis]);

  if (scenarios.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.7, duration: 0.5 }}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-center gap-2 mb-4">
        <FlaskConical className="w-4 h-4 text-primary" />
        <h3 className="text-sm font-semibold text-foreground">Analisi What-If</h3>
        <span className="text-[10px] text-muted-foreground ml-1">Basata sui colli di bottiglia rilevati</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {scenarios.map((s) => {
          const Icon = s.icon;
          const isExpanded = expanded === s.id;
          return (
            <motion.div
              key={s.id}
              layout
              onClick={() => setExpanded(isExpanded ? null : s.id)}
              className="p-3 rounded-md bg-accent/30 border border-border/50 hover:border-primary/20 transition-colors cursor-pointer"
            >
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center">
                  <Icon className="w-4 h-4 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <h4 className="text-xs font-semibold text-foreground">{s.title}</h4>
                  <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">{s.description}</p>
                </div>
              </div>

              {isExpanded && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-3 pt-3 border-t border-border/50 space-y-1.5"
                >
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-muted-foreground w-20">Makespan:</span>
                    <span className={`font-mono font-semibold ${verdictColors[s.verdict]}`}>{s.impact.makespan}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-muted-foreground w-20">Costo:</span>
                    <span className="font-mono font-semibold text-foreground">{s.impact.costo}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="text-muted-foreground w-20">On-time:</span>
                    <span className="font-mono font-semibold text-foreground">{s.impact.onTime}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    {s.verdict === 'positivo' ? <TrendingUp className="w-3.5 h-3.5 text-primary" /> : s.verdict === 'negativo' ? <TrendingDown className="w-3.5 h-3.5 text-destructive" /> : null}
                    <span className={`text-[10px] font-semibold uppercase tracking-wider ${verdictColors[s.verdict]}`}>
                      Impatto {s.verdict}
                    </span>
                  </div>
                </motion.div>
              )}
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
}
