import { motion } from 'framer-motion';
import { useDashboard } from '@/data/DashboardContext';
import { getMachineUtilization, getOperatorUtilization } from '@/data/resultAdapter';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

export function BottleneckChart() {
  const { machines, operators, operations, kpis } = useDashboard();
  const makespanMinutes = (kpis.makespan || 1) * 60;

  const machineData = machines.map(m => ({
    name: m.shortName,
    utilizzo: Math.round(getMachineUtilization(operations, m.id, makespanMinutes) * 10) / 10,
  }));

  const operatorData = operators.map(op => ({
    name: op.name.split(' ')[0],
    utilizzo: Math.round(getOperatorUtilization(operations, op.id, makespanMinutes) * 10) / 10,
  }));

  const getBarColor = (value: number) => {
    if (value > 90) return '#00e5a0';
    if (value > 75) return '#5b8af5';
    if (value > 60) return '#d4a843';
    return '#e05aa0';
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.6, duration: 0.5 }}
      className="rounded-lg border border-border bg-card p-4"
    >
      <h3 className="text-sm font-semibold text-foreground mb-4">Analisi Colli di Bottiglia</h3>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Machines */}
        <div>
          <h4 className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wider">Utilizzo Macchine (%)</h4>
          <ResponsiveContainer width="100%" height={Math.max(120, machines.length * 40)}>
            <BarChart data={machineData} layout="vertical" margin={{ left: 0, right: 10 }}>
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
              <YAxis type="category" dataKey="name" width={70} tick={{ fontSize: 11, fill: 'var(--color-foreground)' }} />
              <Tooltip
                contentStyle={{ backgroundColor: 'var(--color-popover)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }}
                formatter={(value: number) => [`${value.toFixed(1).replace('.', ',')}%`, 'Utilizzo']}
              />
              <Bar dataKey="utilizzo" radius={[0, 4, 4, 0]} barSize={18}>
                {machineData.map((entry, i) => (
                  <Cell key={i} fill={getBarColor(entry.utilizzo)} fillOpacity={0.8} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        {/* Operators */}
        <div>
          <h4 className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wider">Utilizzo Operatori (%)</h4>
          <ResponsiveContainer width="100%" height={Math.max(120, operators.length * 35)}>
            <BarChart data={operatorData} layout="vertical" margin={{ left: 0, right: 10 }}>
              <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} />
              <YAxis type="category" dataKey="name" width={70} tick={{ fontSize: 11, fill: 'var(--color-foreground)' }} />
              <Tooltip
                contentStyle={{ backgroundColor: 'var(--color-popover)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12 }}
                formatter={(value: number) => [`${value.toFixed(1).replace('.', ',')}%`, 'Utilizzo']}
              />
              <Bar dataKey="utilizzo" radius={[0, 4, 4, 0]} barSize={16}>
                {operatorData.map((entry, i) => (
                  <Cell key={i} fill={getBarColor(entry.utilizzo)} fillOpacity={0.8} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </motion.div>
  );
}
