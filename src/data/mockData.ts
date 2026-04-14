// ==================== TYPES ====================

export type Priority = 'alta' | 'media' | 'bassa';
export type Shift = 'Mattina' | 'Pomeriggio';
export type OrderStatus = 'in-tempo' | 'in-ritardo';

export interface Machine {
  id: string;
  name: string;
  shortName: string;
}

export interface Operator {
  id: string;
  name: string;
  shift: Shift;
  qualifiedMachines: string[];
}

export interface Operation {
  id: string;
  orderId: string;
  machineId: string;
  operatorId: string;
  setupMinutes: number;
  processingMinutes: number;
  startMinute: number;
  sequence: number;
  description: string;
}

export interface Order {
  id: string;
  product: string;
  quantity: number;
  priority: Priority;
  priorityWeight: number;
  deadline: string;
  deadlineMinute: number;
  completionMinute: number;
  status: OrderStatus;
  operationCount: number;
  client: string;
}

export interface MaintenanceWindow {
  machineId: string;
  startMinute: number;
  durationMinutes: number;
  description: string;
}

export interface KeyDecision {
  title: string;
  description: string;
  impact: string;
  icon: 'priority' | 'bottleneck' | 'sequence' | 'operator' | 'maintenance';
}

// ==================== MACHINES ====================
// Dairy production line: pasteurization, curd processing, molding, packaging, cold storage

export const machines: Machine[] = [
  { id: 'M01', name: 'Pastorizzatore Continuo', shortName: 'Pastorizz.' },
  { id: 'M02', name: 'Caldaia Polivalente', shortName: 'Caldaia' },
  { id: 'M03', name: 'Formatrice/Filatrice', shortName: 'Filatrice' },
  { id: 'M04', name: 'Confezionatrice Automatica', shortName: 'Confezion.' },
  { id: 'M05', name: 'Cella di Stagionatura', shortName: 'Stagionat.' },
];

// ==================== OPERATORS ====================

export const operators: Operator[] = [
  { id: 'OP01', name: 'Antonio Esposito', shift: 'Mattina', qualifiedMachines: ['M01', 'M02', 'M03'] },
  { id: 'OP02', name: 'Giuseppe Ferrara', shift: 'Mattina', qualifiedMachines: ['M01', 'M04'] },
  { id: 'OP03', name: 'Salvatore Greco', shift: 'Mattina', qualifiedMachines: ['M02', 'M03', 'M05'] },
  { id: 'OP04', name: 'Francesco De Luca', shift: 'Mattina', qualifiedMachines: ['M04', 'M05'] },
  { id: 'OP05', name: 'Vincenzo Martino', shift: 'Pomeriggio', qualifiedMachines: ['M01', 'M02'] },
  { id: 'OP06', name: 'Carmine Sorrentino', shift: 'Pomeriggio', qualifiedMachines: ['M02', 'M03', 'M05'] },
  { id: 'OP07', name: 'Raffaele Amato', shift: 'Pomeriggio', qualifiedMachines: ['M01', 'M03', 'M04'] },
  { id: 'OP08', name: 'Pasquale Vitale', shift: 'Pomeriggio', qualifiedMachines: ['M04', 'M05'] },
];

// ==================== ORDERS ====================

