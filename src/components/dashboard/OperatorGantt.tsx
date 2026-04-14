import { motion } from 'framer-motion';
import { useDashboard } from '@/data/DashboardContext';
import { getOperationsForOperator, getJobColorHex, minutesToTimeStr } from '@/data/resultAdapter';
import { type Operation } from '@/data/mockData';
import { useState, useRef, useCallback } from 'react';

interface GanttProps {
  selectedOrder: string | null;
  onSelectOrder: (id: string | null) => void;
  onScroll?: (scrollLeft: number) => void;
  scrollLeft?: number;
}

const DEFAULT_TOTAL_MINUTES = 1680;
const PIXELS_PER_MINUTE = 1.2;
const ROW_HEIGHT = 44;

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
      <div className="absolute inset-y-0 left-0 rounded-l setup-pattern" style={{ width: setupWidth, backgroundColor: color, opacity: selected ? 1 : 0.5, filter: 'brightness(0.7)' }} />
      <div className="absolute inset-y-0 rounded-r" style={{ left: setupWidth, right: 0, backgroundColor: color, opacity: selected ? 1 : hovered ? 0.85 : 0.7, boxShadow: selected ? `0 0 10px ${color}50` : 'none' }} />
      {totalWidth > 40 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <span className="text-[9px] font-mono font-semibold text-foreground drop-shadow-md truncate px-1">{op.orderId}</span>
        </div>
      )}
      {hovered && (
        <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-52 p-2.5 rounded-lg bg-popover border border-border shadow-xl text-xs">
          <div className="font-semibold text-foreground mb-1">{op.orderId} — {op.description}</div>
          <div className="grid grid-cols-2 gap-1 text-muted-foreground">
            <span>Macchina:</span><span className="font-mono text-foreground">{op.machineId}</span>
            <span>Durata tot:</span><span className="font-mono text-foreground">{setup + proc} min</span>
            <span>Inizio:</span><span className="font-mono text-foreground">{minutesToTimeStr(op.startMinute || 0)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function OperatorGantt({ selectedOrder, onSelectOrder, onScroll, scrollLeft }: GanttProps) {
  const { operators, operations } = useDashboard();
  const scrollRef = useRef<HTMLDivElement>(null);

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

  if (scrollRef.current && scrollLeft !== undefined && Math.abs(scrollRef.current.scrollLeft - scrollLeft) > 1) {
    scrollRef.current.scrollLeft = scrollLeft;
  }

  return (
    <div className="overflow-hidden">
      <div className="flex">
        <div className="flex-shrink-0 w-32 border-r border-border">
          {operators.map(op => (
            <div key={op.id} className="flex items-center px-3 border-b border-border/50" style={{ height: ROW_HEIGHT }}>
              <div>
                <div className="text-[11px] font-semibold text-foreground truncate">{(op.name || op.id).split(' ')[0]}</div>
                <div className="text-[9px] font-mono text-muted-foreground">{op.shift === 'Pomeriggio' ? '🌙 14-22' : '☀ 06-14'}</div>
              </div>
            </div>
          ))}
        </div>
        <div ref={scrollRef} className="flex-1 overflow-x-auto" onScroll={handleScroll}>
          {operators.map(op => {
            const ops = getOperationsForOperator(operations, op.id);
            // Shift background
            const isMorning = op.shift === 'Mattina';
            return (
              <div key={op.id} className="relative border-b border-border/50" style={{ height: ROW_HEIGHT, width: GANTT_WIDTH }}>
                {/* Shift blocks - show active shift periods */}
                {Array.from({ length: 4 }).map((_, day) => (
                  <div key={day} className="absolute top-0 bottom-0 bg-accent/20" style={{
                    left: (day * 480 + (isMorning ? 0 : 480)) * PIXELS_PER_MINUTE,
                    width: 480 * PIXELS_PER_MINUTE,
                    display: (day * 480 + (isMorning ? 0 : 480)) < TOTAL_MINUTES ? 'block' : 'none',
                  }} />
                ))}
                {ops.map(operation => (
                  <OperationBar
                    key={operation.id}
                    op={operation}
                    selected={selectedOrder === operation.orderId}
                    onSelect={() => onSelectOrder(selectedOrder === operation.orderId ? null : operation.orderId)}
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
