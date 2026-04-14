import { motion } from 'framer-motion';
import { useDashboard } from '@/data/DashboardContext';
import { getOperationsForMachine, getJobColorHex, minutesToTimeStr } from '@/data/resultAdapter';
import { type Operation } from '@/data/mockData';
import { useState, useRef, useCallback } from 'react';

interface GanttProps {
  selectedOrder: string | null;
  onSelectOrder: (id: string | null) => void;
  onScroll?: (scrollLeft: number) => void;
  scrollLeft?: number;
}

const DEFAULT_TOTAL_MINUTES = 1680; // ~3.5 days of 8h
const PIXELS_PER_MINUTE = 1.2;
const ROW_HEIGHT = 48;

function TimeAxis({ totalMinutes, ganttWidth }: { totalMinutes: number; ganttWidth: number }) {
  const ticks = [];
  for (let m = 0; m <= totalMinutes; m += 60) {
    const day = Math.floor(m / 480) + 1;
    const hourInDay = ((m % 480) / 60) + 6;
    if (hourInDay === 6 || hourInDay === 10 || hourInDay === 14 || hourInDay === 18) {
      ticks.push({ minute: m, label: `G${day} ${String(Math.floor(hourInDay)).padStart(2, '0')}:00`, major: hourInDay === 6 });
    }
  }
  return (
    <div className="relative h-6" style={{ width: ganttWidth }}>
      {ticks.map(t => (
        <div key={t.minute} className="absolute top-0 flex flex-col items-center" style={{ left: t.minute * PIXELS_PER_MINUTE }}>
          <div className={`w-px ${t.major ? 'h-4 bg-muted-foreground/40' : 'h-3 bg-border'}`} />
          <span className="text-[9px] font-mono text-muted-foreground whitespace-nowrap mt-0.5">{t.label}</span>
        </div>
      ))}
    </div>
  );
}

