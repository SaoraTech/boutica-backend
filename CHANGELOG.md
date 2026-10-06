# Changelog

## v2.0 → v2.1 (client-readiness finalization)

Implements the P0/P1 fixes identified by `BOUTICA_V2_CLIENT_INTEGRATION_AUDIT.md`
— purely additive, no existing endpoint changed shape or behavior. Full
reasoning in `BOUTICA_V2_FINALIZATION_REPORT.md`.

### Added

- **`GET /api/v1/products/:id/variants`**, **`GET /api/v1/variants`**
  (new `VariantsController`) — variants could be created but never listed
  or searched. The product-scoped endpoint serves a product-detail screen;
  the business-wide, searchable one serves a POS "find this item" flow
  that doesn't know which product a variant belongs to ahead of time. Both
  join `stock` so a client gets quantity without a second round-trip per
  variant.
- **`PATCH /api/v1/products/:id/variants/:variantId`** — variants had no
  way to be corrected after creation. Validates the *merged* state
  (existing row + whichever fields were sent) through the same domain
  invariant `addVariant()` already uses, so a partial update can't leave a
  variant in a state creation would have rejected.
- **`GET /api/v1/sales`**, **`GET /api/v1/sales/:id`** — sales could be
  created but never listed or reviewed again. `?customerId=` on the list
  endpoint doubles as this app's answer to "a customer's purchase
  history" rather than adding a second, near-duplicate endpoint for it.
- **`GET /api/v1/purchases`**, **`GET /api/v1/purchases/:id`** — same gap,
  same fix, for purchases.
- **`GET /api/v1/returns`**, **`GET /api/v1/returns/:id`** — same gap,
  same fix, for returns; `?saleId=` filters by originating sale.
- **`GET /api/v1/customers/:id`** — customers could be created and listed
  but never fetched individually.
- **`src/modules/suppliers/`** (`GET`/`POST /api/v1/suppliers`) — the
  `suppliers` table existed and was already referenced by
  `purchases.supplierId`, but no controller ever exposed it.
- **`trustedOrigins`** in `src/auth/auth.ts`, sourced from the existing
  `CORS_ORIGIN` env var (not a new one) — Better Auth's own origin/CSRF
  check is independent of Express's CORS middleware and was previously
  unconfigured, which would silently reject a cookie-based cross-origin
  web client (Next.js on a separate domain from the API) even with CORS
  otherwise set up correctly.
