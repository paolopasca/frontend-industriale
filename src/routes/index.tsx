import { createFileRoute } from "@tanstack/react-router";
import { useState, useCallback, useMemo, useEffect } from 'react';
import { migrateLegacyKeys } from '@/lib/storage';
import { AnimatePresence, motion } from 'framer-motion';
import { SetupPage, type SetupData } from '@/components/onboarding/SetupPage';
import type { SolverMethod } from '@/components/onboarding/SolverMethodSelect';
import { OptimizationLoader } from '@/components/onboarding/OptimizationLoader';

// Wave 12: il prodotto usa SEMPRE `deterministic-json` (path
// ``daino.template_solve.template_solve()`` nel backend definitivo).
// Verificato Wave 7-11: 30 F-rules, ~75 pytest, smoke live OK,
// apply-whatif Wave 4.1-11 end-to-end funzionante. Vedi
// ``docs/come-funziona-il-frontend.md`` §2-4 + RESEARCH_LOG ADR-094..ADR-100.
//
// I path ``llm-only`` (wrapper FAKE su template_solve) e
// ``codegen-pipeline`` (arm_c compose, lento + costoso + non
// testato end-to-end nei pytest Wave 7-11) sono ora dead code:
// l'UI di selezione metodo non e' piu' raggiungibile, e il
// componente ``SolverMethodSelect`` sara' rimosso nel cleanup
// successivo. Le funzioni client ``solveLLMOnly`` /
// ``pipelineStart/Advance/Respond/Results`` in ``lib/api.ts``
// restano per ora (rimozione in PR follow-up).
const DEFAULT_SOLVER_METHOD: SolverMethod = 'deterministic-json';
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
import { SplitSuggestion } from '@/components/dashboard/SplitSuggestion';
import { ExplanationPanel } from '@/components/dashboard/ExplanationPanel';
import { AdvisorPanel } from '@/components/dashboard/AdvisorPanel';
import { ManagerChatPanel } from '@/components/dashboard/ManagerChatPanel';
import { DashboardContext } from '@/data/DashboardContext';
import { adaptResult, type DashboardData } from '@/data/resultAdapter';
import { Toaster } from '@/components/ui/sonner';
import { extractAiInputs, extractSolverStatus } from '@/lib/aiInputs';

export const Route = createFileRoute("/")({
  component: Index,
});

// Wave 12: ``method-select`` rimosso dal flow. La Phase resta come
// union type per minimizzare diff; il valore ``method-select`` non
// e' piu' settato in nessun ``setPhase`` chiamato dal flow vivo.
type Phase = 'setup' | 'method-select' | 'optimizing' | 'dashboard';

function Index() {
  const [phase, setPhase] = useState<Phase>('setup');
  const [setupData, setSetupData] = useState<SetupData | null>(null);
  // Wave 12: SolverMethod e' costante (DEFAULT_SOLVER_METHOD).
  // ``setSolverMethod`` resta solo per il reset (ridichiarazione
  // della costante per chiarezza del data flow); non c'e' piu'
  // selezione runtime.
  const [solverMethod, setSolverMethod] = useState<SolverMethod | null>(DEFAULT_SOLVER_METHOD);
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
  const solverStatus = useMemo(() => extractSolverStatus(backendResult), [backendResult]);

  return (
    <>
    <Toaster position="top-right" richColors />
    <AnimatePresence mode="wait">
      {phase === 'setup' && (
        <motion.div key="setup" exit={{ opacity: 0 }} transition={{ duration: 0.4 }}>
          <SetupPage onOptimize={(data) => {
            setSetupData(data);
            // Wave 12: skip ``method-select`` step. Vai diretto a
            // optimizing con ``deterministic-json`` (gia' settato in
            // ``solverMethod`` come default Wave 12).
            setPhase('optimizing');
          }} />
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
                  // Wave 12: reset riporta a 'setup' ma mantiene
                  // ``solverMethod`` su DEFAULT_SOLVER_METHOD (non null)
                  // per coerenza col nuovo flow lineare.
                  onReset={() => { setPhase('setup'); setBackendResult(null); setSolverMethod(DEFAULT_SOLVER_METHOD); }}
                  companySlug={setupData?.companySlug ?? null}
                  companyName={setupData?.companyName ?? null}
                  solverStatus={solverStatus}
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
                <WhatIfAnalysis
                  slug={setupData?.companySlug ?? null}
                  solution={aiInputs.solution}
                  kpis={aiInputs.kpis}
                  onAcceptResult={(result) => setBackendResult(result)}
                  originalBackendResult={backendResult}
                />
                <SplitSuggestion
                  slug={setupData?.companySlug ?? null}
                  solution={aiInputs.solution}
                  kpis={aiInputs.kpis}
                />

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
                originalSolution={backendResult ?? dashboardData}
                onResult={(result) => setBackendResult(result)}
              />
              <DataInputModal
                open={dataInputOpen}
                onClose={() => setDataInputOpen(false)}
                companySlug={setupData?.companySlug ?? null}
              />
              <ManagerChatPanel
                slug={setupData?.companySlug ?? null}
                solution={aiInputs.solution}
                kpis={aiInputs.kpis}
              />
            </div>
          </motion.div>
        </DashboardContext.Provider>
      )}
    </AnimatePresence>
    </>
  );
}
