import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseCatalog,
  loadCatalog,
  findIntent,
  listIntentIds,
  resetCatalogCache,
} from '../catalog/loader';

/**
 * Wave 7 — Catalog loader unit tests.
 *
 * Exercises the YAML → Zod parsing layer and the lookup helpers
 * (`findIntent`, `listIntentIds`). The shipped catalog
 * `constraint-catalog.yaml` is loaded via `loadCatalog()` in test #5
 * to assert that the file we ship parses cleanly.
 */

beforeEach(() => {
  resetCatalogCache();
});

const MIN_VALID = `
version: 1
intents:
  - id: machine_unavailability
    description_it: "Macchina indisponibile"
    strategy: data_modification
    fallback_strategy: rule_addition
    fallback_rule_key: unavailable_machines
    entities:
      machine_id:
        required: true
        validator: must_exist_in_solution_machines
      start_min:
        required: true
        validator: positive_int
      end_min:
        required: false
        validator: gt_start
        default_to: horizon_end
    italian_triggers:
      - "{machine} rotta"
    examples:
      - input: "M2 rotta"
        intent: machine_unavailability
        entities:
          machine_id: "M02"
          start_min: 0
`;

describe('parseCatalog', () => {
  it('accepts a minimal valid catalog with one intent', () => {
    const cat = parseCatalog(MIN_VALID);
    expect(cat.version).toBe(1);
    expect(cat.intents).toHaveLength(1);
    expect(cat.intents[0].id).toBe('machine_unavailability');
    expect(cat.intents[0].entities.machine_id.required).toBe(true);
    expect(cat.intents[0].entities.end_min.default_to).toBe('horizon_end');
  });

  it('throws on schema violation (missing required field strategy)', () => {
    const broken = `
version: 1
intents:
  - id: bad_intent
    description_it: "broken"
    fallback_strategy: rule_addition
    fallback_rule_key: some_key
    entities:
      foo:
        required: true
        validator: positive_int
    italian_triggers: ["x"]
    examples:
      - input: "x"
        intent: bad_intent
        entities: {}
`;
    expect(() => parseCatalog(broken)).toThrow(/Invalid constraint catalog/);
  });

  it('throws on unknown validator name (Zod enum rejects)', () => {
    const broken = `
version: 1
intents:
  - id: bad_validator
    description_it: "broken"
    strategy: rule_addition
    fallback_strategy: rule_addition
    fallback_rule_key: some_key
    entities:
      foo:
        required: true
        validator: not_a_real_validator
    italian_triggers: ["x"]
    examples:
      - input: "x"
        intent: bad_validator
        entities: {}
`;
    expect(() => parseCatalog(broken)).toThrow(/Invalid constraint catalog/);
  });

  it('throws on duplicate intent ids', () => {
    const dup = `
version: 1
intents:
  - id: same_id
    description_it: "first"
    strategy: rule_addition
    fallback_strategy: rule_addition
    fallback_rule_key: a
    entities:
      x:
        required: true
        validator: positive_int
    italian_triggers: ["x"]
    examples:
      - input: "x"
        intent: same_id
        entities: {}
  - id: same_id
    description_it: "second"
    strategy: rule_addition
    fallback_strategy: rule_addition
    fallback_rule_key: b
    entities:
      y:
        required: true
        validator: positive_int
    italian_triggers: ["y"]
    examples:
      - input: "y"
        intent: same_id
        entities: {}
`;
    expect(() => parseCatalog(dup)).toThrow(/Duplicate intent id/);
  });

  it('loads the shipped constraint-catalog.yaml without errors', () => {
    const cat = loadCatalog();
    const ids = listIntentIds(cat);
    expect(ids).toContain('machine_unavailability');
    expect(ids).toContain('order_priority');
    expect(ids).toContain('deadline_change');
    expect(ids).toContain('capacity_addition');
    expect(ids).toContain('shift_window');
    expect(ids).toHaveLength(5);

    // Lookup of an existing intent should return the full definition.
    const machine = findIntent(cat, 'machine_unavailability');
    expect(machine).not.toBeNull();
    expect(machine!.strategy).toBe('data_modification');
    expect(machine!.fallback_strategy).toBe('rule_addition');
    expect(machine!.fallback_rule_key).toBe('unavailable_machines');

    // Lookup of a non-existing id should return null.
    expect(findIntent(cat, 'this_intent_does_not_exist')).toBeNull();

    // Memoisation: a second call returns the same object reference.
    expect(loadCatalog()).toBe(cat);
  });
});