export const orders: Order[] = [
  { id: 'COM-001', product: 'Mozzarella di Bufala DOP 250g', quantity: 500, priority: 'alta', priorityWeight: 5, deadline: 'Giorno 2', deadlineMinute: 960, completionMinute: 890, status: 'in-tempo', operationCount: 4, client: 'GDO CentroSud Srl' },
  { id: 'COM-002', product: 'Ricotta Fresca 500g', quantity: 300, priority: 'media', priorityWeight: 2, deadline: 'Giorno 3', deadlineMinute: 1440, completionMinute: 1320, status: 'in-tempo', operationCount: 3, client: 'Distribuzione Campana SpA' },
  { id: 'COM-003', product: 'Burrata 200g', quantity: 400, priority: 'alta', priorityWeight: 5, deadline: 'Giorno 2', deadlineMinute: 960, completionMinute: 920, status: 'in-tempo', operationCount: 4, client: 'Ristoranti Stellati Network' },
  { id: 'COM-004', product: 'Caciocavallo Silano 1kg', quantity: 80, priority: 'bassa', priorityWeight: 1, deadline: 'Giorno 3', deadlineMinute: 1440, completionMinute: 1510, status: 'in-ritardo', operationCount: 3, client: 'Salumeria Tradizionale Srl' },
  { id: 'COM-005', product: 'Fior di Latte 300g', quantity: 600, priority: 'alta', priorityWeight: 5, deadline: 'Giorno 2.5', deadlineMinute: 1200, completionMinute: 1150, status: 'in-tempo', operationCount: 3, client: 'Pizzerie Napoletane Consorzio' },
  { id: 'COM-006', product: 'Scamorza Affumicata 350g', quantity: 200, priority: 'media', priorityWeight: 2, deadline: 'Giorno 3', deadlineMinute: 1440, completionMinute: 1400, status: 'in-tempo', operationCount: 3, client: 'Export Food Italia SpA' },
  { id: 'COM-007', product: 'Provola Dolce 500g', quantity: 150, priority: 'bassa', priorityWeight: 1, deadline: 'Giorno 2.5', deadlineMinute: 1200, completionMinute: 1280, status: 'in-ritardo', operationCount: 2, client: 'Mercato Locale Avellino' },
  { id: 'COM-008', product: 'Mozzarella Treccia 1kg', quantity: 250, priority: 'alta', priorityWeight: 5, deadline: 'Giorno 3', deadlineMinute: 1440, completionMinute: 1380, status: 'in-tempo', operationCount: 4, client: 'HoReCa Distribuzione Srl' },
  { id: 'COM-009', product: 'Stracciatella 250g', quantity: 180, priority: 'media', priorityWeight: 2, deadline: 'Giorno 2', deadlineMinute: 960, completionMinute: 940, status: 'in-tempo', operationCount: 3, client: 'Gastronomia Pugliese SpA' },
  { id: 'COM-010', product: 'Ricotta Salata 300g', quantity: 120, priority: 'bassa', priorityWeight: 1, deadline: 'Giorno 2', deadlineMinute: 960, completionMinute: 1020, status: 'in-ritardo', operationCount: 3, client: 'Caseifici Uniti Srl' },
  { id: 'COM-011', product: 'Nodini di Mozzarella 150g', quantity: 350, priority: 'media', priorityWeight: 2, deadline: 'Giorno 3.5', deadlineMinute: 1680, completionMinute: 1600, status: 'in-tempo', operationCount: 3, client: 'GDO CentroSud Srl' },
  { id: 'COM-012', product: 'Ciliegine di Bufala 250g', quantity: 450, priority: 'alta', priorityWeight: 5, deadline: 'Giorno 3', deadlineMinute: 1440, completionMinute: 1410, status: 'in-tempo', operationCount: 2, client: 'Supermercati Del Sud SpA' },
  { id: 'COM-013', product: 'Primo Sale 500g', quantity: 200, priority: 'bassa', priorityWeight: 1, deadline: 'Giorno 3.5', deadlineMinute: 1680, completionMinute: 1650, status: 'in-tempo', operationCount: 2, client: 'Latteria Aversana Srl' },
  { id: 'COM-014', product: 'Mozzarella per Pizza 2kg', quantity: 100, priority: 'media', priorityWeight: 2, deadline: 'Giorno 3', deadlineMinute: 1440, completionMinute: 1420, status: 'in-tempo', operationCount: 3, client: 'Pizzerie Napoletane Consorzio' },
  { id: 'COM-015', product: 'Burrata Affumicata 200g', quantity: 150, priority: 'media', priorityWeight: 2, deadline: 'Giorno 3.5', deadlineMinute: 1680, completionMinute: 1640, status: 'in-tempo', operationCount: 3, client: 'Ristoranti Stellati Network' },
  { id: 'COM-016', product: 'Bocconcini 200g', quantity: 400, priority: 'bassa', priorityWeight: 1, deadline: 'Giorno 3', deadlineMinute: 1440, completionMinute: 1430, status: 'in-tempo', operationCount: 2, client: 'Export Food Italia SpA' },
  { id: 'COM-017', product: 'Mascarpone 500g', quantity: 100, priority: 'media', priorityWeight: 2, deadline: 'Giorno 3.5', deadlineMinute: 1680, completionMinute: 1660, status: 'in-tempo', operationCount: 3, client: 'Pasticceria Moderna Srl' },
  { id: 'COM-018', product: 'Caciotta Fresca 400g', quantity: 90, priority: 'bassa', priorityWeight: 1, deadline: 'Giorno 3.5', deadlineMinute: 1680, completionMinute: 1670, status: 'in-tempo', operationCount: 3, client: 'Mercato Locale Avellino' },
  { id: 'COM-019', product: 'Stracchino 250g', quantity: 250, priority: 'media', priorityWeight: 2, deadline: 'Giorno 3.5', deadlineMinute: 1680, completionMinute: 1620, status: 'in-tempo', operationCount: 2, client: 'GDO CentroSud Srl' },
  { id: 'COM-020', product: 'Yogurt Artigianale 125g', quantity: 800, priority: 'bassa', priorityWeight: 1, deadline: 'Giorno 3.5', deadlineMinute: 1680, completionMinute: 1670, status: 'in-tempo', operationCount: 3, client: 'Bio Market Italia SpA' },
];

