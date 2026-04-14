import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useMemo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { SetupPage, type SetupData } from '@/components/onboarding/SetupPage';
import { SolverMethodSelect, type SolverMethod } from '@/components/onboarding/SolverMethodSelect';
import { OptimizationLoader } from '@/components/onboarding/OptimizationLoader';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { KPISummary } from '@/components/dashboard/KPISummary';
import { MachineGantt } from '@/components/dashboard/MachineGantt';
import { OperatorGantt } from '@/components/dashboard/OperatorGantt';
import { BottleneckChart } from '@/components/dashboard/BottleneckChart';
import { OrdersTable } from '@/components/dashboard/OrdersTable';
import { KeyDecisions } from '@/components/dashboard/KeyDecisions';
import { OperationalPlan } from '@/components/dashboard/OperationalPlan';
import { ReplanModal } from '@/components/dashboard/ReplanModal';
import { DataInputModal } from '@/components/dashboard/DataInputModal';
import { GanttSection } from '@/components/dashboard/GanttSection';
import { WhatIfAnalysis } from '@/components/dashboard/WhatIfAnalysis';
import { DashboardContext } from '@/data/DashboardContext';
import { adaptResult, type DashboardData } from '@/data/resultAdapter';

export const Route = createFileRoute("/")({
  component: Index,
});

type Phase = 'setup' | 'method-select' | 'optimizing' | 'dashboard';

function Index() {
  const [phase, setPhase] = useState<Phase>('setup');
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  const [solverMethod, setSolverMethod] = useState<SolverMethod | null>(null);
  const [backendResult, setBackendResult] = useState<unknown>(null);
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [replanOpen, setReplanOpen] = useState(false);
  const [dataInputOpen, setDataInputOpen] = useState(false);
  const [ganttScroll, setGanttScroll] = useState(0);

  const handleMachineScroll = useCallback((sl: number) => setGanttScroll(sl), []);
  const handleOperatorScroll = useCallback((sl: number) => setGanttScroll(sl), []);

  const dashboardData: DashboardData | null = useMemo(() => {
    if (!backendResult || !solverMethod) return null;
    try {
      return adaptResult(backendResult, solverMethod);
    } catch {
      return null;
    }
  }, [backendResult, solverMethod]);

  return (
    <AnimatePresence mode="wait">
      {phase === 'setup' && (
        <motion.div key="setup" exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
          <SetupPage onOptimize={(data) => {
            setSetupData(data);
            setPhase('method-select');
          }} />
        </motion.div>
      )}

      {phase === 'method-select' && (
        <motion.div key="method-select" exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
          <SolverMethodSelect
            companySlug={setupData?.companySlug ?? null}
            hasConsultation={setupData?.hasConsultation ?? false}
            onSelect={(method) => {
              setSolverMethod(method);
              setPhase('optimizing');
            }}
            onBack={() => setPhase('setup')}
          />
        </motion.div>
      )}

      {phase === 'optimizing' && (
        <motion.div key="optimizing" exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
          <OptimizationLoader
            method={solverMethod!}
            companySlug={setupData?.companySlug ?? null}
            setupData={setupData!}
            onComplete={(result) => {
              setBackendResult(result);
              setPhase('dashboard');
            }}
          />
        </motion.div>
      )}

      {phase === 'dashboard' && dashboardData && (
        <DashboardContext.Provider value={dashboardData}>
          <motion.div
            key="dashboard"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6 }}
          >
            <div className="min-h-screen bg-background">
              <div className="max-w-[1600px] mx-auto px-4 sm:px-6 py-6 space-y-6">
                <DashboardHeader onReplan={() => setReplanOpen(true)} onAddData={() => setDataInputOpen(true)} />
                <KPISummary />

                <GanttSection title="Gantt Macchine" defaultOpen={false}>
                  <MachineGantt
                    selectedOrder={selectedOrder}
                    onSelectOrder={setSelectedOrder}
                    onScroll={handleMachineScroll}
                    scrollLeft={ganttScroll}
                  />
                </GanttSection>
                <GanttSection title="Gantt Operatori" defaultOpen={false}>
                  <OperatorGantt
                    selectedOrder={selectedOrder}
                    onSelectOrder={setSelectedOrder}
                    onScroll={handleOperatorScroll}
                    scrollLeft={ganttScroll}
                  />
                </GanttSection>

                <BottleneckChart />
                <WhatIfAnalysis />

                <KeyDecisions />

                <OrdersTable selectedOrder={selectedOrder} onSelectOrder={setSelectedOrder} />
                <OperationalPlan />

                <div className="text-center py-4 text-xs text-muted-foreground">
                  Generato da <span className="text-primary font-semibold">DAINO AI</span> — metodo: {solverMethod} | costo: ${dashboardData.costUsd.toFixed(3)}
                </div>
              </div>

              <ReplanModal open={replanOpen} onClose={() => setReplanOpen(false)} />
              <DataInputModal open={dataInputOpen} onClose={() => setDataInputOpen(false)} />
            </div>
          </motion.div>
        </DashboardContext.Provider>
      )}
    </AnimatePresence>
  );
}
