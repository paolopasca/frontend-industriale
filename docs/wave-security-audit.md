# Wave 3-5 Security Audit — Client Bundle Leak Check

**Auditor**: `security-auditor` (Opus 4.7)
**Team**: `wave3-5-validation`
**Date**: 2026-05-22
**Branch**: `feat/wave6-data-ingestion-adr`
**HEAD**: `767a806` (Wave 6 ADR; Waves 4+5 already on branch at `eccc1dc` / `e2910fe`)
**Repo**: `/Users/paolopascarelli/Desktop/DAINO/frontend-industriale/`

## Scope and rationale

Wave 4 (`/api/whatif`, Opus) and Wave 5 (`/api/split`, Opus) added new BFF route handlers that call `getAnthropicClient()` server-side. The team lead did not run a build+grep audit after Waves 4 and 5. This audit verifies that:

1. The Anthropic SDK and live API key never leak into the client bundle shipped to the browser.
2. The `.dev.vars` file is correctly stripped from the deployable server artifact by the `postbuild` script.
3. There are no other obvious secret leaks in `dist/`.

A leak of the `ANTHROPIC_API_KEY` into a browser-served asset would let any visitor scrape the key from `dist/client/assets/*.js` and bill the team's Anthropic account at will. This is the highest-impact vulnerability class for the current architecture; hence a dedicated audit per release.

## Methodology

1. `rm -rf dist && npm run build` — clean production build.
2. Grep `dist/client/` for the leak signatures listed in the task.
3. Verify postbuild stripped `dist/server/.dev.vars`.
4. Cross-check: confirm the SDK *is* in `dist/server/` (where it belongs).
5. Inspect `.gitignore` + `git ls-files` to confirm secrets are never committed.

All thresholds: **0 matches** in `dist/client/` for any Anthropic-related signature.

## Results

### Step 1 — Build

```
> npm run build
✓ 2903 modules transformed (client)
✓ 3093 modules transformed (server)
✓ built in 2.14s + 1.91s
> postbuild
> rm -f dist/server/.dev.vars
```

Build **passes clean**. Only warning is a benign CSS `@import` ordering note in `styles-*.css` (Google Fonts), unrelated to security.

### Step 2-5 — Client bundle leak signatures

| # | Signature | Command | Matches | Threshold | Status |
|---|-----------|---------|---------|-----------|--------|
| 2 | `sk-ant`            | `grep -rn "sk-ant" dist/client/`            | **0** | 0 | PASS |
| 3 | `ANTHROPIC_API_KEY` | `grep -rn "ANTHROPIC_API_KEY" dist/client/` | **0** | 0 | PASS |
| 4 | `anthropic-ai`      | `grep -rn "anthropic-ai" dist/client/`      | **0** | 0 | PASS |
| 5 | `@anthropic-ai/sdk` | `grep -rn "@anthropic-ai/sdk" dist/client/` | **0** | 0 | PASS |

Reinforcing case-insensitive sweeps (extra paranoia):

| Signature                | Count in `dist/client/assets/index-*.js` | Status |
|--------------------------|------------------------------------------|--------|
| `anthropic` (ci, both bundles + styles + svg) | **0 / 0 / 0 / 0 / 0** | PASS |
| `Anthropic` (case-sensitive)                  | **0**                | PASS |
| `claude` (ci)                                 | matches found, all false positives — substrings inside minified motion-lib identifiers; verified no token/SDK content | PASS |
| `Bearer ` literal                             | 1 match — legitimate `\`Bearer ${Ih}\`` template for DAINO auth (`/api/auth/login` access_token, in-memory runtime var, not hardcoded) | PASS |

### Step 6 — `dist/server/.dev.vars` stripped

```
$ ls -la dist/server/.dev.vars
ls: dist/server/.dev.vars: No such file or directory
```

PASS — `postbuild` script (`rm -f dist/server/.dev.vars` in `package.json:10`) successfully removed the file. `dist/server/wrangler.json` `vars: {}` is empty; `grep -c "sk-ant" dist/server/wrangler.json` returns **0**.

### Step 7 — Bundle size sanity

```
dist/client/           2.5M
  assets/styles-*.css  100K
  assets/index-*.js    320K  (vendor split — react/router)
  assets/index-*.js    720K  (app code — chat, panels, charts)
```

