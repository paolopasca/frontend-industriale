import { createContext, useContext } from 'react';
import type { DashboardData } from './resultAdapter';

// Import mock data as fallback
import * as mock from './mockData';

const fallbackData: DashboardData = {
  machines: mock.machines,
  operators: mock.operators,
  operations: mock.operations,
  orders: mock.orders,
  maintenanceWindows: mock.maintenanceWindows,
  keyDecisions: mock.keyDecisions,
  kpis: mock.kpis,
  narrative: '',
  method: 'mock',
  costUsd: 0,
};

export const DashboardContext = createContext<DashboardData>(fallbackData);

export function useDashboard() {
  return useContext(DashboardContext);
}
