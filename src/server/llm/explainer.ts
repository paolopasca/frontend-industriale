import type Anthropic from '@anthropic-ai/sdk';
import { getAnthropicClient } from './client';

export interface ExplainerInput {
  slug: string;
  solution?: unknown;
  kpis: Record<string, number>;
  consultationMd?: string;
  dataSchemaMd?: string;
}

export interface ExplainerResult {
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  aborted?: boolean;
}

export type OnChunk = (text: string) => void;

export type OnUsage = (usage: {
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}) => void;

export interface RunExplainerOptions {
  signal?: AbortSignal;
  onUsage?: OnUsage;
}

const MODEL = 'claude-sonnet-4-6';
const MAX_OUTPUT_TOKENS = 600;

// Sonnet 4.6 pricing per 1M tokens (USD).
const PRICE_INPUT_PER_M = 3.0;
const PRICE_OUTPUT_PER_M = 15.0;
const PRICE_CACHE_READ_PER_M = 0.3;
const PRICE_CACHE_WRITE_PER_M = 3.75;

// Bound the size of the solution we ship to the model (≤ ~50k input tokens).
const MAX_SOLUTION_PHASES = 100;
const MAX_SOLUTION_JSON_CHARS = 120_000;

type SolutionStatus =
  | 'OPTIMAL'
  | 'FEASIBLE'
  | 'INFEASIBLE'
  | 'EMPTY'
  | 'MALFORMED'
  | 'UNKNOWN';

interface NormalizedSolution {
  status: SolutionStatus;
  payload: unknown;
  trimmed: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeStatus(raw: unknown): SolutionStatus {
  if (typeof raw !== 'string') return 'UNKNOWN';
  const s = raw.toUpperCase();
  if (s === 'OPTIMAL') return 'OPTIMAL';
  if (s === 'FEASIBLE') return 'FEASIBLE';
  if (s === 'INFEASIBLE') return 'INFEASIBLE';
  return 'UNKNOWN';
}

function normalizeSolution(solution: unknown, kpis: Record<string, number>): NormalizedSolution {
  if (solution === undefined || solution === null) {
    return { status: 'EMPTY', payload: null, trimmed: false };
  }
  if (!isObject(solution)) {
    return { status: 'MALFORMED', payload: solution, trimmed: false };
  }

  const status = normalizeStatus(solution['status']);

  // Truncate fasi/schedule arrays if too long.
  let trimmed = false;
  const trim = (arr: unknown): unknown => {
    if (Array.isArray(arr) && arr.length > MAX_SOLUTION_PHASES) {
      trimmed = true;
      return [
        ...arr.slice(0, MAX_SOLUTION_PHASES),
        { _truncated: arr.length - MAX_SOLUTION_PHASES },
      ];
    }
    return arr;
  };
  const trimmedSolution: Record<string, unknown> = { ...solution };
  for (const key of ['fasi', 'schedule', 'tasks', 'phases', 'assignments']) {
    if (key in trimmedSolution) trimmedSolution[key] = trim(trimmedSolution[key]);
  }

  // Empty plan: no fasi/schedule and no positive KPI signal.
  const hasPlan = ['fasi', 'schedule', 'tasks', 'phases', 'assignments'].some((k) => {
    const v = trimmedSolution[k];
    return Array.isArray(v) && v.length > 0;
  });
  const hasKpis = Object.keys(kpis).length > 0;
  if (status === 'UNKNOWN' && !hasPlan && !hasKpis) {
    return { status: 'EMPTY', payload: trimmedSolution, trimmed };
  }

  return {
    status: status === 'UNKNOWN' && hasPlan ? 'FEASIBLE' : status,
    payload: trimmedSolution,
    trimmed,
  };
}

function safeJsonStringify(payload: unknown): { text: string; truncated: boolean } {
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2);
  } catch {
    return { text: '"<unserializable>"', truncated: false };
  }
  if (text.length > MAX_SOLUTION_JSON_CHARS) {
    return {
      text: text.slice(0, MAX_SOLUTION_JSON_CHARS) + '\n…[troncato]',
      truncated: true,
    };
  }
  return { text, truncated: false };
}

