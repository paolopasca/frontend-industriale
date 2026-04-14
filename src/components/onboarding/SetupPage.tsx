import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Building2, Package, Wrench, Users, ChevronRight, ChevronLeft, Upload, Plus, Trash2, Zap, CheckCircle2, Loader2, Database } from 'lucide-react';
import { listCompanies, getCompany, type CompanySummary, type CompanyDetail } from '@/lib/api';

export interface SetupData {
  companyName: string;
  companySlug: string | null;
  sector: string;
  hasConsultation: boolean;
  consultationMd: string;
  dataFiles: string[];
  orders: { product: string; quantity: number; priority: string; deadline: string }[];
  machines: { name: string; type: string }[];
  operators: { name: string; shift: string }[];
}

const emptyOrder = { product: '', quantity: 1, priority: 'media', deadline: '' };
const emptyMachine = { name: '', type: '' };
const emptyOperator = { name: '', shift: 'Mattina' };

export function SetupPage({ onOptimize }: { onOptimize: (data: SetupData) => void }) {
  const [step, setStep] = useState(0);
  const [data, setData] = useState<SetupData>({
    companyName: '',
    companySlug: null,
    sector: '',
    hasConsultation: false,
    consultationMd: '',
    dataFiles: [],
    orders: [{ ...emptyOrder }],
    machines: [{ ...emptyMachine }],
    operators: [{ ...emptyOperator }],
  });

  // Company autocomplete state
  const [companies, setCompanies] = useState<CompanySummary[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [loadingCompanies, setLoadingCompanies] = useState(false);
  const [companyLoaded, setCompanyLoaded] = useState<CompanyDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch companies on mount
  useEffect(() => {
    setLoadingCompanies(true);
    listCompanies()
      .then(list => {
        setCompanies(list);
        setBackendOnline(true);
      })
      .catch(() => setBackendOnline(false))
      .finally(() => setLoadingCompanies(false));
  }, []);

  // Filter suggestions based on input
  const filteredCompanies = companies.filter(c =>
    c.name.toLowerCase().includes(data.companyName.toLowerCase()) ||
    c.slug.includes(data.companyName.toLowerCase().replace(/\s/g, '-'))
  );

  const handleSelectCompany = async (company: CompanySummary) => {
    setShowSuggestions(false);
    setLoadingDetail(true);
    try {
      const detail = await getCompany(company.slug);
      setCompanyLoaded(detail);
      setData(prev => ({
        ...prev,
        companyName: company.name,
        companySlug: company.slug,
        hasConsultation: detail.has_consultation,
        consultationMd: detail.consultation_md,
        dataFiles: detail.data_files,
      }));
    } catch {
      // fallback: use summary data
      setData(prev => ({
        ...prev,
        companyName: company.name,
        companySlug: company.slug,
        hasConsultation: company.has_consultation,
      }));
    } finally {
      setLoadingDetail(false);
    }
  };

  const steps = companyLoaded?.has_consultation
    ? [{ icon: Building2, label: 'Azienda', description: 'Informazioni generali' }]
    : [
        { icon: Building2, label: 'Azienda', description: 'Informazioni generali' },
        { icon: Package, label: 'Ordini', description: 'Ordini da pianificare' },
        { icon: Wrench, label: 'Macchine', description: 'Parco macchine' },
        { icon: Users, label: 'Operatori', description: 'Personale' },
      ];

  const lastStep = steps.length - 1;

  const canProceed = () => {
    if (step === 0) return data.companyName.trim().length > 0;
    if (step === 1) return data.orders.some(o => o.product.trim().length > 0);
    if (step === 2) return data.machines.some(m => m.name.trim().length > 0);
    if (step === 3) return data.operators.some(op => op.name.trim().length > 0);
    return true;
  };

  const handleUseDemoData = () => {
    // Find demo-commesse in companies list
    const demo = companies.find(c => c.slug === 'demo-commesse');
    if (demo) {
      handleSelectCompany(demo);
    } else {
      setData(prev => ({
        ...prev,
        companyName: 'Demo Commesse',
        companySlug: 'demo-commesse',
        sector: 'Meccanica di precisione',
      }));
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-3xl">
        {/* Hero Logo */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col items-center mb-8"
        >
          <div className="relative">
            <div className="absolute inset-0 blur-[60px] bg-primary/20 rounded-full scale-150" />
            <img
              src="/logo.png"
              alt="DAINO"
              className="relative w-40 h-40 object-contain drop-shadow-[0_0_30px_var(--teal-glow)]"
            />
          </div>
          <motion.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.4 }}
            className="text-muted-foreground text-xs tracking-[0.25em] uppercase mt-2"
          >
            Ottimizzazione Intelligente
          </motion.p>
        </motion.div>

        {/* Backend status */}
        {backendOnline !== null && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className={`flex items-center justify-center gap-2 mb-4 text-xs ${
              backendOnline ? 'text-primary/60' : 'text-destructive/60'
            }`}
          >
            <div className={`w-1.5 h-1.5 rounded-full ${backendOnline ? 'bg-primary animate-pulse' : 'bg-destructive'}`} />
            {backendOnline ? 'Backend connesso' : 'Backend offline — solo dati locali'}
          </motion.div>
        )}

        {/* Step indicators */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {steps.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <button
                onClick={() => i <= step && setStep(i)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
                  i === step
                    ? 'bg-primary/15 text-primary border border-primary/30'
                    : i < step
                      ? 'bg-primary/5 text-primary/60 border border-transparent cursor-pointer'
                      : 'bg-accent/50 text-muted-foreground border border-transparent'
                }`}
              >
                <s.icon className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{s.label}</span>
              </button>
              {i < steps.length - 1 && (
                <div className={`w-6 h-px ${i < step ? 'bg-primary/40' : 'bg-border'}`} />
              )}
            </div>
          ))}
        </div>

        {/* Step content */}
        <motion.div
          className="bg-card border border-border rounded-2xl p-8 shadow-xl"
          initial={{ opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4 }}
        >
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.25 }}
            >
              {step === 0 && (
                <div className="space-y-6">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground mb-1">La tua azienda</h2>
                    <p className="text-sm text-muted-foreground">
                      {backendOnline
                        ? 'Digita il nome — se esiste nel sistema, i dati vengono caricati automaticamente'
                        : "Inserisci le informazioni base dell'officina"}
                    </p>
                  </div>
                  <div className="space-y-4">
                    <div className="relative">
                      <label className="block text-sm font-medium text-foreground mb-1.5">Nome Azienda *</label>
                      <div className="relative">
                        <input
                          ref={inputRef}
                          value={data.companyName}
                          onChange={e => {
                            setData(prev => ({
                              ...prev,
                              companyName: e.target.value,
                              companySlug: null,
                              hasConsultation: false,
                              consultationMd: '',
                              dataFiles: [],
                            }));
                            setCompanyLoaded(null);
                            setShowSuggestions(true);
                          }}
                          onFocus={() => data.companyName.length > 0 && setShowSuggestions(true)}
                          onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                          placeholder="es. Demo Commesse, Apex Toy..."
                          className="w-full px-4 py-3 rounded-lg bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all text-sm"
                        />
                        {loadingDetail && (
                          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-primary animate-spin" />
                        )}
                        {companyLoaded && !loadingDetail && (
                          <CheckCircle2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-primary" />
                        )}
                      </div>

                      {/* Autocomplete dropdown */}
                      {showSuggestions && filteredCompanies.length > 0 && !companyLoaded && (
                        <motion.div
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="absolute z-50 w-full mt-1 bg-popover border border-border rounded-lg shadow-xl overflow-hidden"
                        >
                          {filteredCompanies.map(c => (
                            <button
                              key={c.slug}
                              onMouseDown={() => handleSelectCompany(c)}
                              className="w-full text-left px-4 py-3 hover:bg-accent/50 transition-colors border-b border-border last:border-0"
                            >
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium text-foreground">{c.name}</span>
                                <div className="flex items-center gap-2">
                                  {c.has_consultation && (
                                    <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/30">
                                      onboarded
                                    </span>
                                  )}
                                  {c.data_files.length > 0 && (
                                    <span className="text-[10px] text-muted-foreground">
                                      {c.data_files.length} file
                                    </span>
                                  )}
                                </div>
                              </div>
                              {c.summary && (
                                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{c.summary}</p>
                              )}
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </div>

                    {/* Company loaded banner */}
                    {companyLoaded && (
                      <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="rounded-xl border border-primary/20 bg-primary/5 p-4 space-y-3"
                      >
                        <div className="flex items-center gap-2">
                          <Database className="w-4 h-4 text-primary" />
                          <span className="text-sm font-semibold text-primary">Azienda trovata nel sistema</span>
                        </div>
                        {companyLoaded.has_consultation && (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <CheckCircle2 className="w-3 h-3 text-primary" />
                            Consultation presente — onboarding gia completato
                          </div>
                        )}
                        {companyLoaded.data_files.length > 0 && (
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <CheckCircle2 className="w-3 h-3 text-primary" />
                            {companyLoaded.data_files.length} file dati: {companyLoaded.data_files.join(', ')}
                          </div>
                        )}
                        {companyLoaded.has_consultation && (
                          <p className="text-xs text-muted-foreground/80 italic">
                            I dati vengono caricati dal backend — puoi procedere direttamente alla scelta del metodo.
                          </p>
                        )}
                      </motion.div>
                    )}

                    {!companyLoaded && (
                      <div>
                        <label className="block text-sm font-medium text-foreground mb-1.5">Settore</label>
                        <input
                          value={data.sector}
                          onChange={e => setData({ ...data, sector: e.target.value })}
                          placeholder="es. Meccanica di precisione"
                          className="w-full px-4 py-3 rounded-lg bg-input border border-border text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 transition-all text-sm"
                        />
                      </div>
                    )}
                  </div>
                  {backendOnline && !companyLoaded && (
                    <button
                      onClick={handleUseDemoData}
                      disabled={loadingCompanies}
                      className="w-full py-3 rounded-lg border border-dashed border-primary/30 text-primary text-sm font-medium hover:bg-primary/5 transition-colors flex items-center justify-center gap-2"
                    >
                      <Zap className="w-4 h-4" />
                      Carica Demo Commesse dal backend
                    </button>
                  )}
                </div>
              )}

              {step === 1 && !companyLoaded?.has_consultation && (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-lg font-semibold text-foreground mb-1">Ordini da Pianificare</h2>
                      <p className="text-sm text-muted-foreground">Aggiungi i prodotti da schedulare</p>
                    </div>
                    <button className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 px-3 py-1.5 rounded-lg border border-primary/20 hover:bg-primary/5 transition-colors">
                      <Upload className="w-3.5 h-3.5" />
                      Importa CSV
                    </button>
                  </div>
                  <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
                    {data.orders.map((order, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="grid grid-cols-[1fr_80px_100px_120px_32px] gap-2 items-end"
                      >
                        <div>
                          {i === 0 && <label className="block text-xs text-muted-foreground mb-1">Prodotto</label>}
                          <input
                            value={order.product}
                            onChange={e => {
                              const o = [...data.orders]; o[i] = { ...o[i], product: e.target.value }; setData({ ...data, orders: o });
                            }}
                            placeholder="Flangia 120"
                            className="w-full px-3 py-2 rounded-md bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
                          />
                        </div>
                        <div>
                          {i === 0 && <label className="block text-xs text-muted-foreground mb-1">Qta</label>}
                          <input
                            type="number"
                            value={order.quantity}
                            onChange={e => {
                              const o = [...data.orders]; o[i] = { ...o[i], quantity: +e.target.value }; setData({ ...data, orders: o });
                            }}
                            className="w-full px-3 py-2 rounded-md bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary/40 font-mono"
                          />
                        </div>
                        <div>
                          {i === 0 && <label className="block text-xs text-muted-foreground mb-1">Priorita</label>}
                          <select
                            value={order.priority}
                            onChange={e => {
                              const o = [...data.orders]; o[i] = { ...o[i], priority: e.target.value }; setData({ ...data, orders: o });
                            }}
                            className="w-full px-3 py-2 rounded-md bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
                          >
                            <option value="alta">Alta</option>
                            <option value="media">Media</option>
                            <option value="bassa">Bassa</option>
                          </select>
                        </div>
                        <div>
                          {i === 0 && <label className="block text-xs text-muted-foreground mb-1">Scadenza</label>}
                          <input
                            type="date"
                            value={order.deadline}
                            onChange={e => {
                              const o = [...data.orders]; o[i] = { ...o[i], deadline: e.target.value }; setData({ ...data, orders: o });
                            }}
                            className="w-full px-3 py-2 rounded-md bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
                          />
                        </div>
                        <button
                          onClick={() => {
                            if (data.orders.length > 1) {
                              setData({ ...data, orders: data.orders.filter((_, j) => j !== i) });
                            }
                          }}
                          className="p-2 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </motion.div>
                    ))}
                  </div>
                  <button
                    onClick={() => setData({ ...data, orders: [...data.orders, { ...emptyOrder }] })}
                    className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
                  >
                    <Plus className="w-4 h-4" /> Aggiungi ordine
                  </button>
                </div>
              )}

              {step === 2 && !companyLoaded?.has_consultation && (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground mb-1">Parco Macchine</h2>
                    <p className="text-sm text-muted-foreground">Definisci le macchine disponibili</p>
                  </div>
                  <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
                    {data.machines.map((m, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="grid grid-cols-[1fr_1fr_32px] gap-2 items-end"
                      >
                        <div>
                          {i === 0 && <label className="block text-xs text-muted-foreground mb-1">Nome macchina</label>}
                          <input
                            value={m.name}
                            onChange={e => {
                              const ms = [...data.machines]; ms[i] = { ...ms[i], name: e.target.value }; setData({ ...data, machines: ms });
                            }}
                            placeholder="Tornio CNC Haas"
                            className="w-full px-3 py-2 rounded-md bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
                          />
                        </div>
                        <div>
                          {i === 0 && <label className="block text-xs text-muted-foreground mb-1">Tipo</label>}
                          <input
                            value={m.type}
                            onChange={e => {
                              const ms = [...data.machines]; ms[i] = { ...ms[i], type: e.target.value }; setData({ ...data, machines: ms });
                            }}
                            placeholder="Tornio"
                            className="w-full px-3 py-2 rounded-md bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
                          />
                        </div>
                        <button
                          onClick={() => {
                            if (data.machines.length > 1) {
                              setData({ ...data, machines: data.machines.filter((_, j) => j !== i) });
                            }
                          }}
                          className="p-2 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </motion.div>
                    ))}
                  </div>
                  <button
                    onClick={() => setData({ ...data, machines: [...data.machines, { ...emptyMachine }] })}
                    className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
                  >
                    <Plus className="w-4 h-4" /> Aggiungi macchina
                  </button>
                </div>
              )}

              {step === 3 && !companyLoaded?.has_consultation && (
                <div className="space-y-4">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground mb-1">Operatori</h2>
                    <p className="text-sm text-muted-foreground">Il personale disponibile e i turni</p>
                  </div>
                  <div className="space-y-3 max-h-[350px] overflow-y-auto pr-1">
                    {data.operators.map((op, i) => (
                      <motion.div
                        key={i}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="grid grid-cols-[1fr_140px_32px] gap-2 items-end"
                      >
                        <div>
                          {i === 0 && <label className="block text-xs text-muted-foreground mb-1">Nome</label>}
                          <input
                            value={op.name}
                            onChange={e => {
                              const ops = [...data.operators]; ops[i] = { ...ops[i], name: e.target.value }; setData({ ...data, operators: ops });
                            }}
                            placeholder="Marco Bianchi"
                            className="w-full px-3 py-2 rounded-md bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
                          />
                        </div>
                        <div>
                          {i === 0 && <label className="block text-xs text-muted-foreground mb-1">Turno</label>}
                          <select
                            value={op.shift}
                            onChange={e => {
                              const ops = [...data.operators]; ops[i] = { ...ops[i], shift: e.target.value }; setData({ ...data, operators: ops });
                            }}
                            className="w-full px-3 py-2 rounded-md bg-input border border-border text-foreground text-sm focus:outline-none focus:ring-1 focus:ring-primary/40"
                          >
                            <option value="Mattina">Mattina (06-14)</option>
                            <option value="Pomeriggio">Pomeriggio (14-22)</option>
                          </select>
                        </div>
                        <button
                          onClick={() => {
                            if (data.operators.length > 1) {
                              setData({ ...data, operators: data.operators.filter((_, j) => j !== i) });
                            }
                          }}
                          className="p-2 rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </motion.div>
                    ))}
                  </div>
                  <button
                    onClick={() => setData({ ...data, operators: [...data.operators, { ...emptyOperator }] })}
                    className="flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
                  >
                    <Plus className="w-4 h-4" /> Aggiungi operatore
                  </button>
                </div>
              )}
            </motion.div>
          </AnimatePresence>

          {/* Navigation */}
          <div className="flex items-center justify-between mt-8 pt-6 border-t border-border">
            <button
              onClick={() => setStep(s => Math.max(0, s - 1))}
              disabled={step === 0}
              className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors"
            >
              <ChevronLeft className="w-4 h-4" /> Indietro
            </button>

            {step < lastStep ? (
              <button
                onClick={() => setStep(s => s + 1)}
                disabled={!canProceed()}
                className="flex items-center gap-2 px-6 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-40 transition-all"
              >
                Avanti <ChevronRight className="w-4 h-4" />
              </button>
            ) : (
              <motion.button
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => onOptimize(data)}
                disabled={!canProceed()}
                className="flex items-center gap-2 px-8 py-3 rounded-xl bg-primary text-primary-foreground text-sm font-bold hover:bg-primary/90 disabled:opacity-40 transition-all teal-glow"
              >
                <Zap className="w-5 h-5" />
                {companyLoaded?.has_consultation ? 'Scegli Metodo' : 'Ottimizza Produzione'}
              </motion.button>
            )}
          </div>
        </motion.div>
      </div>
    </div>
  );
}
