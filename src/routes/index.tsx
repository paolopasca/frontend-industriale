import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useMemo, useEffect } from 'react';
import { migrateLegacyKeys } from '@/lib/storage';
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
import { ExplanationPanel } from '@/components/dashboard/ExplanationPanel';
import { AdvisorPanel } from '@/components/dashboard/AdvisorPanel';
import { DashboardContext } from '@/data/DashboardContext';
import { adaptResult, type DashboardData } from '@/data/resultAdapter';
import { Toaster } from '@/components/ui/sonner';

// Extract the raw `solution` + `kpis` blocks (flat Record<string, number>)
// from whatever shape the backend returned. solveTemplate → top-level
// `solution`/`kpis`; solveLLMOnly → nested under `result.kpi`/`result.piano`.
function extractAiInputs(raw: unknown): { solution: unknown; kpis: Record<string, number> } {
  if (!raw || typeof raw !== 'object') return { solution: null, kpis: {} };
  const r = raw as Record<string, unknown>;
  // Template / FJSP shape
  if (r.solution !== undefined) {
    const k = (r.kpis ?? {}) as Record<string, unknown>;
    return { solution: r.solution, kpis: toNumberMap(k) };
  }
  // LLM-only legacy shape
  const result = r.result as Record<string, unknown> | undefined;
  if (result) {
    return {
      solution: result.piano ?? result,
      kpis: toNumberMap((result.kpi ?? {}) as Record<string, unknown>),
    };
  }
  return { solution: raw, kpis: {} };
}

function toNumberMap(rec: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

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

  useEffect(() => {
    migrateLegacyKeys();
  }, []);

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

  const aiInputs = useMemo(() => extractAiInputs(backendResult), [backendResult]);

  return (
    <>
    <Toaster position="top-right" richColors />
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
                <DashboardHeader
                  onReplan={() => setReplanOpen(true)}
                  onAddData={() => setDataInputOpen(true)}
                  onReset={() => { setPhase('setup'); setBackendResult(null); setSolverMethod(null); }}
                  companySlug={setupData?.companySlug ?? null}
                />
                <KPISummary />

                <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
                  <div className="lg:col-span-3">
                    <ExplanationPanel
                      slug={setupData?.companySlug ?? null}
                      solution={aiInputs.solution}
                      kpis={aiInputs.kpis}
                    />
                  </div>
                  <div className="lg:col-span-2">
                    <AdvisorPanel
                      slug={setupData?.companySlug ?? null}
                      solution={aiInputs.solution}
                      kpis={aiInputs.kpis}
                    />
                  </div>
                </div>

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

              <ReplanModal
                open={replanOpen}
                onClose={() => setReplanOpen(false)}
                companySlug={setupData?.companySlug ?? null}
                onResult={(result) => setBackendResult(result)}
              />
              <DataInputModal
                open={dataInputOpen}
                onClose={() => setDataInputOpen(false)}
                companySlug={setupData?.companySlug ?? null}
              />
            </div>
          </motion.div>
        </DashboardContext.Provider>
      )}
    </AnimatePresence>
    </>
  );
}