const BASE_SYSTEM = [
  "Sei l'assistente AI di DAINO per un manager di produzione di una PMI manifatturiera italiana.",
  'Stile: italiano professionale, frasi corte, niente gergo accademico, niente formule.',
  'Output: un singolo paragrafo di MASSIMO 6 frasi. Apri con un verdict di sintesi (puoi usare ✅ o ⚠️). Cita 1-2 punti di attenzione concreti (collo di bottiglia, ritardi, costi). Chiudi con una frase neutra.',
  'Vincoli rigidi: usa SOLO numeri presenti nei KPI o nella soluzione passati in input. NON inventare numeri, percentuali, nomi macchina, nomi commessa o orari che non sono nei dati. Se un dato non c\'è, non lo citi.',
  "Non descrivere il solver, non spiegare l'algoritmo, non parlare di se stesso. Parla solo della pianificazione.",
].join(' ');

function statusGuidance(status: SolutionStatus): string {
  switch (status) {
    case 'OPTIMAL':
      return "Soluzione OPTIMAL: tono positivo e sintetico, conferma il rispetto dei vincoli, segnala al massimo 1 saturazione/collo di bottiglia se presente nei dati.";
    case 'FEASIBLE':
      return "Soluzione FEASIBLE: indica esplicitamente che è una pianificazione fattibile ma non garantita ottima. Evidenzia la principale fonte di gap se desumibile dai dati.";
    case 'INFEASIBLE':
      return "Soluzione INFEASIBLE: spiega in 2-3 frasi che la pianificazione non è possibile con i vincoli attuali. Cita la causa più probabile SOLO se presente nei dati. Non proporre azioni correttive (lo fa l'Advisor).";
    case 'EMPTY':
      return "Nessuna commessa pianificabile nella finestra temporale. Rispondi con: \"Nessuna commessa pianificabile nella finestra temporale. Verifica i dati di ingresso.\" Non aggiungere altro.";
    case 'MALFORMED':
      return "Dati di soluzione non interpretabili. Rispondi con: \"Pianificazione non disponibile: i dati ricevuti non sono in un formato leggibile.\" Non aggiungere altro.";
    case 'UNKNOWN':
      return "Stato soluzione non dichiarato: limita l'output ai KPI presenti, senza congetture sul tipo di esito.";
  }
}

interface BuildSystemBlocksResult {
  blocks: Array<{
    type: 'text';
    text: string;
    cache_control?: { type: 'ephemeral' };
  }>;
}

function buildSystemBlocks(input: ExplainerInput): BuildSystemBlocksResult {
  const blocks: BuildSystemBlocksResult['blocks'] = [
    { type: 'text', text: BASE_SYSTEM },
  ];

  const specParts: string[] = [];
  if (input.consultationMd && input.consultationMd.trim().length > 0) {
    specParts.push('### Company spec (consultation)\n' + input.consultationMd.trim());
  }
  if (input.dataSchemaMd && input.dataSchemaMd.trim().length > 0) {
    specParts.push('### Data schema\n' + input.dataSchemaMd.trim());
  }
  if (specParts.length > 0) {
    blocks.push({
      type: 'text',
      text: specParts.join('\n\n'),
      cache_control: { type: 'ephemeral' },
    });
  }

  return { blocks };
}

function buildUserMessage(
  input: ExplainerInput,
  normalized: NormalizedSolution,
): string {
  const sections: string[] = [];
  sections.push('Pianificazione da spiegare al manager.');
  sections.push(`Slug istanza: ${input.slug}`);
  sections.push(`Stato soluzione: ${normalized.status}`);
  sections.push('Linea guida per questo caso: ' + statusGuidance(normalized.status));

  const kpiEntries = Object.entries(input.kpis);
  if (kpiEntries.length === 0) {
    sections.push('KPI: (nessun KPI fornito)');
  } else {
    sections.push(
      'KPI (USA SOLO QUESTI NUMERI):\n' +
        kpiEntries.map(([k, v]) => `- ${k}: ${v}`).join('\n'),
    );
  }

  if (normalized.status !== 'EMPTY' && normalized.status !== 'MALFORMED') {
    const { text, truncated } = safeJsonStringify(normalized.payload);
    const note = normalized.trimmed || truncated ? ' (alcune sezioni sono troncate)' : '';
    sections.push(`Soluzione (JSON${note}):\n\`\`\`json\n${text}\n\`\`\``);
  }

  sections.push(
    "Genera ora il paragrafo per il manager seguendo lo stile descritto nel system prompt. Massimo 6 frasi. Nessuna lista, nessun titolo, nessun preambolo del tipo \"Ecco il riassunto\".",
  );

  return sections.join('\n\n');
}

