import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
// js-yaml ships without bundled types in this repo. Use a narrow ambient
// shim (see jsYamlLoad below) instead of `@types/js-yaml` to avoid pulling
// extra dev deps.
import yaml from 'js-yaml';

/**
 * Wave 7 — Constraint catalog loader.
 *
 * Loads the YAML constraint catalog (closed menu of intents the manager
 * can describe in Italian), validates it with Zod, and exposes lookup
 * helpers used by the intent-parser (Haiku) prompt and by the
 * strategy-router (deterministic TS).
 *
 * The catalog is parsed once and memoised; tests reset the cache by
 * calling `resetCatalogCache()`.
 */

const ValidatorSchema = z.enum([
  'must_exist_in_solution_machines',
  'must_exist_in_solution_orders',
  'each_must_exist_in_solution_orders',
  'positive_int',
  'non_negative_int',  // Wave 11 F-W10-04 rename — accepts 0
  'strict_positive_int',  // Wave 11 F-W10-04 — rejects 0 (used for ``operators``)
  'gt_start',
  'iso_datetime_string',
  'short_string',
  'shift_name_enum',
  'shift_name_or_id',
]);

const EntityFieldSchema = z.object({
  required: z.boolean(),
  validator: ValidatorSchema,
  default_to: z.enum(['horizon_end']).optional(),
});

const StrategySchema = z.enum(['data_modification', 'rule_addition']);

const IntentSchema = z.object({
  id: z.string().min(1),
  description_it: z.string().min(1),
  strategy: StrategySchema,
  fallback_strategy: StrategySchema,
  fallback_rule_key: z.string().min(1),
  entities: z.record(z.string(), EntityFieldSchema),
  italian_triggers: z.array(z.string()).min(1),
  examples: z
    .array(
      z.object({
        input: z.string(),
        intent: z.string(),
        entities: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1),
  // F-W8-01 (devils 2026-05-22): some catalog intents are recognised by
  // the Haiku parser but the backend solver has no CP-SAT consumer for
  // them yet. Marking them not_implemented in the catalog lets the
  // strategy-router short-circuit to `unsupported` instead of pretending
  // the rules payload took effect when in practice f_apply_rules.py
  // emits only a passthrough warning. Honest UX > silent no-op.
  not_implemented: z.boolean().optional(),
});

const CatalogSchema = z.object({
  version: z.number().int().positive(),
  description: z.string().optional(),
  intents: z.array(IntentSchema).min(1),
});

export type EntityValidator = z.infer<typeof ValidatorSchema>;
export type IntentStrategy = z.infer<typeof StrategySchema>;
export type EntityFieldDef = z.infer<typeof EntityFieldSchema>;
export type IntentDef = z.infer<typeof IntentSchema>;
export type ConstraintCatalog = z.infer<typeof CatalogSchema>;

let _catalog: ConstraintCatalog | null = null;
let _catalogPath: string | null = null;

function defaultCatalogPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, 'constraint-catalog.yaml');
}

/**
 * Parse a YAML string against the catalog schema. Throws if invalid.
 * Exposed for tests that want to bypass disk I/O.
 */
export function parseCatalog(yamlText: string): ConstraintCatalog {
  const parsed = yaml.load(yamlText) as unknown;
  const result = CatalogSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid constraint catalog schema: ${issues}`);
  }
  // Enforce id uniqueness — Zod alone doesn't.
  const ids = new Set<string>();
  for (const intent of result.data.intents) {
    if (ids.has(intent.id)) {
      throw new Error(`Duplicate intent id in catalog: ${intent.id}`);
    }
    ids.add(intent.id);
  }
  return result.data;
}

/**
 * Load the catalog from disk (memoised). Re-throws YAML parse errors and
 * schema violations as plain Error instances with a `Invalid constraint
 * catalog` prefix.
 */
export function loadCatalog(path?: string): ConstraintCatalog {
  const targetPath = path ?? defaultCatalogPath();
  if (_catalog && _catalogPath === targetPath) return _catalog;
  let text: string;
  try {
    text = readFileSync(targetPath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read constraint catalog at ${targetPath}: ${(err as Error).message}`);
  }
  _catalog = parseCatalog(text);
  _catalogPath = targetPath;
  return _catalog;
}

/**
 * Lookup an intent definition by id. Returns null if the id is not in
 * the catalog (this is how the router detects the `unknown` fallback).
 */
export function findIntent(catalog: ConstraintCatalog, intentId: string): IntentDef | null {
  return catalog.intents.find((i) => i.id === intentId) ?? null;
}

/**
 * Return the list of intent ids the parser is allowed to emit. Used by
 * the intent-parser prompt to enforce a closed vocabulary.
 */
export function listIntentIds(catalog: ConstraintCatalog): string[] {
  return catalog.intents.map((i) => i.id);
}

/**
 * Test-only: drop the memoised catalog so the next loadCatalog() will
 * re-read from disk.
 */
export function resetCatalogCache(): void {
  _catalog = null;
  _catalogPath = null;
}
