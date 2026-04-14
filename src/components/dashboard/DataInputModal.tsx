import { useState } from 'react';
import { X, Plus, Trash2, Upload, Send, Package, Cpu, Users, Settings, ChevronRight } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

type Tab = 'ordini' | 'macchine' | 'operatori' | 'vincoli';

interface OrderInput {
  id: string;
  product: string;
  quantity: string;
  priority: 'alta' | 'media' | 'bassa';
  deadline: string;
  client: string;
  operations: string;
}

interface MachineInput {
  id: string;
  name: string;
  type: string;
}

interface OperatorInput {
  id: string;
  name: string;
  shift: 'Mattina' | 'Pomeriggio';
  qualifiedMachines: string[];
  costPerHour: string;
}

const emptyOrder: OrderInput = { id: '', product: '', quantity: '', priority: 'media', deadline: '', client: '', operations: '' };
const emptyMachine: MachineInput = { id: '', name: '', type: '' };
const emptyOperator: OperatorInput = { id: '', name: '', shift: 'Mattina', qualifiedMachines: [], costPerHour: '' };

const tabs: { key: Tab; label: string; icon: typeof Package }[] = [
  { key: 'ordini', label: 'Ordini', icon: Package },
  { key: 'macchine', label: 'Macchine', icon: Cpu },
  { key: 'operatori', label: 'Operatori', icon: Users },
  { key: 'vincoli', label: 'Vincoli', icon: Settings },
];

