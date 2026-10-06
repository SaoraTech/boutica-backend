# Boutica Backend

NestJS + TypeScript + PostgreSQL (Drizzle ORM, via Neon) backend for
Boutica, a commerce/inventory management platform for retail merchants.

This is **v2.1**: a hardening pass (v1.1), a second hardening pass that
cross-checked library APIs against current docs and fixed two
stock-accounting bugs (v1.2), a re-architecture that removes Docker
entirely, moves PostgreSQL to Neon, and replaces the hand-rolled JWT auth
with Better Auth (v2.0), and now a client-readiness finalization pass
(v2.1) that closes the gaps found by a full API-contract audit — see
**[BOUTICA_V2_FINALIZATION_REPORT.md](./BOUTICA_V2_FINALIZATION_REPORT.md)**
for the complete report backing this version. Also see:

- **[AUDIT_REPORT.md](./AUDIT_REPORT.md)** — every problem found across all
  four passes, ranked P0–P3, with the reasoning and the fix.
- **[CHANGELOG.md](./CHANGELOG.md)** — what actually changed, file by file.

**v2.0 was a breaking change** (auth endpoints moved from
`/api/v1/auth/register` + `/api/v1/auth/login` to Better Auth's own
`/api/auth/sign-up/email` + `/api/auth/sign-in/email` — see
"Authentication" below). **v2.1 is purely additive** — every endpoint that
existed in v2.0 is unchanged; v2.1 only adds new ones and fixes a
cross-tenant reference gap in purchase receiving (see CHANGELOG.md).

## Architecture

```
Presentation (Controllers, DTOs)
        ↓
Application (Use-cases — Sales, Purchasing, Returns)
        ↓
Domain (Money, Quantity, SKU, Sale, Purchase, Return, Stock, Product — no
         NestJS / Drizzle / HTTP imports allowed here)
        ↓
Infrastructure (Drizzle schema, Neon Postgres, DatabaseService)
```

This is deliberately **not** uniform DDD everywhere. Catalog, Customers,
Expenses, Inventory, and Reports stay as thin, validated controllers
directly on top of `DatabaseService` because they don't carry
cross-aggregate invariants that justify a use-case/repository layer. Sales,
Purchasing, and Returns get a full Application layer because that's exactly
where the mission brief's critical rules live: stock concurrency, price
integrity, over-return prevention, and idempotency. See AUDIT_REPORT.md
P2-1 for the full reasoning.

Authentication is a separate concern from the rest of the app: `src/auth/auth.ts`
configures Better Auth directly (not through Nest's DI container — see the
comment at the top of that file for why), and every controller still reads
`@CurrentTenant() tenant: Tenant` exactly as before v2.0 — only *how* that
tenant is resolved changed (`src/modules/auth/current-tenant.decorator.ts`),
so the v2.0 auth migration touched almost none of the domain code.

## Prerequisites

