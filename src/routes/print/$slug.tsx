/**
 * Wave 15 — W15-03: print-only "production plan" route.
 *
 * The manager opens this from the dashboard's "Esporta PDF" button (see
 * `src/components/dashboard/DashboardHeader.tsx`). The button persists
 * the current `DashboardData` snapshot to `localStorage` (slug-scoped)
 * and opens this route in a new tab. The route reads the snapshot, builds
 * the print model with `buildPrintSchedule`, renders a minimal A4 layout,
 * and auto-fires `window.print()` so the user goes straight to the
 * native "Save as PDF" dialog.
 *
 * What's intentionally NOT rendered: Gantt chart, AI panels, What-If,
 * KPI cards, Ordini table, narrative. The whole point of W15-03 is that
 * the printed PDF only contains the operative schedule + headline KPIs.
 */
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { getSlugScoped, removeSlugScoped } from '@/lib/storage';
import {
  buildPrintSchedule,
  PRINT_SNAPSHOT_KEY,
  type PrintSchedule,
} from '@/lib/printSchedule';
import type { DashboardData } from '@/data/resultAdapter';
import { Printer } from 'lucide-react';

export const Route = createFileRoute('/print/$slug')({
  component: PrintPage,
});

interface Snapshot {
  data: DashboardData;
  companyName: string;
}