// ==================== OPERATIONS ====================

export const operations: Operation[] = [
  // COM-001 (Mozzarella di Bufala DOP, alta) - Pastorizzatore → Caldaia → Filatrice → Confezionatrice
  { id: 'OP-001-1', orderId: 'COM-001', machineId: 'M01', operatorId: 'OP01', setupMinutes: 15, processingMinutes: 60, startMinute: 0, sequence: 1, description: 'Pastorizzazione latte di bufala' },
  { id: 'OP-001-2', orderId: 'COM-001', machineId: 'M02', operatorId: 'OP03', setupMinutes: 20, processingMinutes: 90, startMinute: 75, sequence: 2, description: 'Cagliata e maturazione' },
  { id: 'OP-001-3', orderId: 'COM-001', machineId: 'M03', operatorId: 'OP01', setupMinutes: 10, processingMinutes: 45, startMinute: 195, sequence: 3, description: 'Filatura e formatura' },
  { id: 'OP-001-4', orderId: 'COM-001', machineId: 'M04', operatorId: 'OP04', setupMinutes: 15, processingMinutes: 80, startMinute: 260, sequence: 4, description: 'Confezionamento in liquido' },

  // COM-002 (Ricotta Fresca, media) - Caldaia → Pastorizzatore → Confezionatrice
  { id: 'OP-002-1', orderId: 'COM-002', machineId: 'M02', operatorId: 'OP01', setupMinutes: 20, processingMinutes: 80, startMinute: 185, sequence: 1, description: 'Riscaldamento siero e acidificazione' },
  { id: 'OP-002-2', orderId: 'COM-002', machineId: 'M01', operatorId: 'OP02', setupMinutes: 10, processingMinutes: 50, startMinute: 300, sequence: 2, description: 'Trattamento termico finale' },
  { id: 'OP-002-3', orderId: 'COM-002', machineId: 'M04', operatorId: 'OP07', setupMinutes: 15, processingMinutes: 60, startMinute: 520, sequence: 3, description: 'Dosatura e confezionamento' },

  // COM-003 (Burrata, alta) - Pastorizzatore → Caldaia → Filatrice → Confezionatrice
  { id: 'OP-003-1', orderId: 'COM-003', machineId: 'M01', operatorId: 'OP02', setupMinutes: 20, processingMinutes: 70, startMinute: 75, sequence: 1, description: 'Pastorizzazione latte vaccino' },
  { id: 'OP-003-2', orderId: 'COM-003', machineId: 'M02', operatorId: 'OP03', setupMinutes: 25, processingMinutes: 110, startMinute: 190, sequence: 2, description: 'Cagliata e preparazione stracciatella' },
  { id: 'OP-003-3', orderId: 'COM-003', machineId: 'M03', operatorId: 'OP03', setupMinutes: 15, processingMinutes: 55, startMinute: 340, sequence: 3, description: 'Filatura involucro e riempimento' },
  { id: 'OP-003-4', orderId: 'COM-003', machineId: 'M04', operatorId: 'OP04', setupMinutes: 10, processingMinutes: 30, startMinute: 420, sequence: 4, description: 'Confezionamento delicato' },

  // COM-004 (Caciocavallo, bassa) - Pastorizzatore → Caldaia → Stagionatura
  { id: 'OP-004-1', orderId: 'COM-004', machineId: 'M01', operatorId: 'OP05', setupMinutes: 25, processingMinutes: 100, startMinute: 510, sequence: 1, description: 'Pastorizzazione latte intero' },
  { id: 'OP-004-2', orderId: 'COM-004', machineId: 'M02', operatorId: 'OP05', setupMinutes: 15, processingMinutes: 70, startMinute: 650, sequence: 2, description: 'Cagliata, filatura e modellatura' },
  { id: 'OP-004-3', orderId: 'COM-004', machineId: 'M05', operatorId: 'OP08', setupMinutes: 20, processingMinutes: 90, startMinute: 870, sequence: 3, description: 'Salatura e avvio stagionatura' },

  // COM-005 (Fior di Latte, alta) - Pastorizzatore → Caldaia → Filatrice
  { id: 'OP-005-1', orderId: 'COM-005', machineId: 'M01', operatorId: 'OP01', setupMinutes: 15, processingMinutes: 80, startMinute: 165, sequence: 1, description: 'Pastorizzazione latte fresco' },
  { id: 'OP-005-2', orderId: 'COM-005', machineId: 'M02', operatorId: 'OP01', setupMinutes: 20, processingMinutes: 90, startMinute: 280, sequence: 2, description: 'Cagliata rapida' },
  { id: 'OP-005-3', orderId: 'COM-005', machineId: 'M03', operatorId: 'OP06', setupMinutes: 15, processingMinutes: 60, startMinute: 510, sequence: 3, description: 'Filatura e porzionatura' },

  // COM-006 (Scamorza Affumicata, media) - Pastorizzatore → Filatrice → Stagionatura
  { id: 'OP-006-1', orderId: 'COM-006', machineId: 'M01', operatorId: 'OP05', setupMinutes: 15, processingMinutes: 55, startMinute: 640, sequence: 1, description: 'Pastorizzazione' },
  { id: 'OP-006-2', orderId: 'COM-006', machineId: 'M03', operatorId: 'OP06', setupMinutes: 20, processingMinutes: 70, startMinute: 740, sequence: 2, description: 'Filatura e modellatura a pera' },
  { id: 'OP-006-3', orderId: 'COM-006', machineId: 'M05', operatorId: 'OP06', setupMinutes: 10, processingMinutes: 50, startMinute: 850, sequence: 3, description: 'Affumicatura naturale' },

  // COM-007 (Provola Dolce, bassa) - Caldaia → Filatrice
  { id: 'OP-007-1', orderId: 'COM-007', machineId: 'M02', operatorId: 'OP05', setupMinutes: 15, processingMinutes: 65, startMinute: 590, sequence: 1, description: 'Cagliata e maturazione pasta' },
  { id: 'OP-007-2', orderId: 'COM-007', machineId: 'M03', operatorId: 'OP07', setupMinutes: 10, processingMinutes: 45, startMinute: 700, sequence: 2, description: 'Filatura e formatura' },

  // COM-008 (Mozzarella Treccia, alta) - Pastorizzatore → Caldaia → Filatrice → Confezionatrice
  { id: 'OP-008-1', orderId: 'COM-008', machineId: 'M01', operatorId: 'OP07', setupMinutes: 20, processingMinutes: 75, startMinute: 360, sequence: 1, description: 'Pastorizzazione latte' },
  { id: 'OP-008-2', orderId: 'COM-008', machineId: 'M02', operatorId: 'OP01', setupMinutes: 30, processingMinutes: 120, startMinute: 470, sequence: 2, description: 'Cagliata lunga maturazione' },
  { id: 'OP-008-3', orderId: 'COM-008', machineId: 'M03', operatorId: 'OP06', setupMinutes: 20, processingMinutes: 65, startMinute: 640, sequence: 3, description: 'Filatura a treccia manuale' },
  { id: 'OP-008-4', orderId: 'COM-008', machineId: 'M04', operatorId: 'OP08', setupMinutes: 10, processingMinutes: 25, startMinute: 750, sequence: 4, description: 'Confezionamento' },

  // COM-009 (Stracciatella, media) - Pastorizzatore → Caldaia → Confezionatrice
  { id: 'OP-009-1', orderId: 'COM-009', machineId: 'M01', operatorId: 'OP02', setupMinutes: 20, processingMinutes: 85, startMinute: 170, sequence: 1, description: 'Pastorizzazione panna e latte' },
  { id: 'OP-009-2', orderId: 'COM-009', machineId: 'M02', operatorId: 'OP03', setupMinutes: 15, processingMinutes: 50, startMinute: 330, sequence: 2, description: 'Sfilacciatura pasta e panna' },
  { id: 'OP-009-3', orderId: 'COM-009', machineId: 'M04', operatorId: 'OP04', setupMinutes: 10, processingMinutes: 40, startMinute: 415, sequence: 3, description: 'Confezionamento rapido in vaschette' },

  // COM-010 (Ricotta Salata, bassa) - Caldaia → Confezionatrice → Stagionatura
  { id: 'OP-010-1', orderId: 'COM-010', machineId: 'M02', operatorId: 'OP06', setupMinutes: 20, processingMinutes: 75, startMinute: 330, sequence: 1, description: 'Lavorazione ricotta e salatura' },
  { id: 'OP-010-2', orderId: 'COM-010', machineId: 'M04', operatorId: 'OP02', setupMinutes: 15, processingMinutes: 40, startMinute: 460, sequence: 2, description: 'Formatura e confezionamento' },
  { id: 'OP-010-3', orderId: 'COM-010', machineId: 'M05', operatorId: 'OP04', setupMinutes: 15, processingMinutes: 70, startMinute: 540, sequence: 3, description: 'Avvio stagionatura breve' },

  // COM-011 (Nodini, media) - Pastorizzatore → Caldaia → Filatrice
  { id: 'OP-011-1', orderId: 'COM-011', machineId: 'M01', operatorId: 'OP07', setupMinutes: 20, processingMinutes: 90, startMinute: 460, sequence: 1, description: 'Pastorizzazione' },
  { id: 'OP-011-2', orderId: 'COM-011', machineId: 'M02', operatorId: 'OP05', setupMinutes: 25, processingMinutes: 85, startMinute: 680, sequence: 2, description: 'Cagliata e maturazione' },
  { id: 'OP-011-3', orderId: 'COM-011', machineId: 'M03', operatorId: 'OP07', setupMinutes: 15, processingMinutes: 50, startMinute: 810, sequence: 3, description: 'Filatura e annodatura' },

  // COM-012 (Ciliegine di Bufala, alta) - Pastorizzatore → Filatrice
  { id: 'OP-012-1', orderId: 'COM-012', machineId: 'M01', operatorId: 'OP01', setupMinutes: 10, processingMinutes: 65, startMinute: 260, sequence: 1, description: 'Pastorizzazione latte bufala' },
  { id: 'OP-012-2', orderId: 'COM-012', machineId: 'M03', operatorId: 'OP01', setupMinutes: 10, processingMinutes: 55, startMinute: 400, sequence: 2, description: 'Formatura ciliegine' },

  // COM-013 (Primo Sale, bassa) - Caldaia → Confezionatrice
  { id: 'OP-013-1', orderId: 'COM-013', machineId: 'M02', operatorId: 'OP05', setupMinutes: 10, processingMinutes: 50, startMinute: 750, sequence: 1, description: 'Cagliata e pressatura' },
  { id: 'OP-013-2', orderId: 'COM-013', machineId: 'M04', operatorId: 'OP07', setupMinutes: 5, processingMinutes: 30, startMinute: 830, sequence: 2, description: 'Confezionamento sottovuoto' },

  // COM-014 (Mozzarella per Pizza, media) - Pastorizzatore → Caldaia → Confezionatrice
  { id: 'OP-014-1', orderId: 'COM-014', machineId: 'M01', operatorId: 'OP02', setupMinutes: 15, processingMinutes: 60, startMinute: 280, sequence: 1, description: 'Pastorizzazione industriale' },
  { id: 'OP-014-2', orderId: 'COM-014', machineId: 'M02', operatorId: 'OP01', setupMinutes: 20, processingMinutes: 55, startMinute: 400, sequence: 2, description: 'Cagliata a bassa umidità' },
  { id: 'OP-014-3', orderId: 'COM-014', machineId: 'M04', operatorId: 'OP04', setupMinutes: 10, processingMinutes: 45, startMinute: 640, sequence: 3, description: 'Confezionamento blocchi 2kg' },

  // COM-015 (Burrata Affumicata, media) - Pastorizzatore → Filatrice → Stagionatura
  { id: 'OP-015-1', orderId: 'COM-015', machineId: 'M01', operatorId: 'OP07', setupMinutes: 15, processingMinutes: 70, startMinute: 575, sequence: 1, description: 'Pastorizzazione' },
  { id: 'OP-015-2', orderId: 'COM-015', machineId: 'M03', operatorId: 'OP06', setupMinutes: 20, processingMinutes: 80, startMinute: 735, sequence: 2, description: 'Filatura, riempimento e chiusura' },
  { id: 'OP-015-3', orderId: 'COM-015', machineId: 'M05', operatorId: 'OP08', setupMinutes: 10, processingMinutes: 35, startMinute: 850, sequence: 3, description: 'Affumicatura leggera' },

  // COM-016 (Bocconcini, bassa) - Pastorizzatore → Filatrice
  { id: 'OP-016-1', orderId: 'COM-016', machineId: 'M01', operatorId: 'OP05', setupMinutes: 15, processingMinutes: 55, startMinute: 820, sequence: 1, description: 'Pastorizzazione' },
  { id: 'OP-016-2', orderId: 'COM-016', machineId: 'M03', operatorId: 'OP06', setupMinutes: 10, processingMinutes: 40, startMinute: 920, sequence: 2, description: 'Filatura e porzionatura bocconcini' },

  // COM-017 (Mascarpone, media) - Pastorizzatore → Caldaia → Confezionatrice
  { id: 'OP-017-1', orderId: 'COM-017', machineId: 'M01', operatorId: 'OP05', setupMinutes: 20, processingMinutes: 60, startMinute: 800, sequence: 1, description: 'Pastorizzazione panna' },
  { id: 'OP-017-2', orderId: 'COM-017', machineId: 'M02', operatorId: 'OP05', setupMinutes: 10, processingMinutes: 40, startMinute: 900, sequence: 2, description: 'Acidificazione e addensamento' },
  { id: 'OP-017-3', orderId: 'COM-017', machineId: 'M04', operatorId: 'OP08', setupMinutes: 15, processingMinutes: 50, startMinute: 970, sequence: 3, description: 'Dosatura in vaschette' },

  // COM-018 (Caciotta Fresca, bassa) - Pastorizzatore → Caldaia → Stagionatura
  { id: 'OP-018-1', orderId: 'COM-018', machineId: 'M01', operatorId: 'OP07', setupMinutes: 15, processingMinutes: 50, startMinute: 670, sequence: 1, description: 'Pastorizzazione' },
  { id: 'OP-018-2', orderId: 'COM-018', machineId: 'M02', operatorId: 'OP06', setupMinutes: 15, processingMinutes: 45, startMinute: 835, sequence: 2, description: 'Cagliata e formatura' },
  { id: 'OP-018-3', orderId: 'COM-018', machineId: 'M05', operatorId: 'OP08', setupMinutes: 10, processingMinutes: 40, startMinute: 910, sequence: 3, description: 'Salatura e stagionatura breve' },

  // COM-019 (Stracchino, media) - Caldaia → Confezionatrice
  { id: 'OP-019-1', orderId: 'COM-019', machineId: 'M02', operatorId: 'OP01', setupMinutes: 15, processingMinutes: 70, startMinute: 630, sequence: 1, description: 'Cagliata molle e sgocciolatura' },
  { id: 'OP-019-2', orderId: 'COM-019', machineId: 'M04', operatorId: 'OP07', setupMinutes: 10, processingMinutes: 55, startMinute: 745, sequence: 2, description: 'Confezionamento in atmosfera protetta' },

  // COM-020 (Yogurt Artigianale, bassa) - Pastorizzatore → Caldaia → Confezionatrice
  { id: 'OP-020-1', orderId: 'COM-020', machineId: 'M01', operatorId: 'OP02', setupMinutes: 10, processingMinutes: 45, startMinute: 390, sequence: 1, description: 'Pastorizzazione latte per yogurt' },
  { id: 'OP-020-2', orderId: 'COM-020', machineId: 'M02', operatorId: 'OP03', setupMinutes: 15, processingMinutes: 50, startMinute: 470, sequence: 2, description: 'Inoculo fermenti e fermentazione' },
  { id: 'OP-020-3', orderId: 'COM-020', machineId: 'M04', operatorId: 'OP04', setupMinutes: 10, processingMinutes: 30, startMinute: 550, sequence: 3, description: 'Dosatura in vasetti' },
];