- Node.js 20+
- **No Docker, anywhere.** A free [Neon](https://neon.tech) Postgres
  project is the only external dependency.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

1. **`DATABASE_URL`** — create a free project at
   [console.neon.tech](https://console.neon.tech), then **Connect** →
   toggle **Connection pooling OFF** → copy the connection string (it
   should *not* have `-pooler` in the hostname — see the comment in
   `.env.example` for why this app wants the direct string, not the pooled
   one).
2. **`BETTER_AUTH_SECRET`** — generate one:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
   ```
3. **`BETTER_AUTH_URL`** — the URL you'll actually hit this API at (e.g.
   `http://localhost:3000` for local dev).

Then:

```bash
npm run db:push     # pushes src/infrastructure/database/schema.ts to Neon directly
npm run start:dev
```

(`db:generate` + `db:migrate` also work against Neon exactly like any other
Postgres — see "Scripts" below — `db:push` is just the fastest path for
first getting a schema onto a fresh Neon branch.)

The API is served unprefixed with an explicit version in each controller
path, e.g. `http://localhost:3000/api/v1/products`. Swagger docs are at
`http://localhost:3000/docs`. Health check (unauthenticated, unversioned)
is at `http://localhost:3000/health`. Auth lives at `/api/auth/*` — Better
Auth's own convention, deliberately not moved under `/api/v1/`.

## Authentication

Everything auth-related is handled by [Better Auth](https://better-auth.com),
mounted at `/api/auth/*`. Every OTHER endpoint requires a bearer token:

```bash
curl -X POST http://localhost:3000/api/auth/sign-up/email \
  -H 'Content-Type: application/json' \
  -d '{"name":"Amina","email":"owner@shop.test","password":"a-long-password-123","businessName":"My Shop"}'
# -> { "token": "...", "user": { "id": "...", "businessId": "...", "role": "OWNER", ... } }

curl http://localhost:3000/api/v1/products \
  -H "Authorization: Bearer <token>"
```

Signing up creates a business AND its OWNER user in one call — `businessName`
(and an optional `businessCurrency`, a 3-letter ISO 4217 code, defaulting to
`XOF`) are Boutica-specific fields layered onto Better Auth's normal
email/password sign-up. `POST /api/auth/sign-in/email` with `{email,
password}` logs an existing user back in the same way.

The returned `token` is a Better Auth session token, sent as a normal
bearer token (`Authorization: Bearer <token>`) — this is what the brief's
"JWT for mobile/API" requirement resolves to: one session-based system
Better Auth owns end-to-end, not a second, separate token-signing
mechanism running alongside it. A real, stateless, JWKS-verifiable JWT is
also available (`GET /api/auth/token`, `GET /api/auth/jwks`) for cases that
need a portable credential rather than hitting this database — Boutica's
own API doesn't use that path itself; see `src/auth/auth.ts`.

Every controller reads the tenant via `@CurrentTenant() tenant: Tenant`,
resolved from the verified session — never from the request body. See
AUDIT_REPORT.md P0-1 (why this rule exists at all) and section H (how it's
implemented in v2.0).

**Cross-origin web clients (v2.1):** Better Auth does its own origin/CSRF
validation for cookie-bearing requests, independent of the CORS middleware
in `main.ts`. `src/auth/auth.ts` sets `trustedOrigins` from the same
`CORS_ORIGIN` env var CORS already uses — one list of allowed origins, not
two. This only matters for a browser client (Next.js) sending cookies; it's
a no-op for bearer-token clients (Kotlin, React Native/Expo, Electron), which
never send cookies at all.

## Idempotency

`POST /api/v1/sales`, `POST /api/v1/purchases/receive`, and `POST
/api/v1/returns` accept an optional `Idempotency-Key` header. Retrying the
same request with the same key and the same body replays the original
response instead of creating a second sale/purchase/return. Reusing a key
with a *different* body returns `409 Conflict`. See AUDIT_REPORT.md P0-5.

Not extended to `POST /api/v1/suppliers` or the new `PATCH .../variants/:variantId`
(v2.1): a duplicated supplier row or a repeated identical variant edit
carries none of the stock/money risk a duplicated sale, purchase, or return
does — same reasoning that already applied to `POST /customers` and `POST
/expenses`. Idempotency is reserved for the writes where a duplicate is
actually harmful, not applied uniformly everywhere by default.

## Running the tests

```bash
npm test           # unit tests — pure domain logic, no DB needed
npm run test:cov   # unit tests with coverage
```

Integration tests exercise the real HTTP layer against a real Postgres
database (auth, transactions, row locking, tenant isolation) — **no Docker,
no local Postgres.** Create a **second, separate Neon project or branch**
dedicated to tests (Neon branches are free and instant — Console → your
project → **Branches** → **New branch** — a test branch this suite freely
TRUNCATEs is much safer than pointing it at your dev database), then:

```bash
DATABASE_URL=<your-neon-TEST-branch-connection-string> \
BETTER_AUTH_SECRET=<any-random-32+-char-string-for-tests> \
BETTER_AUTH_URL=http://localhost:3000 \
  npm run db:push

DATABASE_URL=<same-test-branch-url> \
BETTER_AUTH_SECRET=<same-value-as-above> \
BETTER_AUTH_URL=http://localhost:3000 \
  npm run test:e2e
```

`BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`/`DATABASE_URL` must all be set
**before** the test process starts, not just before the tests that need a
database run — `src/auth/auth.ts` builds the Better Auth instance (and
validates these three vars via `envSchema.parse(process.env)`) at module
load time, which happens as soon as anything imports `AppModule`.

**Note on this deliverable:** the sandbox this backend was audited and
rewritten in has no network access and no Postgres/Neon reachable from it,
so none of `npm install`, `npm run build`, `npm test`, or `npm run test:e2e`
could actually be executed here — this was already true for v1.1/v1.2 and
remains true for v2.0. Every file was written and manually cross-checked
(types, imports, and — for the parts of this migration that depend on
Better Auth and Neon specifically — verified against each library's current
documentation rather than training-data memory alone, since Better Auth in
particular is young enough to have moved since then). You should treat the
very first `npm install && npm run build && npm test && npm run test:e2e`
locally as part of reviewing this delivery, not a formality. See
AUDIT_REPORT.md section H for the full list of what still needs a real run,
and exactly which parts of the Better Auth integration carry the most
residual risk.

## Scripts

| Command | Purpose |
|---|---|
| `npm run start:dev` | Run with hot reload |
| `npm run build` | Compile to `dist/` |
| `npm run lint` | ESLint |
| `npm test` | Unit tests |
| `npm run test:cov` | Unit tests with coverage |
| `npm run test:e2e` | Integration tests (needs a Neon database) |
| `npm run db:generate` | Generate SQL migrations from the schema |
| `npm run db:migrate` | Apply migrations |
| `npm run db:push` | Push schema directly to Neon (dev/test convenience, skips migration files) |

## Domains

Auth (Better Auth) · Catalog (products, variants) · Inventory · Purchasing ·
Suppliers · Sales · Returns · Customers · Expenses · Reports ·
Store/Business — see AUDIT_REPORT.md section D for how each is modeled, and
`BOUTICA_V2_FINALIZATION_REPORT.md` for the full v2.1 endpoint catalog.

## Déploiement Render

1. Créer un **Web Service** sur [render.com](https://render.com).
2. Connecter ce dépôt GitHub (`boutica-backend`).
3. Paramètres du service :
   - **Environment** : Node
   - **Build Command** : `npm install && npm run build`
   - **Start Command** : `npm run start:prod`
   - **Health Check Path** : `/health`
4. Variables d'environnement requises (dans l'onglet *Environment*) :
   - `DATABASE_URL` : URL de connexion directe Neon PostgreSQL
   - `BETTER_AUTH_SECRET` : Clé secrète (32+ caractères)
   - `BETTER_AUTH_URL` : URL publique Render (ex: `https://votre-app.onrender.com`)
   - `NODE_ENV` : `production`
   - `CORS_ORIGIN` : Origine autorisée du client (ex: `http://localhost:3000` en dév, ou URL de prod)