function readSnapshot(slug: string): Snapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = getSlugScoped(PRINT_SNAPSHOT_KEY, slug);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Snapshot;
    if (!parsed.data || !Array.isArray(parsed.data.machines)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function PrintPage() {
  const { slug } = Route.useParams();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const s = readSnapshot(slug);
    setSnapshot(s);
    if (s) {
      removeSlugScoped(PRINT_SNAPSHOT_KEY, slug);
    }
    setLoaded(true);
  }, [slug]);

  const sched: PrintSchedule | null = useMemo(() => {
    if (!snapshot) return null;
    return buildPrintSchedule(snapshot.data, snapshot.companyName);
  }, [snapshot]);

  // Auto-fire the native print dialog once the layout is on the DOM. The
  // small delay lets the browser paint the page so the print preview shows
  // the actual schedule (not a blank flash).
  useEffect(() => {
    if (!sched) return;
    const t = setTimeout(() => {
      try {
        window.print();
      } catch {
        // user may have disabled it; the "Stampa di nuovo" button stays available
      }
    }, 350);
    return () => clearTimeout(t);
  }, [sched]);

  if (!loaded) {
    return <div className="p-8 text-sm">Caricamento piano…</div>;
  }

  if (!sched) {
    return (
      <div className="p-8 max-w-2xl mx-auto text-sm">
        <h1 className="text-xl font-semibold mb-3">Nessun piano disponibile</h1>
        <p className="text-muted-foreground">
          Apri questa pagina dal bottone <strong>Esporta PDF</strong> della
          dashboard. Il piano viene caricato dal browser corrente: se hai
          chiuso la dashboard prima di esportare, ripianifica e riprova.
        </p>
      </div>
    );
  }

  return (
    <>
      <PrintStyles />
      <main className="print-root">
        <div className="reprint-bar no-print">
          <button
            onClick={() => window.print()}
            className="reprint-btn"
            type="button"
          >
            <Printer style={{ width: 14, height: 14 }} aria-hidden />
            Stampa di nuovo
          </button>
        </div>

        <header className="print-header">
          <div className="print-header-row">
            <div>
              <div className="print-company">{sched.header.companyName}</div>
              <div className="print-subtitle">Piano operativo di produzione</div>
            </div>
            <div className="print-meta">
              <div>Generato il {sched.header.generatedAt}</div>
              <div>
                Makespan totale: <strong>{sched.header.makespanHours} h</strong>
              </div>
              <div>
                On-time:&nbsp;
                <strong>{sched.header.onTimeRatePct}%</strong> ({sched.header.ordersOnTime}/{sched.header.totalOrders})
              </div>
            </div>
          </div>
        </header>

        {sched.sections.map((section) => (
          <section key={section.machineId} className="machine-section">
            <h2 className="machine-title">
              <span className="machine-id">{section.machineId}</span>
              <span className="machine-name">{section.machineName}</span>
              <span className="machine-count">
                {section.rows.length}&nbsp;operazion{section.rows.length === 1 ? 'e' : 'i'}
              </span>
            </h2>
            <table className="schedule-table">
              <thead>
                <tr>
                  <th style={{ width: '3%' }}>#</th>
                  <th style={{ width: '14%' }}>Ordine</th>
                  <th style={{ width: '20%' }}>Operatore</th>
                  <th style={{ width: '10%' }}>Setup</th>
                  <th style={{ width: '14%' }}>Lavorazione</th>
                  <th style={{ width: '19%' }}>Inizio</th>
                  <th style={{ width: '20%' }}>Fine</th>
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row) => (
                  <tr key={`${section.machineId}-${row.index}`}>
                    <td className="num">{row.index}</td>
                    <td className="mono">{row.ordine}</td>
                    <td>{row.operatore}</td>
                    <td className="num mono">{row.setupMinutes} min</td>
                    <td className="num mono">{row.processingMinutes} min</td>
                    <td className="mono">{row.startLabel}</td>
                    <td className="mono">{row.endLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}

        <footer className="print-footer">
          Generato da DAINO AI — Piano di produzione ottimizzato
        </footer>
      </main>
    </>
  );
}

/**
 * Inline print-only stylesheet. Kept inline so the route is self-contained
 * (it doesn't need any global CSS class to be defined first). `@page`
 * rules pin A4 portrait + sensible margins; `page-break-inside: avoid`
 * keeps each machine's table on a single page when possible.
 */
function PrintStyles() {
  const css = `
    .print-root {
      max-width: 210mm;
      margin: 0 auto;
      padding: 18mm 14mm 14mm 14mm;
      color: #111;
      background: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 11pt;
      line-height: 1.4;
    }
    .reprint-bar {
      display: flex;
      justify-content: flex-end;
      margin-bottom: 8mm;
    }
    .reprint-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 12px;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      background: #f8fafc;
      color: #0f172a;
      font-size: 10pt;
      cursor: pointer;
    }
    .reprint-btn:hover { background: #e2e8f0; }
    .print-header {
      border-bottom: 1.5px solid #111;
      padding-bottom: 4mm;
      margin-bottom: 6mm;
    }
    .print-header-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
      gap: 12mm;
    }
    .print-company {
      font-size: 18pt;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .print-subtitle {
      font-size: 11pt;
      color: #475569;
      margin-top: 2px;
    }
    .print-meta {
      text-align: right;
      font-size: 10pt;
      color: #334155;
      line-height: 1.55;
    }
    .print-meta strong { color: #111; }
    .machine-section {
      margin-bottom: 6mm;
      page-break-inside: avoid;
    }
    .machine-section + .machine-section {
      page-break-before: auto;
    }
    .machine-title {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin: 0 0 2mm 0;
      padding-bottom: 1.5mm;
      border-bottom: 1px solid #cbd5e1;
      font-size: 13pt;
      font-weight: 600;
    }
    .machine-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #0f766e;
      font-weight: 700;
    }
    .machine-name { color: #111; }
    .machine-count {
      margin-left: auto;
      font-size: 9pt;
      color: #64748b;
      font-weight: 400;
    }
    .schedule-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 9.5pt;
    }
    .schedule-table th {
      text-align: left;
      padding: 2mm 2mm;
      border-bottom: 1px solid #94a3b8;
      font-weight: 600;
      color: #334155;
      background: #f1f5f9;
    }
    .schedule-table td {
      padding: 1.8mm 2mm;
      border-bottom: 1px solid #e2e8f0;
      vertical-align: top;
    }
    .schedule-table tr:last-child td {
      border-bottom: 0;
    }
    .schedule-table td.mono,
    .schedule-table td.num {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .schedule-table td.num {
      text-align: right;
      white-space: nowrap;
    }
    .print-footer {
      margin-top: 8mm;
      padding-top: 3mm;
      border-top: 1px solid #cbd5e1;
      font-size: 8.5pt;
      color: #64748b;
      text-align: center;
    }
    @media print {
      @page {
        size: A4 portrait;
        margin: 14mm 12mm 12mm 12mm;
      }
      body { background: #fff !important; }
      .no-print { display: none !important; }
      .print-root {
        padding: 0;
        max-width: 100%;
      }
      .machine-section {
        page-break-inside: avoid;
      }
    }
    @media screen {
      body { background: #f1f5f9; }
    }
  `;
  return <style>{css}</style>;
}