// ==================== MAINTENANCE WINDOWS ====================

export const maintenanceWindows: MaintenanceWindow[] = [
  { machineId: 'M01', startMinute: 340, durationMinutes: 20, description: 'Sanificazione CIP pastorizzatore' },
  { machineId: 'M02', startMinute: 480, durationMinutes: 30, description: 'Pulizia caldaia e valvole' },
  { machineId: 'M03', startMinute: 600, durationMinutes: 15, description: 'Sostituzione lame filatrice' },
  { machineId: 'M04', startMinute: 420, durationMinutes: 25, description: 'Calibrazione dosatrice' },
];

// ==================== KEY DECISIONS ====================

export const keyDecisions: KeyDecision[] = [
  {
    title: 'COM-001 e COM-003 avviate per prime',
    description: 'Ordini alta priorità (peso 5×) con scadenza Giorno 2 — Mozzarella di Bufala DOP e Burrata — assegnati immediatamente al Pastorizzatore e Caldaia. Antonio Esposito e Giuseppe Ferrara coprono il turno mattina per massima continuità.',
    impact: 'Entrambi completati con 70 e 40 minuti di margine',
    icon: 'priority',
  },
  {
    title: 'Caldaia Polivalente come risorsa critica',
    description: 'La Caldaia (M02) è il collo di bottiglia con 14 lotti pianificati. Le cagliature più lunghe (COM-008 Treccia: 120 min) posizionate per minimizzare tempi morti tra un batch e l\'altro.',
    impact: 'Utilizzo M02 al 94,2% — massima efficienza',
    icon: 'bottleneck',
  },
  {
    title: 'Ordini bassa priorità sacrificati',
    description: 'COM-004 (Caciocavallo), COM-007 (Provola) e COM-010 (Ricotta Salata) posticipati per dare spazio ai prodotti freschi ad alta priorità. Il ritardo è di 150 min su 3 ordini non urgenti.',
    impact: 'Ritardo totale accettabile: 2,5 ore su ordini non critici',
    icon: 'sequence',
  },
  {
    title: 'Rotazione operatori tra turni',
    description: 'Vincenzo Martino (pomeriggio, qualificato Pastorizzatore+Caldaia) subentra ad Antonio Esposito (mattina). Continuità garantita sulla risorsa critica senza violazioni contrattuali.',
    impact: 'Zero tempi morti al cambio turno sulla Caldaia',
    icon: 'operator',
  },
  {
    title: 'Sanificazioni integrate nel piano',
    description: 'Le 4 finestre di sanificazione (totale 90 min) inserite quando le macchine avrebbero comunque atteso il completamento di fasi precedenti. Conformità HACCP garantita senza ritardi.',
    impact: 'Nessun impatto sul makespan',
    icon: 'maintenance',
  },
];