- Regression tests: `test/e2e/catalog.e2e-spec.ts` (new — variant listing,
  search, update, cross-tenant, SKU-conflict cases), `test/e2e/suppliers.e2e-spec.ts`
  (new), list/detail/cross-tenant cases added to `sales.e2e-spec.ts`,
  `purchasing.e2e-spec.ts`, `returns.e2e-spec.ts`; `tenant-isolation.e2e-spec.ts`
  extended to cover every endpoint added this round (variants, purchases,
  returns, suppliers, customer detail) plus the pre-existing sales-list
  test, whose comment had gone stale the moment the sales list endpoint
  above was added; `auth.e2e-spec.ts` gained a `trustedOrigins` test pair
  (trusted vs. untrusted `Origin` header on a cookie-bearing request —
  the specific case that exercises Better Auth's origin check at all).

### Fixed

- **`receive-purchase.usecase.ts`** — `supplierId` was accepted with no
  ownership check at all: a caller could reference another business's
  supplier row by UUID. Now validated against the tenant the same way
  `variantId`s already were (AUDIT_REPORT.md P0-1).

### Changed

- **`package.json`** — version bumped to `2.1.0`.
- `README.md`, `.env.example` — documented the new endpoints,
  `trustedOrigins`'s reuse of `CORS_ORIGIN`, and why idempotency wasn't
  extended to the new writes (`POST /suppliers`, `PATCH .../variants/:id`)
  — same reasoning that already applied to `POST /customers` and
  `POST /expenses`: no stock/money risk from a duplicate.

### Deliberately not done (verified, not built)

- **STAFF / multi-user**: verified the schema does not block this —
  `users.businessId` is a plain (non-unique) index, so multiple users per
  business is already possible at the data-model level; `role` already
  has `STAFF` as a valid enum value. What's missing is an invite flow,
  which was explicitly out of scope for this pass.
- Payment/credit tracking, file uploads, client-side offline sync — all
  remain out of scope, unchanged from the client-integration audit's own
  assessment.

---

# Changelog

## v1.2 → v2.0 (Neon + Better Auth, no Docker)

A re-architecture, not a hardening pass: removes Docker entirely, moves
PostgreSQL to Neon, and replaces the hand-rolled JWT auth with Better Auth
as the single authentication system. Full reasoning in `AUDIT_REPORT.md`
section H. **Breaking change**: auth endpoints moved (see below); every
`/api/v1/...` endpoint is unchanged.

### Removed

- **`docker-compose.yml`** — deleted. No Docker anywhere, for anything.
- **`src/modules/auth/auth.controller.ts`, `auth.service.ts`,
  `auth.module.ts`, `jwt-auth.guard.ts`, `public.decorator.ts`,
  `dto/register.dto.ts`, `dto/login.dto.ts`** — the entire hand-rolled auth
  system, replaced by Better Auth.
- **`@nestjs/jwt`, `bcrypt`, `@types/bcrypt`** dependencies — Better Auth
  signs its own sessions/JWTs and hashes its own passwords (scrypt, not
  bcrypt); keeping a second, now-unused signing/hashing stack around was
  exactly the "two competing auth mechanisms" the brief asked to avoid.
- **`JWT_SECRET`, `JWT_EXPIRES_IN`** env vars — replaced by
  `BETTER_AUTH_SECRET`/`BETTER_AUTH_URL`.

### Added

- **`src/auth/auth.ts`** — the Better Auth instance: Drizzle adapter over
  the same Postgres database, email/password sign-up and sign-in, a
  `databaseHooks.user.create.before` hook that creates the `businesses` row
  and attaches its id to the new user (this is what sign-up creating a
  business AND an OWNER in one call now hinges on), the `bearer` plugin
  (mobile/API clients send `Authorization: Bearer <token>` instead of
  using cookies) and the `jwt` plugin (a real, stateless, JWKS-verifiable
  JWT via `GET /api/auth/token`, for future third-party integrations —
  Boutica's own API doesn't consume this itself).
- **`users`/`sessions`/`accounts`/`verifications`** tables in
  `schema.ts` — Better Auth's core model, with `businessId`/`businessName`/
  `businessCurrency`/`role` as Boutica-specific `additionalFields` on
  `users`. The old `users` table (custom, with a `passwordHash` column) is
  gone; passwords now live on `accounts`.
- **`sale_items.costAtSale`** — the variant's purchase price captured *at
  the moment of that sale*, fixing the caveat flagged in round 2 (R2-5):
  margin reporting used to read the variant's CURRENT purchase price, so
  changing a cost today silently changed the reported margin on old sales.
  `reports.controller.ts`'s grossMargin query now reads this column
  (falling back to the variant's current cost only for sales recorded
  before this column existed).
- **`test/e2e/auth.e2e-spec.ts`** — there was no dedicated auth test file
  before v2.0 despite auth being explicitly first in the brief's testing
  priorities; added sign-up, duplicate-email rejection, sign-in
  success/failure, and multi-tenant isolation-at-signup coverage.
- **`test/e2e/reports.e2e-spec.ts`** — new regression test proving a
  variant's purchase price changing after a sale does NOT change that
  sale's reported margin.

### Changed

- **`src/modules/auth/current-tenant.decorator.ts`** — now resolves the
  tenant from a live Better Auth session (`auth.api.getSession` +
  `fromNodeHeaders`) instead of reading a custom JWT payload a
  since-removed guard used to attach to the request. `Tenant`
  (`tenant.type.ts`) is UNCHANGED — every other controller in the codebase
  still uses `@CurrentTenant() tenant: Tenant` exactly as before; this
  migration was deliberately scoped to not touch them.
- **`app.module.ts`** — `AuthModule.forRoot({ auth })` from
  `@thallesp/nestjs-better-auth` replaces the old `AuthModule` +
  `APP_GUARD: JwtAuthGuard`. It registers its own global guard
  automatically (every route still protected by default,
  `@AllowAnonymous()` is the new opt-out — see `health.controller.ts`).
- **`main.ts`**, **`test/utils/test-app.ts`** — Nest's built-in body parser
  is now disabled (`bodyParser: false`) and `express.json()` re-added
  explicitly afterward — a documented Better Auth NestJS integration
  requirement (it needs the raw, un-parsed request body). Every other
  route's `req.body` is populated exactly as before; this had to be
  fixed in the test harness too, or every test calling `registerBusiness()`
  (nearly all of them) would have failed.
- **`database.ts`** — now points at Neon; `ssl: { rejectUnauthorized: true }`
  added explicitly. `env.schema.ts`'s `DATABASE_URL` comment now documents
  Neon's direct-vs-pooled connection string distinction.
- **`test/utils/test-app.ts`**'s `registerBusiness()` — calls
  `/api/auth/sign-up/email` instead of the removed `/api/v1/auth/register`;
  `resetDatabase()`'s TRUNCATE list includes the three new Better Auth
  tables.
- **`package.json`** — version bumped to `2.0.0` (breaking change: auth
  endpoints moved). Added `better-auth`, `@thallesp/nestjs-better-auth`.
- **`.env.example`**, **`README.md`** — rewritten for Neon + Better Auth,
  no Docker anywhere.

### Deliberately not solved here (flagged, not fixed)

- **Two database connection pools now exist** (`DatabaseService`'s and a
  second, smaller one dedicated to `src/auth/auth.ts`) — forced by
  `AuthModule.forRoot({ auth })` needing a fully-built `auth` instance
  before Nest's DI container exists, so `auth.ts` can't inject
  `DatabaseService`. Minor overhead, not a correctness issue.
- **The sign-up hook's business-creation insert is not in the same
  transaction as Better Auth's own user insert** — that transaction
  boundary is inside Better Auth's adapter internals, outside this app's
  control. A sign-up that fails after the hook runs (e.g. a duplicate
  email racing with itself) can leave an orphaned, ownerless business row.
  Rare; flagged rather than silently accepted as fixed.
- **`CurrentTenant` performs a second `getSession` lookup** per protected
  request beyond the one `@thallesp/nestjs-better-auth`'s own guard already
  did, because reaching into whichever internal request property that
  package attaches its resolved session to isn't part of its documented
  public API. A minor, deliberate perf/robustness trade-off — see the code
  comment in `current-tenant.decorator.ts`.
- **No endpoint exists to edit a variant's price after creation** —
  surfaced while writing the `costAtSale` regression test, which had to
  update the row directly via Drizzle to reproduce the scenario at all.
  Pre-existing gap, not introduced by v2.0, not fixed here.
- Exact package versions for `better-auth` and `@thallesp/nestjs-better-auth`
  in `package.json` are a floor, not a verified-current pin — this
  environment has no network access to check npm's registry. Run `npm view
  better-auth version` / `npm view @thallesp/nestjs-better-auth version`
  before your first install.

---

# Changelog — v1.1 → v1.2 (round 2)

A second hardening pass over the v1.1 deliverable, this time cross-checking
library APIs (Drizzle locking/upsert, `@nestjs/throttler`, `@nestjs/config`)
against current documentation instead of only training-data memory. Full
reasoning in `AUDIT_REPORT.md` (section "Round 2").

### Fixed

- **`src/modules/sales/application/create-sale.usecase.ts`** — a sale with
  two line items for the *same* variant was checked and (worse) written
  against a stock snapshot taken before the request started: each line's
  "enough stock?" check ran against the same un-decremented quantity, and
  the final write kept only the *last* line's decrement instead of
  compounding both, silently under-decrementing `stock.quantity` relative
  to what `stock_movements` recorded as sold. The stock write is now an
  atomic `sql`` col - value `` update (the same pattern already used by
  `receive-purchase.usecase.ts` / `create-return.usecase.ts`), which is
  correct regardless of how many lines touch one variant.
- **`src/modules/returns/domain/return.ts`** — the same class of bug: two
  return lines against the same `saleItemId` (e.g. 2 units RESTOCK + 1
  DAMAGED from one sale line — a legitimate split) were each checked
  independently against `soldQuantity - alreadyReturnedQuantity`, so
  together they could over-return past what was sold. `Return.create` now
  tracks a running per-`saleItemId` consumption total across the whole
  request.
- **`src/modules/catalog/catalog.controller.ts`**, **`.../expenses/expenses.controller.ts`**
  — `Money.fromDecimal()` was called with no currency argument, silently
  defaulting to `XOF` instead of the business's configured currency
  (sales/purchasing/returns already fetched it correctly). Both now do.

### Added

- **`src/config/env.schema.ts`** — every env var the app reads
  (`DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `PORT`, `CORS_ORIGIN`,
  `NODE_ENV`) validated once at bootstrap via
  `ConfigModule.forRoot({ validationSchema })`, failing fast with every
  problem listed at once. `zod` was a listed dependency from v1.1 but was
  never actually used anywhere in the codebase — this is what it was for.
- **`src/modules/reports/`** — `GET /api/v1/reports/dashboard` (revenue,
  expenses, estimated profit, stock value, recent sales, top products,
  low-stock alerts). The original brief (section 6) explicitly asks for a
  dashboard/reports workflow; it didn't exist anywhere and wasn't flagged
  as a known gap in v1.1's audit either.
- **`GET /api/v1/expenses`** — the module had a `POST` but no way to ever
  list what had been recorded.
- Regression tests for the two aggregation bugs above:
  `test/e2e/sales.e2e-spec.ts` ("rejects a sale with two line items for
  the same variant"), `src/modules/returns/domain/return.spec.ts` (two new
  cases). New `test/e2e/reports.e2e-spec.ts`.

### Changed

- **`src/modules/sales/dto/create-sale.dto.ts`** — `items` now rejects
  duplicate `variantId`s outright (`@ArrayUnique`) rather than relying only
  on the use-case to aggregate them correctly. There's no legitimate reason
  to split one variant across two lines on a sale (price always comes from
  the catalog, never per-line), so the boundary rejects it with a clear 400
  instead of silently merging it.
- **`src/infrastructure/database/database.ts`** / **`database.module.ts`**
  — v1.1's changelog marked these "no bug found; left as-is", but they were
  still in the pre-hardening dense, single-line style (unlike every other
  infrastructure file) and read `DATABASE_URL` raw off `process.env` with
  no validation, while `JWT_SECRET` alone was checked. Reformatted and
  moved onto the new validated `ConfigService`.
- **`src/main.ts`** — `CORS_ORIGIN`/`PORT` now read through the validated
  `ConfigService` instead of raw `process.env`; the manual
  `NODE_ENV=production` fail-closed check for `CORS_ORIGIN` moved into
  `env.schema.ts` (`.refine()`) so the policy lives in one place.
- **`src/modules/auth/auth.module.ts`** — removed the manual
  `JWT_SECRET.length < 32` check; `env.schema.ts` now enforces this
  centrally for every env var, not just this one.
- **`package.json`** — version bumped to `1.2.0`.

### Verified against current library docs (not just training-data memory)

- Drizzle: `.for('update')` row-locking and `onConflictDoUpdate` with a
  `sql`` col + value `` atomic increment both match current docs — no
  change needed to the locking/upsert patterns already in place.
- `@nestjs/throttler`: `@Throttle({ default: { limit, ttl } })` matches the
  current (v5/v6) object-based decorator API.
- `@nestjs/config`: `ConfigModule.forRoot({ validationSchema })` accepting
  a Zod schema directly (via Standard Schema support) is the current,
  documented way to validate env vars — used above instead of a bespoke
  validation function.
- `drizzle-kit`: `defineConfig({ dialect: 'postgresql', dbCredentials: { url } })`
  in `drizzle.config.ts` matches the current config shape; left unchanged.

### Still open (flagged, not resolved here — see AUDIT_REPORT.md "Round 2")

- `docker-compose.yml` (local Postgres only) and the npm/Jest toolchain in
  this repo were not touched. Worth a decision on whether they should
  align with the pnpm/Vitest/no-Docker conventions recorded for the
  separate Boutica Cloud rebuild, or whether that policy was scoped to
  that rebuild only.
- No credit/receivables ledger exists, so the new dashboard reports
  `receivables: null` rather than a fabricated number.
- No customer purchase history, no `GET /customers/:id`, no
  update/deactivate for customers or expenses.

---

# Changelog — v1 → v1.1 (hardening pass)

Full reasoning for every entry is in `AUDIT_REPORT.md`. This file is the
condensed, file-by-file version.

## Added

- `src/modules/auth/**` — JWT-based authentication (`register`, `login`),
  global `JwtAuthGuard`, `@Public()`/`@CurrentTenant()` decorators.
- `src/modules/returns/**` — full Returns domain, application (use-case),
  and controller. New endpoint: `POST /api/v1/returns`.
- `src/modules/{sales,purchasing,returns}/application/*.usecase.ts` — new
  Application layer wiring the (previously unused) domain entities into
  actual transactional writes.
- `src/common/errors/domain-exception.filter.ts` — global error mapping
  (`DomainError` → 400, Postgres 23505/23514/23503 → 409/409/400, unknown →
  500 with no leaked internals).
- `src/common/pagination.dto.ts` — shared bounded pagination for list
  endpoints.
- `src/common/idempotency/idempotency.util.ts` — request-hash helper for
  `Idempotency-Key` handling.
- Database tables: `users`, `returns`, `return_items`, `idempotency_keys`.
- `businessId` column on `variants` and `stock` (denormalized for tenant
  filtering without a join on hot paths).
- `CHECK` constraints: `stock.quantity >= 0`,
  `sale_items/purchase_items/return_items.quantity > 0`,
  `variants.selling_price >= purchase_price`,
  `sales.discount BETWEEN 0 AND subtotal`.
- Unit tests: `src/common/domain.spec.ts`,
  `src/common/idempotency/idempotency.util.spec.ts`,
  `src/modules/sales/domain/sale.spec.ts`,
  `src/modules/purchasing/domain/purchase.spec.ts`,
  `src/modules/returns/domain/return.spec.ts`,
  `src/modules/catalog/domain/product.spec.ts`,
  `src/modules/inventory/domain/stock.spec.ts`,
  `src/modules/expenses/domain/expense.spec.ts`.
- Integration tests: `test/e2e/sales.e2e-spec.ts`,
  `test/e2e/purchasing.e2e-spec.ts`, `test/e2e/returns.e2e-spec.ts`,
  `test/e2e/tenant-isolation.e2e-spec.ts`, `test/utils/test-app.ts`.
- `jest`/`ts-jest`/`@nestjs/testing`/`supertest` devDependencies + Jest
  config (unit) and `test/jest-e2e.json` (integration).
- `@nestjs/jwt`, `@nestjs/throttler`, `bcrypt`, `helmet` dependencies.
- `AUDIT_REPORT.md`, this file.

## Changed

- **`src/common/domain.ts`** — `Money` rewritten to store an integer number
  of minor units instead of a floating-point `number`; all arithmetic
  (`add`/`subtract`/`multiply`) is now integer-only. `DomainError`,
  `Quantity`, `SKU` unchanged in behavior, reformatted.
- **`src/infrastructure/database/schema.ts`** — see Added above for new
  tables/columns/constraints; `variants.sku` unique index changed from
  global to `(business_id, sku)`.
- **Every controller under `src/modules/**`** — request bodies are now
  real `class-validator` DTOs (previously inline TS type literals that the
  configured `ValidationPipe` silently never validated — see
  AUDIT_REPORT.md P0-6); `businessId` is read from `@CurrentTenant()`
  instead of the request body; every query/mutation is filtered by it.
- **`src/modules/catalog/catalog.controller.ts`** — now constructs
  `Product`/`Variant` domain objects to run their invariants before
  persisting; added pagination and a `category` filter to `GET /products`.
- **`src/modules/inventory/inventory.controller.ts`** — `adjust` now runs
  in a transaction, locks the stock row (`FOR UPDATE`), and records a
  `stock_movements` row for the delta (previously silent).
- **`src/modules/sales/sales.controller.ts`** — reduced to a thin adapter
  calling `CreateSaleUseCase`; all business logic moved to
  `application/create-sale.usecase.ts` (row-locked stock check, catalog
  pricing only, idempotency).
- **`src/modules/purchasing/purchasing.controller.ts`** — same shape,
  delegating to `ReceivePurchaseUseCase`.
- **`src/modules/expenses/expenses.controller.ts`** — now constructs an
  `Expense` domain object to validate before persisting.
- **`src/modules/customers/customers.controller.ts`** — added pagination
  and tenant filtering.
- **`src/modules/health/health.controller.ts`** — fixed an invalid
  `db.execute()` call shape that didn't match Drizzle's API (see
  AUDIT_REPORT.md P1-5); marked `@Public()`.
- **`src/app.module.ts`** — wired the global `JwtAuthGuard`,
  `ThrottlerGuard`, `DomainExceptionFilter`, and every feature module.
- **`src/main.ts`** — removed a redundant `setGlobalPrefix('api')` that
  was doubling every route to `/api/api/v1/...` (P1); CORS now fails
  closed instead of defaulting to allow-any-origin (P1-3); added `helmet()`
  and Swagger bearer-auth config.
- **`package.json`** — added the dependencies/scripts/Jest config listed
  above; version bumped to `1.1.0`.
- **`.env.example`** — added `JWT_SECRET`, `JWT_EXPIRES_IN`.
- **`README.md`** — rewritten for the new auth flow, idempotency headers,
  and test commands.

## Removed

- Client-supplied `unitPrice` on sale line items (`CreateSaleDto` /
  `SaleItemDto`) — pricing now always comes from the catalog
  (AUDIT_REPORT.md P0-4).
- The global (cross-tenant) unique constraint on `variants.sku`, replaced
  by a per-business one (AUDIT_REPORT.md P0-7).

## Not changed (deliberately)

- `src/infrastructure/database/database.ts` / `database.module.ts` — no
  bug found; left as-is.
- `docker-compose.yml`, `drizzle.config.ts`, `nest-cli.json`,
  `tsconfig.json` — no bug found; left as-is.