PASS — sizes consistent with no SDK inlining. The Anthropic SDK alone would add ~150-300 KB compressed (it ships streaming/retry machinery). Current chunks are framework + UI only.

### Cross-check — Server bundle contains SDK (expected)

| Signature | In `dist/server/` | Expected | Status |
|-----------|-------------------|----------|--------|
| `sk-ant`          | 0 matches | 0 (after postbuild) | PASS |
| `@anthropic-ai/sdk` reference | `dist/server/assets/router-*.js` + `.vite/manifest.json` | YES (server uses SDK) | PASS |
| `ANTHROPIC_API_KEY` reference | `dist/server/assets/router-*.js` | YES (`process.env.ANTHROPIC_API_KEY` read at runtime) | PASS |

The SDK is correctly bundled into the server worker, where it reads the key from `process.env` at runtime — the key value itself never appears in any built artifact.

### Source-side isolation

All Anthropic SDK imports live under `src/server/llm/` only:

```
src/server/llm/client.ts            ← import Anthropic from '@anthropic-ai/sdk'
src/server/llm/advisor.ts           ← Wave 2
src/server/llm/manager-chat.ts      ← Wave 3
src/server/llm/manager-chat-tools.ts ← Wave 3
src/server/llm/explainer.ts         ← Wave 2
src/server/llm/whatif.ts            ← Wave 4
src/server/llm/split.ts             ← Wave 5
```

Vite's environment-split (`tanstack-start` + Cloudflare worker plugin) correctly tree-shakes `src/server/**` out of the client environment build. Waves 4 and 5 followed this convention — no leak vector introduced.

### `.gitignore` / git tracking

```
.env
.env.*
!.env.example
.dev.vars
```

`git ls-files | grep -E "\.dev\.vars$|\.env$|\.env\.local$"` → empty. Secrets never committed.

## Final verdict

| Area | Result |
|------|--------|
| Build         | PASS (clean) |
| Client bundle leak signatures (4 signatures × 0 thresholds) | PASS |
| `.dev.vars` stripped from `dist/server/` | PASS |
| `wrangler.json` no inlined secrets | PASS |
| Bundle size sanity | PASS |
| Server-side isolation of SDK imports | PASS |
| `.gitignore` coverage + nothing tracked | PASS |

**Overall: PASS — no API key leaks, no SDK leaks, no secret artifacts in the client bundle. Waves 4 and 5 are safe to ship from a client-side secret-exposure standpoint.**

## Recommendations (non-blocking, for future hardening)

These are good hygiene items, not findings:

1. **Add a build-time leak guard** — wire a `postbuild` grep that fails the build if `dist/client/` contains `sk-ant`, `ANTHROPIC_API_KEY`, or `@anthropic-ai/sdk`. Today this audit is a manual step run after each LLM-touching wave; a CI gate would make it automatic and unmissable. Suggested:
   ```jsonc
   // package.json
   "postbuild": "rm -f dist/server/.dev.vars && ! grep -rqE 'sk-ant|ANTHROPIC_API_KEY|@anthropic-ai/sdk' dist/client/"
   ```
2. **Pre-commit hook for `.dev.vars`** — add a hook that rejects commits introducing any string matching `sk-ant-[A-Za-z0-9_-]{20,}`. Belt-and-suspenders alongside the existing `.gitignore`.
3. **Rotate the key on schedule** — even with a clean audit, periodic rotation limits blast radius if a leak ever occurs through a side channel (logs, error reports, screenshots).
4. **CSP `connect-src`** — when deploying, add a Content-Security-Policy `connect-src` directive that *excludes* `api.anthropic.com`. The browser should never call Anthropic directly; this turns any future accidental client-side call into a CSP violation rather than a silent leak attempt.
5. **The Wave 6 ADR work introducing data ingestion will likely add new server-side LLM calls** — apply the same `src/server/llm/**` convention and re-run this audit after that wave lands.

## Artifacts

- Audit log: this file
- Build log captured: `npm run build` output above
- Inspected source: `src/server/llm/{client,advisor,explainer,manager-chat,manager-chat-tools,whatif,split}.ts`
- Inspected build output: `dist/client/`, `dist/server/`