// ==================== KPIs ====================

export const kpis = {
  makespan: 51.2,
  makespanDays: 3.2,
  totalTardiness: 150,
  highPriorityOnTime: 100,
  peakUtilization: 94.2,
  avgUtilization: 82.5,
  totalOperations: 59,
  totalSetupTime: 855,
  totalProcessingTime: 3690,
  ordersOnTime: 17,
  ordersLate: 3,
  totalOrders: 20,
};

// ==================== HELPERS ====================

export const JOB_COLORS = [
  'var(--job-1)', 'var(--job-2)', 'var(--job-3)', 'var(--job-4)', 'var(--job-5)',
  'var(--job-6)', 'var(--job-7)', 'var(--job-8)', 'var(--job-9)', 'var(--job-10)',
];

export function getJobColor(orderId: string): string {
  const num = parseInt(orderId.replace('COM-0', '').replace('COM-', ''), 10);
  return JOB_COLORS[(num - 1) % JOB_COLORS.length];
}

export function getJobColorHex(orderId: string): string {
  const colors = [
    '#00c896', '#5b8af5', '#d4a843', '#e05aa0', '#e07a3a',
    '#3aa8d4', '#4dba6e', '#8a6fd4', '#a0c44a', '#d44a6a',
  ];
  const num = parseInt(orderId.replace('COM-0', '').replace('COM-', ''), 10);
  return colors[(num - 1) % colors.length];
}