export function DataInputModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<Tab>('ordini');
  const [orders, setOrders] = useState<OrderInput[]>([{ ...emptyOrder, id: 'COM-021' }]);
  const [machineInputs, setMachineInputs] = useState<MachineInput[]>([{ ...emptyMachine }]);
  const [operatorInputs, setOperatorInputs] = useState<OperatorInput[]>([{ ...emptyOperator }]);
  const [constraints, setConstraints] = useState('');
  const [maintenanceNotes, setMaintenanceNotes] = useState('');

  const addOrder = () => {
    const nextNum = orders.length + 21;
    setOrders([...orders, { ...emptyOrder, id: `COM-${String(nextNum).padStart(3, '0')}` }]);
  };

  const removeOrder = (i: number) => setOrders(orders.filter((_, idx) => idx !== i));
  const updateOrder = (i: number, field: keyof OrderInput, value: string) => {
    const updated = [...orders];
    updated[i] = { ...updated[i], [field]: value };
    setOrders(updated);
  };

  const addMachine = () => setMachineInputs([...machineInputs, { ...emptyMachine }]);
  const removeMachine = (i: number) => setMachineInputs(machineInputs.filter((_, idx) => idx !== i));
  const updateMachine = (i: number, field: keyof MachineInput, value: string) => {
    const updated = [...machineInputs];
    updated[i] = { ...updated[i], [field]: value };
    setMachineInputs(updated);
  };

  const addOperator = () => setOperatorInputs([...operatorInputs, { ...emptyOperator }]);
  const removeOperator = (i: number) => setOperatorInputs(operatorInputs.filter((_, idx) => idx !== i));
  const updateOperator = (i: number, field: keyof OperatorInput, value: string) => {
    const updated = [...operatorInputs];
    updated[i] = { ...updated[i], [field]: value } as OperatorInput;
    setOperatorInputs(updated);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-background/80 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-4xl max-h-[85vh] rounded-xl border border-border bg-card shadow-2xl flex flex-col"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
              <div>
                <h2 className="text-lg font-bold text-foreground">Inserimento Dati</h2>
                <p className="text-xs text-muted-foreground mt-0.5">Definisci ordini, risorse e vincoli per l'ottimizzazione</p>
              </div>
              <button onClick={onClose} className="p-1.5 rounded-md hover:bg-accent transition-colors">
                <X className="w-5 h-5 text-muted-foreground" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-border px-6 flex-shrink-0">
              {tabs.map(t => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors -mb-px ${
                    activeTab === t.key
                      ? 'border-primary text-primary'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <t.icon className="w-4 h-4" />
                  {t.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
              {activeTab === 'ordini' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-muted-foreground">Aggiungi gli ordini cliente da pianificare</p>
                    <div className="flex gap-2">
                      <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-xs text-muted-foreground hover:bg-accent transition-colors">
                        <Upload className="w-3.5 h-3.5" />
                        Importa CSV
                      </button>
                      <button onClick={addOrder} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-xs text-primary font-medium hover:bg-primary/20 transition-colors">
                        <Plus className="w-3.5 h-3.5" />
                        Aggiungi
                      </button>
                    </div>
                  </div>

                  {orders.map((order, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-4 rounded-lg border border-border bg-accent/20"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-mono font-semibold text-primary">{order.id || `Ordine ${i + 1}`}</span>
                        {orders.length > 1 && (
                          <button onClick={() => removeOrder(i)} className="p-1 rounded hover:bg-destructive/10 transition-colors">
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Prodotto</label>
                          <input
                            type="text"
                            value={order.product}
                            onChange={e => updateOrder(i, 'product', e.target.value)}
                            placeholder="Es: Flangia F-200"
                            className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Cliente</label>
                          <input
                            type="text"
                            value={order.client}
                            onChange={e => updateOrder(i, 'client', e.target.value)}
                            placeholder="Es: Meccanica Padana Srl"
                            className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Quantità</label>
                          <input
                            type="number"
                            value={order.quantity}
                            onChange={e => updateOrder(i, 'quantity', e.target.value)}
                            placeholder="50"
                            className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Priorità</label>
                          <select
                            value={order.priority}
                            onChange={e => updateOrder(i, 'priority', e.target.value)}
                            className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50"
                          >
                            <option value="alta">Alta (5×)</option>
                            <option value="media">Media (2×)</option>
                            <option value="bassa">Bassa (1×)</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Scadenza</label>
                          <input
                            type="text"
                            value={order.deadline}
                            onChange={e => updateOrder(i, 'deadline', e.target.value)}
                            placeholder="Es: Giorno 3"
                            className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                          />
                        </div>
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Operazioni (sequenza macchine)</label>
                          <input
                            type="text"
                            value={order.operations}
                            onChange={e => updateOrder(i, 'operations', e.target.value)}
                            placeholder="Es: M01→M02→M03"
                            className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                          />
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}

              {activeTab === 'macchine' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-muted-foreground">Definisci le macchine disponibili in officina</p>
                    <button onClick={addMachine} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-xs text-primary font-medium hover:bg-primary/20 transition-colors">
                      <Plus className="w-3.5 h-3.5" />
                      Aggiungi
                    </button>
                  </div>
                  {machineInputs.map((m, i) => (
                    <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-4 rounded-lg border border-border bg-accent/20">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-mono font-semibold text-primary">Macchina {i + 1}</span>
                        {machineInputs.length > 1 && (
                          <button onClick={() => removeMachine(i)} className="p-1 rounded hover:bg-destructive/10 transition-colors">
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">ID</label>
                          <input type="text" value={m.id} onChange={e => updateMachine(i, 'id', e.target.value)} placeholder="M06" className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50" />
                        </div>
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Nome</label>
                          <input type="text" value={m.name} onChange={e => updateMachine(i, 'name', e.target.value)} placeholder="Tornio CNC 2" className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50" />
                        </div>
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Tipo</label>
                          <select value={m.type} onChange={e => updateMachine(i, 'type', e.target.value)} className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50">
                            <option value="">Seleziona...</option>
                            <option value="tornio">Tornio</option>
                            <option value="fresa">Fresa</option>
                            <option value="rettifica">Rettifica</option>
                            <option value="trapano">Trapano</option>
                            <option value="saldatrice">Saldatrice</option>
                            <option value="altro">Altro</option>
                          </select>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}

              {activeTab === 'operatori' && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm text-muted-foreground">Definisci gli operatori, turni e qualifiche</p>
                    <button onClick={addOperator} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-xs text-primary font-medium hover:bg-primary/20 transition-colors">
                      <Plus className="w-3.5 h-3.5" />
                      Aggiungi
                    </button>
                  </div>
                  {operatorInputs.map((op, i) => (
                    <motion.div key={i} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-4 rounded-lg border border-border bg-accent/20">
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-xs font-mono font-semibold text-primary">Operatore {i + 1}</span>
                        {operatorInputs.length > 1 && (
                          <button onClick={() => removeOperator(i)} className="p-1 rounded hover:bg-destructive/10 transition-colors">
                            <Trash2 className="w-3.5 h-3.5 text-destructive" />
                          </button>
                        )}
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Nome</label>
                          <input type="text" value={op.name} onChange={e => updateOperator(i, 'name', e.target.value)} placeholder="Mario Verdi" className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50" />
                        </div>
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Turno</label>
                          <select value={op.shift} onChange={e => updateOperator(i, 'shift', e.target.value)} className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/50">
                            <option value="Mattina">Mattina (06-14)</option>
                            <option value="Pomeriggio">Pomeriggio (14-22)</option>
                          </select>
                        </div>
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Costo Orario (€)</label>
                          <input type="number" value={op.costPerHour} onChange={e => updateOperator(i, 'costPerHour', e.target.value)} placeholder="25" className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50" />
                        </div>
                        <div>
                          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Macchine Qualificate</label>
                          <input type="text" value={op.qualifiedMachines.join(', ')} onChange={e => updateOperator(i, 'qualifiedMachines', e.target.value)} placeholder="M01, M02, M03" className="mt-1 w-full rounded-md bg-input border border-border px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/50" />
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              )}

              {activeTab === 'vincoli' && (
                <div className="space-y-5">
                  <div>
                    <label className="text-sm font-medium text-foreground block mb-2">Vincoli Aggiuntivi</label>
                    <p className="text-xs text-muted-foreground mb-2">Descrivi eventuali vincoli specifici (precedenze, incompatibilità, finestre temporali...)</p>
                    <textarea
                      value={constraints}
                      onChange={e => setConstraints(e.target.value)}
                      placeholder="Es: COM-005 non può essere lavorata contemporaneamente a COM-003 sulla stessa macchina. L'operatore Marco Bianchi non è disponibile il Giorno 2 pomeriggio."
                      className="w-full h-28 rounded-lg bg-input border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground block mb-2">Manutenzione Programmata</label>
                    <p className="text-xs text-muted-foreground mb-2">Finestre di manutenzione previste per le macchine</p>
                    <textarea
                      value={maintenanceNotes}
                      onChange={e => setMaintenanceNotes(e.target.value)}
                      placeholder="Es: M01 manutenzione Giorno 2 ore 10:00-10:30. M05 sostituzione torcia Giorno 1 ore 14:00-14:45."
                      className="w-full h-28 rounded-lg bg-input border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 resize-none focus:outline-none focus:ring-1 focus:ring-primary/50"
                    />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-foreground block mb-2">Upload File Dati</label>
                    <div className="border-2 border-dashed border-border rounded-lg p-8 text-center hover:border-primary/30 transition-colors cursor-pointer">
                      <Upload className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">Trascina file CSV/Excel o clicca per caricare</p>
                      <p className="text-xs text-muted-foreground/60 mt-1">Formati supportati: .csv, .xlsx, .json</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t border-border flex-shrink-0 bg-accent/10">
              <div className="text-xs text-muted-foreground">
                {orders.length} ordini · {machineInputs.length} macchine · {operatorInputs.length} operatori
              </div>
              <div className="flex items-center gap-2">
                <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-muted-foreground hover:bg-accent transition-colors">
                  Annulla
                </button>
                <button className="flex items-center gap-2 px-5 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors">
                  <Send className="w-4 h-4" />
                  Ottimizza con AI
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
