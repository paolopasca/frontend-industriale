# DAINO frontend-industriale

SPA React (Vite + TanStack Start) + BFF per il pannello di controllo del manager di produzione industriale. Architettura, roadmap e dettaglio funzionale: vedi [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md).

## Quick start

```bash
# install
npm install

# copy the env template and fill in real values (NEVER commit .env.local)
cp .env.example .env.local
$EDITOR .env.local

# dev server (loads .env.local automatically)
npm run dev

# server-side test suite
npm run test:server

# e2e
npm run test:e2e
```

## Environment variables

Tutte le variabili e il loro contratto vivono in [`.env.example`](./.env.example). Copia quel file in `.env.local` e compila i segreti reali — `.env.local` è gitignored (`*.local` + `.env*` in [`.gitignore`](./.gitignore)) perchè contiene `ANTHROPIC_API_KEY` e `DAINO_INTERNAL_SECRET`.

### Rate limit BFF in dev

Gli endpoint BFF (`/api/explain`, `/api/advise`, `/api/apply-whatif`, ecc.) hanno un rate limit per-IP di default 10 richieste/ora controllato da `DAINO_BFF_RATE_LIMIT_PER_HOUR`. In dev (`NODE_ENV !== 'production'`) il limite è bypassato per default su tutti gli IP, così e2e, stress runner e dogfood via `vite --host` sulla LAN non sbattono contro il cap mentre iteri.

Per forzare il limite anche in dev (utile a riprodurre uno stato 429):

```bash
# in .env.local
DAINO_BFF_RATE_LIMIT_BYPASS_LOCAL=0
```

In produzione il bypass è disattivato a prescindere da questa variabile — il 10/h resta il ceiling di sicurezza contro spending runaway.