function OperationBar({ op, selected, onSelect }: { op: Operation; selected: boolean; onSelect: () => void }) {
  const [hovered, setHovered] = useState(false);
  const setup = op.setupMinutes || 0;
  const proc = op.processingMinutes || 0;
  const totalWidth = (setup + proc) * PIXELS_PER_MINUTE;
  const setupWidth = setup * PIXELS_PER_MINUTE;
  const color = getJobColorHex(op.orderId);

  return (
    <div
      className="absolute top-1 cursor-pointer transition-all duration-150"
      style={{
        left: op.startMinute * PIXELS_PER_MINUTE,
        width: totalWidth,
        height: ROW_HEIGHT - 8,
      }}
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Setup portion */}
      <div
        className="absolute inset-y-0 left-0 rounded-l setup-pattern"
        style={{
          width: setupWidth,
          backgroundColor: color,
          opacity: selected ? 1 : 0.6,
          filter: 'brightness(0.7)',
        }}
      />
      {/* Processing portion */}
      <div
        className="absolute inset-y-0 rounded-r"
        style={{
          left: setupWidth,
          right: 0,
          backgroundColor: color,
          opacity: selected ? 1 : hovered ? 0.9 : 0.75,
          boxShadow: selected ? `0 0 12px ${color}60` : 'none',
        }}
      />
      {/* Label */}
      {totalWidth > 50 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[10px] font-mono font-semibold text-foreground drop-shadow-md truncate px-1">
            {op.orderId}
          </span>
        </div>
      )}
      {/* Tooltip */}
      {hovered && (
        <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-56 p-3 rounded-lg bg-popover border border-border shadow-xl text-xs">
          <div className="font-semibold text-foreground mb-1">{op.orderId} — {op.description}</div>
          <div className="grid grid-cols-2 gap-1 text-muted-foreground">
            <span>Setup:</span><span className="font-mono text-foreground">{setup} min</span>
            <span>Lavorazione:</span><span className="font-mono text-foreground">{proc} min</span>
            <span>Inizio:</span><span className="font-mono text-foreground">{minutesToTimeStr(op.startMinute || 0)}</span>
            <span>Fine:</span><span className="font-mono text-foreground">{minutesToTimeStr((op.startMinute || 0) + setup + proc)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function MachineGantt({ selectedOrder, onSelectOrder, onScroll, scrollLeft }: GanttProps) {
  const { machines, maintenanceWindows, operations } = useDashboard();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Compute timeline width from actual data (with padding), fallback to default
  const dataMaxMinute = operations.length > 0
    ? operations.reduce((m, o) => Math.max(m, o.startMinute + o.setupMinutes + o.processingMinutes), 0)
    : 0;
  const TOTAL_MINUTES = Math.max(DEFAULT_TOTAL_MINUTES, Math.ceil(dataMaxMinute * 1.1));
  const GANTT_WIDTH = TOTAL_MINUTES * PIXELS_PER_MINUTE;

  const handleScroll = useCallback(() => {
    if (scrollRef.current && onScroll) {
      onScroll(scrollRef.current.scrollLeft);
    }
  }, [onScroll]);

  // Sync external scroll
  if (scrollRef.current && scrollLeft !== undefined && Math.abs(scrollRef.current.scrollLeft - scrollLeft) > 1) {
    scrollRef.current.scrollLeft = scrollLeft;
  }

  // Makespan line position: compute from actual operations
  const makespanMinute = operations.length > 0
    ? operations.reduce((m, o) => Math.max(m, o.startMinute + o.setupMinutes + o.processingMinutes), 0)
    : 0;

  return (
    <div className="overflow-hidden">
      <div className="px-4 py-2 flex items-center justify-end border-b border-border">
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm setup-pattern bg-muted-foreground/60 inline-block" /> Setup</span>
          <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-primary inline-block" /> Lavorazione</span>
          <span className="flex items-center gap-1"><span className="w-3 h-2 rounded-sm bg-maintenance inline-block" /> Manutenzione</span>
        </div>
      </div>
      <div className="flex">
        {/* Labels */}
        <div className="flex-shrink-0 w-32 border-r border-border">
          <div className="h-6" />
          {machines.map(m => (
            <div key={m.id} className="flex items-center px-3 border-b border-border/50" style={{ height: ROW_HEIGHT }}>
              <div>
                <div className="text-xs font-semibold text-foreground">{m.shortName}</div>
                <div className="text-[10px] font-mono text-muted-foreground">{m.id}</div>
              </div>
            </div>
          ))}
        </div>
        {/* Chart */}
        <div ref={scrollRef} className="flex-1 overflow-x-auto" onScroll={handleScroll}>
          <TimeAxis totalMinutes={TOTAL_MINUTES} ganttWidth={GANTT_WIDTH} />
          {machines.map(m => {
            const ops = getOperationsForMachine(operations, m.id);
            const maint = maintenanceWindows.filter(mw => mw.machineId === m.id);
            return (
              <div key={m.id} className="relative border-b border-border/50" style={{ height: ROW_HEIGHT, width: GANTT_WIDTH }}>
                {/* Grid lines */}
                {Array.from({ length: Math.ceil(TOTAL_MINUTES / 480) + 1 }).map((_, i) => (
                  <div key={i} className="absolute top-0 bottom-0 w-px bg-border/30" style={{ left: i * 480 * PIXELS_PER_MINUTE }} />
                ))}
                {/* Maintenance */}
                {maint.map((mw, i) => (
                  <div key={i} className="absolute top-1 rounded bg-maintenance/60" style={{
                    left: mw.startMinute * PIXELS_PER_MINUTE,
                    width: mw.durationMinutes * PIXELS_PER_MINUTE,
                    height: ROW_HEIGHT - 8,
                  }}>
                    <span className="text-[8px] text-muted-foreground px-1 truncate block mt-1">🔧</span>
                  </div>
                ))}
                {/* Operations */}
                {ops.map(op => (
                  <OperationBar
                    key={op.id}
                    op={op}
                    selected={selectedOrder === op.orderId}
                    onSelect={() => onSelectOrder(selectedOrder === op.orderId ? null : op.orderId)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
