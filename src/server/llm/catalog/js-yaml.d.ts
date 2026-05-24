// Minimal type shim for js-yaml — we only use `load()` to parse a YAML
// string into an unknown JS value, then validate with Zod. Adding the
// upstream `@types/js-yaml` package is overkill for the single call site
// in loader.ts.

declare module 'js-yaml' {
  export function load(input: string, options?: unknown): unknown;
  export function dump(obj: unknown, options?: unknown): string;
  export class YAMLException extends Error {}
  const _default: {
    load: typeof load;
    dump: typeof dump;
    YAMLException: typeof YAMLException;
  };
  export default _default;
}