interface UsageTally {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

function computeCostUsd(usage: UsageTally): number {
  const billableInput = usage.input_tokens;
  const cost =
    (billableInput / 1_000_000) * PRICE_INPUT_PER_M +
    (usage.output_tokens / 1_000_000) * PRICE_OUTPUT_PER_M +
    (usage.cache_read_input_tokens / 1_000_000) * PRICE_CACHE_READ_PER_M +
    (usage.cache_creation_input_tokens / 1_000_000) * PRICE_CACHE_WRITE_PER_M;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

function buildResult(usage: UsageTally, aborted: boolean): ExplainerResult {
  const result: ExplainerResult = {
    cost_usd: computeCostUsd(usage),
    tokens_in: usage.input_tokens,
    tokens_out: usage.output_tokens,
  };
  if (usage.cache_read_input_tokens > 0) {
    result.cache_read_tokens = usage.cache_read_input_tokens;
  }
  if (usage.cache_creation_input_tokens > 0) {
    result.cache_write_tokens = usage.cache_creation_input_tokens;
  }
  if (aborted) result.aborted = true;
  return result;
}

export async function runExplainer(
  input: ExplainerInput,
  onChunk: OnChunk,
  options?: RunExplainerOptions,
): Promise<ExplainerResult> {
  const usage: UsageTally = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };

  if (options?.signal?.aborted) {
    return buildResult(usage, true);
  }

  const normalized = normalizeSolution(input.solution, input.kpis);
  const { blocks: systemBlocks } = buildSystemBlocks(input);
  const userMessage = buildUserMessage(input, normalized);

  const client = getAnthropicClient();

  const params: Anthropic.MessageCreateParamsStreaming = {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: systemBlocks,
    messages: [{ role: 'user', content: userMessage }],
    stream: true,
  };

  const stream = client.messages.stream(params);

  const emitUsage = () => {
    options?.onUsage?.({
      cost_usd: computeCostUsd(usage),
      tokens_in: usage.input_tokens,
      tokens_out: usage.output_tokens,
      cache_read_tokens: usage.cache_read_input_tokens || undefined,
      cache_write_tokens: usage.cache_creation_input_tokens || undefined,
    });
  };

  const onAbort = () => {
    try {
      stream.abort();
    } catch {
      // Stream already finished.
    }
  };
  if (options?.signal) {
    options.signal.addEventListener('abort', onAbort, { once: true });
  }

  let aborted = false;
  try {
    for await (const event of stream) {
      if (event.type === 'message_start') {
        const u = event.message.usage;
        usage.input_tokens = u.input_tokens ?? 0;
        usage.cache_read_input_tokens = u.cache_read_input_tokens ?? 0;
        usage.cache_creation_input_tokens = u.cache_creation_input_tokens ?? 0;
      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta' && delta.text) {
          onChunk(delta.text);
        }
      } else if (event.type === 'message_delta') {
        if (event.usage.output_tokens != null) {
          usage.output_tokens = event.usage.output_tokens;
        }
      }
    }
  } catch (err) {
    if (options?.signal?.aborted) {
      aborted = true;
    } else {
      emitUsage();
      throw err instanceof Error ? err : new Error(String(err));
    }
  } finally {
    if (options?.signal) {
      options.signal.removeEventListener('abort', onAbort);
    }
  }

  if (options?.signal?.aborted) aborted = true;

  emitUsage();
  return buildResult(usage, aborted);
}
