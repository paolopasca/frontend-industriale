import { motion } from 'framer-motion';
import { useDashboard } from '@/data/DashboardContext';
import { type Priority, type Order } from '@/data/mockData';
import { useState, useMemo } from 'react';
import { ArrowUpDown, ChevronUp, ChevronDown } from 'lucide-react';

const priorityConfig: Record<Priority, { label: string; className: string }> = {
  alta: { label: 'ALTA', className: 'bg-priority-alta/20 text-priority-alta border-priority-alta/30' },
  media: { label: 'MEDIA', className: 'bg-priority-media/20 text-priority-media border-priority-media/30' },
  bassa: { label: 'BASSA', className: 'bg-muted text-muted-foreground border-border' },
};

type SortKey = 'id' | 'priority' | 'deadline' | 'status';

export function OrdersTable({ selectedOrder, onSelectOrder }: { selectedOrder: string | null; onSelectOrder: (id: string | null) => void }) {
  const { orders } = useDashboard();
  const [sortKey, setSortKey] = useState<SortKey>('priority');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  };

  const sorted = useMemo(() => {
    const priorityOrder: Record<Priority, number> = { alta: 3, media: 2, bassa: 1 };
    return [...orders].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'id': cmp = a.id.localeCompare(b.id); break;
        case 'priority': cmp = (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2); break;
        case 'deadline': cmp = a.deadlineMinute - b.deadlineMinute; break;
        case 'status': cmp = (a.status === 'in-ritardo' ? 1 : 0) - (b.status === 'in-ritardo' ? 1 : 0); break;
      }
      return sortDir === 'desc' ? -cmp : cmp;
    });
  }, [sortKey, sortDir, orders]);

  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ArrowUpDown className="w-3 h-3 text-muted-foreground" />;
    return sortDir === 'desc' ? <ChevronDown className="w-3 h-3 text-primary" /> : <ChevronUp className="w-3 h-3 text-primary" />;
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.7, duration: 0.5 }}
      className="rounded-lg border border-border bg-card overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">Ordini ({orders.length})</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              {[
                { key: 'id' as SortKey, label: 'Ordine' },
                { key: 'priority' as SortKey, label: 'Priorità' },
                { key: 'deadline' as SortKey, label: 'Scadenza' },
                { key: 'status' as SortKey, label: 'Stato' },
              ].map(col => (
                <th key={col.key} className="px-3 py-2 text-left font-medium text-muted-foreground cursor-pointer hover:text-foreground transition-colors" onClick={() => toggleSort(col.key)}>
                  <span className="flex items-center gap-1">{col.label} <SortIcon k={col.key} /></span>
                </th>
              ))}
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Prodotto</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Cliente</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">Qtà</th>
              <th className="px-3 py-2 text-right font-medium text-muted-foreground">Op.</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(order => {
              const isSelected = selectedOrder === order.id;
              const cfg = priorityConfig[order.priority] || priorityConfig.media;
              return (
                <tr
                  key={order.id}
                  className={`border-b border-border/50 cursor-pointer transition-colors ${isSelected ? 'bg-primary/10' : 'hover:bg-accent/50'}`}
                  onClick={() => onSelectOrder(isSelected ? null : order.id)}
                >
                  <td className="px-3 py-2.5 font-mono font-semibold text-foreground">{order.id}</td>
                  <td className="px-3 py-2.5">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border ${cfg.className}`}>
                      {cfg.label}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-muted-foreground">{order.deadline}</td>
                  <td className="px-3 py-2.5">
                    <span className={`flex items-center gap-1 font-medium ${order.status === 'in-ritardo' ? 'text-destructive' : 'text-primary'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${order.status === 'in-ritardo' ? 'bg-destructive' : 'bg-primary'}`} />
                      {order.status === 'in-ritardo' ? 'In Ritardo' : 'In Tempo'}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-foreground">{order.product}</td>
                  <td className="px-3 py-2.5 text-muted-foreground truncate max-w-[140px]">{order.client}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{order.quantity}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-muted-foreground">{order.operationCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </motion.div>
  );
}