export function minutesToTimeStr(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const day = Math.floor(hours / 8) + 1;
  const hourInDay = (hours % 8) + 6;
  return `G${day} ${String(hourInDay).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

export function getOperationsForMachine(machineId: string): Operation[] {
  return operations.filter(op => op.machineId === machineId).sort((a, b) => a.startMinute - b.startMinute);
}

export function getOperationsForOperator(operatorId: string): Operation[] {
  return operations.filter(op => op.operatorId === operatorId).sort((a, b) => a.startMinute - b.startMinute);
}

export function getOperationsForOrder(orderId: string): Operation[] {
  return operations.filter(op => op.orderId === orderId).sort((a, b) => a.sequence - b.sequence);
}

export function getMachineUtilization(machineId: string): number {
  const ops = getOperationsForMachine(machineId);
  const totalBusy = ops.reduce((sum, op) => sum + op.setupMinutes + op.processingMinutes, 0);
  const totalAvailable = kpis.makespan * 60;
  return Math.min(99, (totalBusy / totalAvailable) * 100);
}

export function getOperatorUtilization(operatorId: string): number {
  const ops = getOperationsForOperator(operatorId);
  const totalBusy = ops.reduce((sum, op) => sum + op.setupMinutes + op.processingMinutes, 0);
  const shiftMinutes = 8 * 60 * 3.2;
  return Math.min(99, (totalBusy / shiftMinutes) * 100);
}
