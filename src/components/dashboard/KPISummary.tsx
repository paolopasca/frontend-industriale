import { motion } from 'framer-motion';
import { useDashboard } from '@/data/DashboardContext';
import { Clock, TrendingUp, AlertTriangle, Gauge, Euro, Wrench, Users, Zap } from 'lucide-react';
import { useEffect, useState, useMemo } from 'react';

function AnimatedNumber({ value, suffix = '', prefix = '', decimals = 0, duration = 1.5 }: { value: number; suffix?: string; prefix?: string; decimals?: number; duration?: number }) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const start = performance.now();
    const animate = (now: number) => {
      const elapsed = (now - start) / 1000;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(value * eased);
      if (progress < 1) requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
  }, [value, duration]);

  const formatted = (isNaN(display) ? 0 : display).toFixed(decimals).replace('.', ',');
  // Add thousands separator
  const parts = formatted.split(',');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return <span className="font-mono">{prefix}{parts.join(',')}{suffix}</span>;
}

export function KPISummary() {
  const { kpis } = useDashboard();

  // Safe accessor: fallback to 0 for any undefined/NaN value
  const safe = (v: number | undefined) => (v != null && !isNaN(v) ? v : 0);

  const primaryCards = useMemo(() => [
    {
      label: 'Makespan',
      value: safe(kpis.makespanDays),
      suffix: ' giorni',
      decimals: 1,
      sublabel: `${safe(kpis.makespan).toFixed(1).replace('.', ',')} ore totali`,
      icon: Clock,
      highlight: true,
    },
    {
      label: 'Ritardo Totale',
      value: safe(kpis.totalTardiness),
      suffix: ' min',
      decimals: 0,
      sublabel: `${safe(kpis.ordersLate)} ordini in ritardo su ${safe(kpis.totalOrders)}`,
      icon: AlertTriangle,
      highlight: false,
      warn: true,
    },
    {
      label: 'Alta Priorità On-Time',
      value: safe(kpis.highPriorityOnTime),
      suffix: '%',
      decimals: 0,
      sublabel: `Ordini alta priorità completati in tempo`,
      icon: TrendingUp,
      highlight: true,
    },
    {
      label: 'Picco Utilizzo',
      value: safe(kpis.peakUtilization),
      suffix: '%',
      decimals: 1,
      sublabel: `Utilizzo medio: ${safe(kpis.avgUtilization).toFixed(1).replace('.', ',')}%`,
      icon: Gauge,
      highlight: false,
    },
  ], [kpis]);

  const costCards = useMemo(() => [
    {
      label: 'Costo Personale',
      value: 4280,
      prefix: '€ ',
      suffix: '',
      decimals: 0,
      sublabel: '8 operatori × 3,2 gg, media €25/h',
      icon: Users,
    },
    {
      label: 'Costo Setup',
      value: 855,
      prefix: '',
      suffix: ' min',
      decimals: 0,
      sublabel: `${Math.round(855 / (855 + 3690) * 100)}% del tempo totale macchina`,
      icon: Wrench,
    },
    {
      label: 'Costo Totale Produzione',
      value: 12750,
      prefix: '€ ',
      suffix: '',
      decimals: 0,
      sublabel: 'Personale + macchine + energia',
      icon: Euro,
    },
    {
      label: 'Efficienza Energetica',
      value: 82.5,
      prefix: '',
      suffix: '%',
      decimals: 1,
      sublabel: 'Utilizzo medio risorse',
      icon: Zap,
    },
  ], []);
  return (
    <div className="space-y-3">
      {/* Primary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {primaryCards.map((card, i) => (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.1, duration: 0.5 }}
            className={`relative overflow-hidden rounded-lg border p-4 ${
              card.highlight
                ? 'border-primary/30 bg-primary/5'
                : card.warn
                  ? 'border-destructive/20 bg-destructive/5'
                  : 'border-border bg-card'
            }`}
          >
            {card.highlight && (
              <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent pointer-events-none" />
            )}
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {card.label}
              </span>
              <card.icon className={`w-3.5 h-3.5 ${card.highlight ? 'text-primary' : card.warn ? 'text-destructive' : 'text-muted-foreground'}`} />
            </div>
            <div className={`text-2xl font-bold tracking-tight ${card.highlight ? 'text-primary teal-glow-text' : card.warn ? 'text-destructive' : 'text-foreground'}`}>
              <AnimatedNumber value={card.value} suffix={card.suffix} decimals={card.decimals} />
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5">{card.sublabel}</p>
          </motion.div>
        ))}
      </div>

      {/* Cost KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {costCards.map((card, i) => (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 + i * 0.08, duration: 0.4 }}
            className="relative overflow-hidden rounded-lg border border-border bg-card p-4"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {card.label}
              </span>
              <card.icon className="w-3.5 h-3.5 text-muted-foreground" />
            </div>
            <div className="text-xl font-bold tracking-tight text-foreground">
              <AnimatedNumber value={card.value} prefix={card.prefix} suffix={card.suffix} decimals={card.decimals} />
            </div>
            <p className="text-[10px] text-muted-foreground mt-1.5">{card.sublabel}</p>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
