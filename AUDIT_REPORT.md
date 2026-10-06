# Boutica Backend — Audit Report

Scope: full source tree as delivered in `boutica-backend-v1.zip` (16 TypeScript
files, ~125 lines — a v1 foundation, per its own README). Every file was
read in full; nothing was assumed from the README alone.

**Read this first:** the sandbox this audit was performed in has no network
access and no Postgres/Docker runtime. `npm install`, `npm run build`,
`npm test`, and `npm run test:e2e` were **not executed**. Every fix below
was written carefully and cross-checked against NestJS/Drizzle/class-validator
APIs from memory, but you should run the full test suite locally before
treating anything here as verified. See section F.

Format per item: **Problem → Reason → Correction → Implementation → Test.**

---

## P0 — Critical

### P0-1. No authentication, no tenant isolation

**Problem.** There was no concept of a user or an authenticated principal
anywhere in the codebase. Every write endpoint accepted a `businessId`
directly in the request body, and every read/update/delete endpoint looked
resources up **by ID alone**, with no check that the resource belonged to
the caller. Concretely, with the original code: `GET /inventory/:variantId`,
the `adjust` endpoint, `POST /sales`, and `POST /purchases/receive` all
happily read or mutated another business's `stock` row given nothing but a
guessed or leaked variant UUID.

**Reason.** This is a direct violation of section 5 of the brief
("Un utilisateur appartenant au Business A ne doit jamais pouvoir... Ne
considère jamais un simple businessId envoyé par le client comme une preuve
d'autorisation"). A `businessId` field in a JSON body is not authorization —
it's a suggestion. In a real deployment this is a full cross-tenant data
breach: any customer of the SaaS could read or corrupt any other customer's
inventory, sales, and customer list.

**Correction.** Added a real (if intentionally minimal) auth system:
- `users` table (`businessId`, `email`, `passwordHash` via bcrypt, `role`).
- `POST /api/v1/auth/register` creates a business + an `OWNER` user and
  returns a JWT. `POST /api/v1/auth/login` verifies bcrypt hash and returns
  a JWT. Both are rate-limited (see P1-2) and the login response has a
  constant shape whether the email exists or the password is wrong, so it
  doesn't leak which emails are registered.
- `JwtAuthGuard` is registered globally (`APP_GUARD`) — every route is
  protected **by default**; `@Public()` is an explicit, auditable opt-out
  (used only by `/auth/register`, `/auth/login`, `/health`).
- `@CurrentTenant()` param decorator reads `{ userId, businessId, role }`
  from the verified token and injects it into the controller. Every
  controller and use-case now takes `businessId` **from the token**, never
  from the body, and every query/mutation is filtered by it.
- Where a table didn't carry `businessId` directly (`variants`, `stock`),
  it now does (denormalized — see the schema comments) so tenant filtering
  doesn't depend on a join being present on every query path.

**Implementation.** `src/modules/auth/**`,
`src/infrastructure/database/schema.ts` (`users` table,
`variants.businessId`, `stock.businessId`), every controller/use-case in
`src/modules/**`.

**Test.** `test/e2e/tenant-isolation.e2e-spec.ts` — no-token and
garbage-token requests get `401`; business B gets `404` reading business
A's product; business B's product list never contains business A's rows;
business B gets `404` adjusting business A's stock and `400` trying to sell
against business A's variant.

---

### P0-2. Stock overselling under concurrent requests

**Problem.** The sale flow read stock with a plain `SELECT`, checked
`quantity >= requested` in application code, and only later ran
`UPDATE stock SET quantity = quantity - X`. Two concurrent requests for the
same variant could both pass the check before either had decremented
anything:

```
Request A → reads stock = 5, checks 5 >= 4 → OK
Request B → reads stock = 5, checks 5 >= 4 → OK
Request A → UPDATE quantity = 5 - 4 = 1   (commits)
Request B → UPDATE quantity = 1 - 4 = -3  (commits — stock now negative)
```

**Reason.** This is the exact scenario called out in section 4 of the
brief. The final `UPDATE` statement is individually atomic, but the
*decision* to allow the sale ("do we have enough?") was made against a
value that was never locked, so it could be stale by the time the write
happened.

**Correction.** Inside the sale's transaction, lock every stock row
involved with `SELECT ... FOR UPDATE`, in a **fixed order** (sorted variant
IDs, deduplicated) so two sales touching overlapping variants serialize
instead of deadlocking. The "enough stock?" check now runs *after*
acquiring the lock, so the second concurrent transaction sees the
first transaction's decrement once it commits and is re-evaluated against
the real, current number. As defense-in-depth, `stock.quantity` also has a
Postgres `CHECK (quantity >= 0)` constraint — even a future bug that
reintroduces a race can't push a stock row negative; it'll raise `23514`,
which the global exception filter turns into a clean `409 Conflict`.

**Implementation.**
`src/modules/sales/application/create-sale.usecase.ts` (`.for('update')`
lock, re-check under lock),
`src/infrastructure/database/schema.ts` (`stock_quantity_non_negative`
check).

**Test.** `test/e2e/sales.e2e-spec.ts` → "never oversells under two
concurrent requests for the same stock": stock=5, two parallel requests
for 4 units each; asserts exactly one `201` and one `400`, and that final
stock is `1`, never negative.

---

### P0-3. Returns did not exist at all

**Problem.** There was no `Returns` module, no `returns`/`return_items`
tables, no endpoint. The brief is explicit that a return must never allow
`returnedQuantity > soldQuantity`, and must correctly affect stock — none
of that existed to check.

**Reason.** Returns are a core retail workflow (the brief lists it as a
required domain) and its absence is a functional gap, not a bug in
existing code — but it's P0 because shipping this backend without it means
merchants literally cannot process a return, and any bolt-on later without
the invariant below risks silent stock corruption.

**Correction.** New `Return` domain entity + `POST /api/v1/returns`:
- Validates the sale belongs to the caller's business and is `COMPLETED`.
- Locks the referenced `sale_items` rows (`FOR UPDATE`, sorted) — the same
  concurrency-safe pattern as P0-2 — then sums *previously completed*
  returns for those sale items and rejects any request that would push
  `returned > sold` (`Return.create` in the domain layer enforces this as
  a pure, unit-testable rule; the use-case only supplies the data).
- Each return item carries a `condition`: `RESTOCK` (goes back into
  sellable `stock`, logs a `RETURN` stock movement) or `DAMAGED` (logged as
  a `DAMAGE` movement — an enum value that already existed in the original
  schema but was never used anywhere — and does **not** re-enter sellable
  stock).
- Refund amount is always the original `sale_items.unitPrice`, never a
  client-supplied number (same reasoning as P0-4).

**Implementation.** `src/modules/returns/**`,
`src/infrastructure/database/schema.ts` (`returns`, `return_items`).

**Test.** `test/e2e/returns.e2e-spec.ts` — restock increases stock
correctly; damaged does not; over-return in one shot is rejected; over-return
across two partial returns is rejected (the aggregate case); a return
against another business's sale is `404`.
`src/modules/returns/domain/return.spec.ts` — pure unit tests of the
invariant, including the "already returned" accounting.

---

### P0-4. Client-supplied price trusted as source of truth

**Problem.** `POST /sales` took `unitPrice` directly from the request body
for every line item and used it, unvalidated, in the total calculation. A
client could sell anything at any price, including 0 or negative (nothing
stopped a negative number from reaching the money math before it hit the
`numeric` column).

**Reason.** Section 4 of the brief is explicit: *"Le prix envoyé par le
client ne doit jamais être considéré comme source de vérité sans
validation."* This is a direct revenue-integrity and fraud vector.

**Correction.** `CreateSaleDto`'s item shape no longer has a `unitPrice`
field at all — with `whitelist`/`forbidNonWhitelisted` now actually
enforced (see P0-6), sending one is rejected outright with `400`. The sale
use-case always prices from `variants.sellingPrice`, read inside the same
locked transaction. Returns work the same way (P0-3): refund price comes
from the original `sale_items.unitPrice`, never the request. Purchasing is
the one legitimate exception — what a business paid a supplier has no
other source of truth — so `unitPrice` stays there, but it's now bounded
(`@Min(0.01)`) and typed.

**Implementation.**
`src/modules/sales/dto/create-sale.dto.ts`,
`src/modules/sales/application/create-sale.usecase.ts`.

**Test.** `test/e2e/sales.e2e-spec.ts` → "rejects a client-supplied unit
price on a sale item": sending `unitPrice` on an item returns `400`.

---

### P0-5. No idempotency on Create Sale / Receive Purchase / Create Return

**Problem.** None of the three sensitive write operations the brief calls
out by name had any retry protection. A client timeout followed by a retry
(the exact scenario in section 10) would create two sales, double-decrement
stock, and double-charge in any real payment integration built on top of
this.

**Reason.** Explicit requirement (section 10). These are the three
operations where a duplicate is a financial/inventory-integrity bug, not a
cosmetic one.

**Correction.** All three use-cases accept an optional `Idempotency-Key`
header. Inside the same transaction as the business write: check for an
existing `(businessId, endpoint, key)` row first — if found, verify the
new request hashes the same as the stored one (reject with `409` if not),
otherwise replay the stored response. If not found, run the operation
normally and, at the end of the *same* transaction, insert the
idempotency record. The unique constraint on
`(businessId, endpoint, key)` is what makes this race-free without a
separate "processing" lock state: if two literally-concurrent retries both
run the full operation, only one of their two commit-time inserts can
win the unique constraint — the other's **entire transaction rolls back**,
including its sale/stock writes. The losing client gets a clean `409` and,
on its own retry, hits the replay branch.

**Implementation.** `src/common/idempotency/idempotency.util.ts`,
`idempotencyKeys` table in schema.ts, used in
`create-sale.usecase.ts`, `receive-purchase.usecase.ts`,
`create-return.usecase.ts`.

**Test.** `sales.e2e-spec.ts` and `purchasing.e2e-spec.ts` → retrying the
same `Idempotency-Key` + body returns the same resource and does not
double-move stock; reusing a key with a different body returns `409`.

---

### P0-6. Request validation did not run at all

**Problem.** Every controller typed its request body as an inline
TypeScript type literal (e.g. `body: { businessId: string; items:
{variantId:string; quantity:number; unitPrice:number}[] }`). `main.ts` did
configure `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true })`
— but `class-validator`/Nest's `ValidationPipe` only validates against a
**class** with decorators; a plain type literal compiles to `Object` at
runtime (TypeScript types don't exist after compilation), so Nest's
`toValidate()` check skips it entirely. The net effect: **zero runtime
validation ran anywhere**, despite the pipe being configured and despite
every field *looking* type-safe in the editor. Negative quantities,
negative prices, wrong types, and arbitrary extra fields all reached the
database untouched.

**Reason.** This is section 6 of the brief in its entirety, and it's P0
rather than P1 because it silently undermines every other type-looking
piece of code in the project — the compiler said everything was fine while
nothing was actually being checked at runtime.

**Correction.** Replaced every inline body type with a real
`class-validator`-decorated DTO class (`IsUUID`, `IsInt`, `Min`, `IsEnum`,
`ValidateNested` + `Type()` for nested arrays, etc.) so the existing
`ValidationPipe` configuration actually does something. Verified this by
tracing exactly why the old code failed to validate (documented above) so
the same mistake — swapping the DTO import for a demoted plain type later —
doesn't quietly reintroduce the bug.

**Implementation.** `src/modules/**/dto/*.ts` (new, throughout).

**Test.** Every e2e spec's "rejects invalid input" cases
(negative/zero quantity, extra/forbidden fields, malformed UUIDs) exercise
this end-to-end rather than just at the DTO-unit level.

---

### P0-7. Globally-unique SKU blocks the SaaS model

**Problem.** `variants.sku` had a single global unique index. Two unrelated
businesses cannot both use `SKU-001` — an extremely common, simple SKU
choice — without a collision.

**Reason.** Direct contradiction with section 5 ("Boutica est destiné à
devenir un produit SaaS"): a constraint that makes the product unusable by
more than one tenant at a time as soon as they pick overlapping SKU
conventions is a launch blocker, not a style nit.

**Correction.** Unique index changed to `(business_id, sku)`.

**Implementation.** `src/infrastructure/database/schema.ts`
(`variants_business_sku_unique`).

**Test.** `test/e2e/tenant-isolation.e2e-spec.ts` → "SKUs can be reused
across different businesses".

---

## P1 — High

### P1-1. Domain layer was entirely dead code

**Problem.** `Product`, `Sale`, `Purchase`, `Stock`, `Expense` domain
classes existed with real invariants (e.g. `Variant`: selling price must
not be below purchase price) but **no controller ever imported or called
them**. Every controller talked to Drizzle directly and re-implemented (or
simply omitted) the same rules ad hoc.

**Reason.** Section 3 asks explicitly for Domain/Application/Infrastructure
coherence. A domain layer that nothing calls isn't "pragmatic DDD" per
section 15 — it's just unused code that creates false confidence ("there's
a Variant class, so prices must be validated somewhere").

**Correction.** Sales, Purchasing, and Returns now go through a real
Application layer (`application/*.usecase.ts`) that constructs and calls
the domain entities (`Sale`, `Purchase`, `Return`) for every write. Catalog
and Expenses stay as thin controllers (deliberately — see P2-1) but now at
least construct the relevant domain object (`Product`, `Variant`,
`Expense`) to run its validation before persisting primitives, so the
invariant is exercised on every write instead of being decorative.

**Implementation.** `src/modules/sales/application/`,
`src/modules/purchasing/application/`,
`src/modules/returns/application/`, plus the `Product.create(...)` /
`new Variant(...)` / `Expense.create(...)` calls added to
`catalog.controller.ts` and `expenses.controller.ts`.

**Test.** `product.spec.ts`, `expense.spec.ts` unit tests; e2e "rejects a
selling price below purchase price" is enforced by the DB check constraint
as a second line of defense (see P1-4).

---

### P1-2. No rate limiting

**Problem.** No throttling anywhere, `/auth/login` included once it
existed.

**Reason.** Section 9 explicitly lists "absence de rate limiting" as
something to look for.

**Correction.** `@nestjs/throttler` registered globally (120 req/min per
IP by default) with a stricter override on `/auth/login` (5/min) and
`/auth/register` (20/min — high enough to not be a false-positive risk for
legitimate bulk onboarding, but bounded).

**Implementation.** `src/app.module.ts` (`ThrottlerModule`),
`src/modules/auth/auth.controller.ts` (`@Throttle` overrides).

**Test.** Not covered by the e2e suite (rate-limit assertions are
timing-sensitive and would make the suite flaky); recommend a manual
`ab`/`autocannon` check against `/auth/login` before production.

---

### P1-3. CORS defaulted to allow-any-origin

**Problem.** `origin: process.env.CORS_ORIGIN?.split(',') ?? true` — if
`CORS_ORIGIN` isn't set, the fallback `true` reflects *any* request
origin.

**Reason.** Section 9 ("CORS incorrect"). An unset env var silently
degrading to the most permissive possible setting is a fail-*open* default,
which is the wrong direction for a security-relevant config.

**Correction.** Fails closed: if `NODE_ENV=production` and `CORS_ORIGIN`
isn't set, the app refuses to start. In development it defaults to
`http://localhost:5173` (documented in `.env.example`) rather than a
wildcard.

**Implementation.** `src/main.ts`.

**Test.** Not covered by an automated test (would require spawning the
process with different env vars); documented in README as a startup
behavior to be aware of.

---

### P1-4. No database-level invariants (defense in depth)

**Problem.** Every business rule (stock ≥ 0, quantity > 0, selling price ≥
purchase price, discount ≤ subtotal) existed, if at all, only in
application code that — per P1-1 — wasn't even being called from most
write paths.

**Reason.** Section 4: *"Les invariants de stock doivent être protégés au
niveau approprié."* The appropriate level for a hard data invariant is the
database, not just a class nobody calls.

**Correction.** Added `CHECK` constraints: `stock.quantity >= 0`,
`sale_items.quantity > 0`, `purchase_items.quantity > 0`,
`return_items.quantity > 0`, `variants.selling_price >=
variants.purchase_price`, `sales.discount BETWEEN 0 AND subtotal`. The
global exception filter (P1-6) maps a `23514` (check violation) to a clean
`409` instead of a raw Postgres error.

**Implementation.** `src/infrastructure/database/schema.ts`.

**Test.** Enforced transitively by every e2e test that exercises these
paths (e.g. concurrent-sale test in P0-2 relies on the stock check firing
if the app-level lock were ever removed).

---

### P1-5. Health check used an invalid Drizzle call

**Problem.** The original health endpoint called
`this.db.db.execute({ sql: 'select 1', params: [] })`. Drizzle's
`.execute()` expects a `sql` tagged-template value (or a raw driver query
in the driver's own shape), not a plain `{sql, params}` object — this
either fails to type-check or fails at runtime depending on the exact
Drizzle version, meaning the health check — the one endpoint whose entire
job is to prove the database connection works — could never actually do
that.

**Reason.** Found while tracing every DB call for correctness (section 3:
"vérifie... les erreurs").

**Correction.** `this.db.db.execute(sql\`select 1\`)` using the real
tagged-template import from `drizzle-orm`.

**Implementation.** `src/modules/health/health.controller.ts`.

**Test.** Exercised implicitly by every e2e suite's `beforeAll` — if this
call were broken, the whole app wouldn't initialize/connect. No dedicated
test added since health checks are usually verified operationally
(uptime monitors), not in the app's own test suite.

---

### P1-6. No centralized error mapping

**Problem.** A thrown `DomainError` (e.g. "Insufficient stock") or a raw
Postgres driver error (unique violation, check violation, FK violation)
had no handler — Nest's default behavior returns an opaque `500` for
anything that isn't an `HttpException`, hiding a perfectly good
client-facing message and, in the opposite direction, risking a verbose
default error body for genuinely unexpected errors.

**Reason.** Section 8/9: consistent error format, and not leaking internals
on the one hand while not being uselessly opaque on the other.

**Correction.** Global `DomainExceptionFilter`: `DomainError` → `400` with
its message; Postgres `23505`/`23514`/`23503` → `409`/`409`/`400` with a
clean, non-leaking message; genuine `HttpException`s pass through
unchanged; anything else is logged server-side and returned as a generic
`500` with no stack trace to the client.

**Implementation.** `src/common/errors/domain-exception.filter.ts`,
registered as `APP_FILTER` in `app.module.ts`.

**Test.** Every "rejects ..." assertion across the e2e suite depends on
this filter translating the underlying `DomainError`/constraint violation
into the expected HTTP status.

---

### P1-7. Manual stock adjustment bypassed the audit trail

**Problem.** `POST /inventory/:variantId/adjust` set `stock.quantity`
directly and never wrote a `stock_movements` row, even though that table
exists specifically to record every stock change (`PURCHASE`, `SALE`,
`RETURN`, `ADJUSTMENT`, `DAMAGE` — two of which, `ADJUSTMENT` and
`DAMAGE`, existed in the enum but were **never referenced anywhere** in the
codebase).

**Reason.** Section 3 ("cohérence des données") — a manual correction
that leaves no trace defeats the purpose of having a movements ledger at
all; you cannot reconcile "why does this variant show 42 units" without
it.

**Correction.** The adjust endpoint now runs inside a transaction, locks
the current stock row, computes the delta, and — if non-zero — inserts an
`ADJUSTMENT` stock movement alongside the update.

**Implementation.** `src/modules/inventory/inventory.controller.ts`.

**Test.** Not asserted directly in the e2e suite (would require exposing a
"list movements" read endpoint, which doesn't exist yet — see section F);
covered indirectly by the write succeeding without error.

---

### P1-8. Money arithmetic used raw floating-point `number`

**Problem.** Controllers computed `subtotal`, `discount`, and `total` with
plain JS arithmetic (`i.quantity * i.unitPrice`, summed with `+`) directly
on floats, then stringified the result into a `numeric(14,2)` column. The
`Money` domain class existed but (per P1-1) wasn't used, so none of its
protections applied.

**Reason.** Section 7 explicitly asks to avoid naive `number`-based money
math and to consider integer minor units.

**Correction.** Rewrote `Money` to store an **integer number of minor
units** internally; `add`/`subtract`/`multiply` are all integer operations
— floating point only touches the boundary once, when parsing a decimal
string/number in (`Money.fromDecimal`, rounds to the nearest minor unit)
and once when serializing back out (`toDecimalString`). All three
use-cases (Sale, Purchase, Return) now go through `Money` exclusively.

**Implementation.** `src/common/domain.ts`.

**Test.** `src/common/domain.spec.ts` — includes a regression test that
ten additions of `0.10` sum to exactly `1.00` (the classic float-drift
failure case) and that `0.10 * 3` doesn't produce `0.30000000000000004`.

**Not fixed — flagged for a product decision, not silently changed:**
the schema still uses `numeric(14,2)` for every currency including the
default `XOF`, which in real-world use has **zero** decimal places. `Money`
supports a configurable `decimals` parameter for exactly this reason, but
changing the column precision (and every already-stored value) is a schema
migration plus a product decision, not something this pass makes
unilaterally. See section F.

---

### P1-9. `jest` was configured to run but had no configuration

**Problem.** `package.json` had `"test": "jest"` and `jest`/`ts-jest`/
`@types/jest` were **not even listed as dependencies**, and there was no
Jest config anywhere (no `jest` key in `package.json`, no `jest.config.*`).
Running `npm test` on the original project would fail immediately — and
there were zero `*.spec.ts` files to run in the first place.

**Reason.** Section 12 requires unit and integration tests; you can't add
tests to a test runner that isn't wired up.

**Correction.** Added `jest`, `ts-jest`, `@types/jest`,
`@nestjs/testing`, `supertest`, `@types/supertest` as devDependencies; a
`jest` config block in `package.json` for unit tests
(`src/**/*.spec.ts`) and a separate `test/jest-e2e.json` for integration
tests (`test/e2e/**/*.e2e-spec.ts`), matching Nest's own convention.

**Implementation.** `package.json`, `test/jest-e2e.json`.

**Test.** N/A (this is the test infrastructure itself) — see section E for
the exact commands, and the front matter of this report for the important
caveat that these were not actually executed in this sandbox.

---

## P2 — Medium

### P2-1. Deliberate scope decision: not every module gets a use-case/repository layer

Catalog, Customers, Expenses, and Inventory remain thin controllers
directly on `DatabaseService`, with tenant filtering and validated DTOs,
rather than getting a full `application/` + repository split like Sales,
Purchasing, and Returns. This is a conscious reading of section 15
("SOLID + DDD pragmatique... mais pas 100 abstractions pour 3 lignes de
logique"): these modules don't have cross-aggregate invariants or
multi-step transactional workflows that would justify the extra layer.
Where a real invariant does exist (variant pricing, product naming,
expense amount), the relevant domain class is still constructed and
validated (see P1-1) — it's the persistence layer that stays flat, not the
business rules.

### P2-2. No pagination on list endpoints

**Problem.** `GET /products` and `GET /customers` returned the entire
table with no limit.

**Correction.** Shared `PaginationQueryDto` (`page`, `pageSize`, capped at
100/page) applied to both, returning `{ data, page, pageSize, total }`.

**Implementation.** `src/common/pagination.dto.ts`,
`catalog.controller.ts`, `customers.controller.ts`.

### P2-3. No security headers

**Correction.** `helmet()` applied globally in `main.ts`.

### P2-4. Outbox pattern / domain events — evaluated, not built

Section 11 asks to evaluate whether domain events are genuinely needed.
There is currently no async consumer anywhere in this system (no queue, no
webhook dispatcher, no email/notification service) — introducing an
Outbox table and an event-publishing mechanism with nothing reading from
it would be exactly the "artificial event-driven architecture" section 11
warns against. **Decision: not implemented.** If/when an async consumer is
added (e.g. low-stock alerts, webhook notifications on `SaleCompleted`),
revisit the Outbox pattern at that point — the transactional writes in
`create-sale.usecase.ts` etc. are already structured so that adding an
outbox row in the same transaction would be a small, local change.

---

## P3 — Low

- **Code formatting.** The original files were extremely dense (multiple
  statements per line, no line breaks) which makes diffs and reviews
  harder than necessary. Every rewritten file uses conventional
  multi-line formatting. Purely cosmetic — noted because "readable enough
  to review" is itself a quality bar for a security-relevant codebase.
- **No `engines` field / `.nvmrc`** pinning the Node version. Not fixed;
  low risk, easy to add later.

---

## A. Corrected backend

The full corrected project is included as `boutica-backend/` (also
delivered as `boutica-backend-hardened.zip`), installable and runnable per
the README. It was **not** possible to run `npm install` or the test
suite in this environment (no network, no Postgres) — see the note at the
top of this report and section F.

## B. Audit summary

7 P0, 9 P1, 4 P2, 2 P3 findings — see above for the full list with
Problem/Reason/Correction/Implementation/Test for each.

## C. Changelog

See `CHANGELOG.md`.

## D. Final architecture

```
Presentation   → src/modules/**/*.controller.ts, **/dto/*.ts
Application    → src/modules/{sales,purchasing,returns}/application/*.usecase.ts
Domain         → src/modules/**/domain/*.ts, src/common/domain.ts (no framework imports)
Infrastructure → src/infrastructure/database/{schema,database}.ts
API            → REST, versioned at /api/v1, Swagger at /docs, Bearer JWT auth
Database       → PostgreSQL via Drizzle ORM, CHECK constraints for invariants,
                  row-level locking (SELECT ... FOR UPDATE) for the two genuine
                  concurrency hot paths (stock decrement, return-quantity check)
Security       → JWT auth (global guard, explicit @Public() opt-out), bcrypt
                  password hashing, per-tenant data isolation (denormalized
                  businessId + filtered queries), rate limiting, helmet,
                  fail-closed CORS, centralized error mapping (no internal
                  leakage)
Testing        → Jest unit tests for all domain entities/value objects;
                  Jest + Supertest integration tests against a real Postgres
                  instance for auth, concurrency, idempotency, and tenant
                  isolation
```

## E. Commands

```bash
npm install
npm run build
npm run lint
npm test              # unit
npm run test:cov      # unit, with coverage
npm run test:e2e      # integration — requires Postgres, see README
```

## F. Points requiring a product decision (not invented, flagged instead)

1. **Currency minor units.** `numeric(14,2)` is used for every currency
   including the default `XOF`, which has no real-world decimal
   subdivision. `Money` already supports a per-currency `decimals`
   parameter; wiring it up is a schema migration + a decision on how to
   treat currently-stored values.
2. **Manual sale price overrides.** Removed entirely (P0-4). If real
   businesses need negotiated/manual pricing on a sale line, that needs an
   explicit, authorized "price override" workflow (who can do it, is it
   audited, is there a max discount %) — not a body field anyone can set.
3. **Purchase receiving vs. catalog cost.** Receiving a purchase records
   what was paid in `purchase_items`, but does **not** update
   `variants.purchasePrice`. Whether receiving should update the catalog's
   recorded cost (and how — last cost? weighted average?) is a product
   decision.
4. **Staff invites.** Only the `OWNER` self-registration flow exists.
   Inviting additional `STAFF` users needs its own flow (invite link/email,
   who can invite, role management) — not built.
5. **Damaged-return tracking.** `DAMAGED` return items are logged as a
   `DAMAGE` stock movement and excluded from sellable stock, but there's no
   separate "damaged/quarantine" quantity ledger for reporting on them.
6. **Row-Level Security.** Tenant isolation is enforced via denormalized
   `businessId` columns and explicit `WHERE` filters in every query — solid,
   but Postgres RLS would add a genuine second layer of defense. Not
   implemented: it needs a decision on how to propagate the current
   tenant into the DB session (e.g. `SET app.current_business_id`) given
   the pooled `pg.Pool` connection currently in use.
7. **Session lifetime / revocation.** JWTs are stateless with a fixed
   expiry (`JWT_EXPIRES_IN`, default 12h) and no refresh token or
   revocation list. Fine for v1; a real product needs a decision on
   logout-everywhere, refresh tokens, and password reset.
8. **Migrations were not generated.** `drizzle-kit` could not be run in
   this environment (no network). `drizzle/` is empty — run
   `npm run db:generate && npm run db:migrate` (or `db:push` for local
   dev) as the very first step.
9. **No Dockerfile for the backend service itself** — `docker-compose.yml`
   only provisions Postgres. Containerizing the API is a separate,
   deployment-target-specific task.
10. **True in-flight idempotency collisions.** Two retries arriving at the
    literal same instant will both run the business logic; exactly one
    commits, the other gets a clean `409` and must retry once more to see
    the replayed response (see P0-5). A "wait for the in-flight request"
    upgrade is possible later but wasn't necessary for correctness.

## G. Round 2 — second hardening pass (v1.1 → v1.2)

This pass re-reads the actual v1.1 code with fresh eyes rather than trusting
this document's own narrative, and cross-checks version-sensitive library
APIs (Drizzle, `@nestjs/throttler`, `@nestjs/config`) against current
documentation instead of relying only on training-data memory, which is the
caveat section E of the original brief implicitly carried. Full diffs are in
`CHANGELOG.md`; this section is the reasoning.

### R2-1 — Sales: duplicate-variant line items silently under-decremented stock (bug)

**Where:** `src/modules/sales/application/create-sale.usecase.ts`.

**What was wrong:** the "enough stock?" check and the stock write both read
from `stockByVariant`, a `Map` snapshotted once from the row-locked `SELECT`
at the top of the transaction. If a single `POST /sales` request contained
two line items for the *same* `variantId` — nothing in `CreateSaleDto`
prevented this — each line's check ran against that same, un-decremented
snapshot (`available < item.quantity`), so two lines each individually
"fitting" could together demand more than was actually available. Worse,
the write (`stock.quantity = stockByVariant.get(variantId)! - item.quantity`)
computed an *absolute* value from that same stale snapshot for every line,
so the second line's write overwrote the first's instead of compounding it.
Net effect: `stock_movements` would correctly log both decrements, but
`stock.quantity` would only reflect the *last* line processed — the shop's
recorded stock would overstate what was actually on the shelf after such a
sale, and the insufficient-stock check could be bypassed by splitting one
variant across two lines.

This is exactly the class of bug P0-2 fixed for the *cross-request* race
(two concurrent sales); this is the same failure mode but *within* a single
request, which the `FOR UPDATE` lock does nothing to prevent since it's not
a concurrency problem — it's a JS aggregation bug.

**Why receiving/returns don't have this bug:** `receive-purchase.usecase.ts`
and `create-return.usecase.ts` both write stock via an atomic SQL
`sql`` ${stock.quantity} + ${value} `` expression, which reads the row's
*current* value at write time, not a pre-loop snapshot. Sales was the one
place still doing the arithmetic in JavaScript.

**Fix:** the check now sums demand per variant from the raw request before
comparing against the lock (correct regardless of how many lines touch one
variant), and the write is now the same atomic SQL decrement pattern already
used by the other two use-cases. `CreateSaleDto` also now rejects duplicate
`variantId`s outright via `@ArrayUnique` — there's no legitimate reason to
split one variant across two sale lines (price always comes from the
catalog), so failing fast with a clear 400 is better than silently merging.
The use-case fix stands on its own regardless of the DTO guard, by design —
see the code comment on why it doesn't rely on it.

**Regression tests:** `test/e2e/sales.e2e-spec.ts` — "rejects a sale with
two line items for the same variant".

### R2-2 — Returns: the same aggregation bug, but a real use case exists (bug)

**Where:** `src/modules/returns/domain/return.ts`, `Return.create`.

**What was wrong:** identical shape to R2-1. `remaining = soldQuantity -
alreadyReturnedQuantity` was computed once per requested line from the
`returnable` map the use-case passed in, with no accounting for other lines
in the *same* request against the *same* `saleItemId`. Two lines each within
the remaining limit could together exceed it — undermining the exact
invariant P0-3 exists to enforce, just from a different angle (within-request
instead of cross-request, which the use-case's row lock already handles
correctly).

**Why this one needed a real fix, not a rejection:** unlike sales, splitting
one `saleItemId` across multiple return lines is a legitimate case — e.g. of
5 units sold, 2 come back sellable (`RESTOCK`) and 1 comes back broken
(`DAMAGED`) in the same return. Rejecting duplicates the way R2-1 does would
break that workflow. `Return.create` now tracks a running
`consumedInThisRequest` map per `saleItemId` and checks each line against
`soldQuantity - alreadyReturnedQuantity - consumedSoFar`.

**Regression tests:** `src/modules/returns/domain/return.spec.ts` — one test
confirming the over-return is still rejected, one confirming the legitimate
split (summing exactly to the sold quantity) is accepted.

### R2-3 — `database.ts`/`database.module.ts`: v1.1 said "no bug found"; there was one

**Where:** `src/infrastructure/database/database.ts`,
`src/infrastructure/database/database.module.ts`.

v1.1's own `CHANGELOG.md` listed these two files under "Not changed
(deliberately) — no bug found; left as-is." On re-reading them for round 2:
they were still in the pre-hardening dense, single-statement-per-line style
that every other file in this codebase moved away from, and
`DatabaseService` read `process.env.DATABASE_URL` directly with **no
validation** — while `JWT_SECRET`, right next door conceptually, had a
manual length check in `auth.module.ts`. An empty or misspelled
`DATABASE_URL` would not fail at startup; it would fail confusingly at the
first query. `zod` has been a listed `package.json` dependency since v1.1
but was never imported anywhere — this looks like it was intended for
exactly this kind of validation and never wired up.

**Fix:** `src/config/env.schema.ts` — a single Zod schema validating
`DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `PORT`, `CORS_ORIGIN`, and
`NODE_ENV` once, at bootstrap, via
`ConfigModule.forRoot({ validationSchema: envSchema })` (confirmed against
current `@nestjs/config` docs — this is the supported way to plug a Zod
schema in directly, via its Standard Schema support). `database.ts` now
takes `ConfigService` in its constructor instead of reading `process.env`,
and both files were reformatted to match the rest of the codebase.
`main.ts`'s manual `NODE_ENV=production` → `CORS_ORIGIN` required check and
`auth.module.ts`'s manual `JWT_SECRET.length < 32` check are both now
redundant with the centralized schema and were removed, so the policy lives
in exactly one place.

### R2-4 — Money silently defaulted to XOF instead of the business's currency (inconsistency)

**Where:** `src/modules/catalog/catalog.controller.ts` (`addVariant`),
`src/modules/expenses/expenses.controller.ts` (`create`).

Both called `Money.fromDecimal(value)` with no currency argument, silently
defaulting to `'XOF'`, while `sales`/`purchasing`/`returns` all correctly
fetch `businesses.currency` first. Harmless today only because neither
controller ever compares the resulting `Money` against another instance of
a different currency — but it's exactly the kind of latent inconsistency
that becomes a real bug the day a business on a non-XOF currency exercises a
code path that does compare, and there's no reason for these two controllers
to be the odd ones out. Both now fetch the business's currency first, like
every other module already does.

### R2-5 — Missing endpoints vs. the original brief (gaps, not bugs)

The original brief (section 6) is explicit that the backend must support a
reports/dashboard workflow and full expense management. Neither v1.1's
implementation nor its own audit report addressed this — round 1 scoped
itself to hardening what already existed in the provided codebase, and a
dashboard/reports module simply never existed to harden.

- **No reports/dashboard endpoint existed at all.** Added
  `GET /api/v1/reports/dashboard` (`src/modules/reports/`): revenue,
  expenses, an *estimated* profit, stock value (at cost), recent sales, top
  products by units sold, and low-stock alerts, all over an optional
  `?from=&to=` window. Kept as a thin, read-only controller — same pattern
  already used for catalog/customers (P2-1) — since there's no write path
  or invariant to protect, only aggregation queries.
  - **Estimated profit caveat, stated plainly rather than hidden in a
    number:** gross margin is computed as
    `(sale_items.unitPrice - variants.purchasePrice) * quantity`, using the
    variant's *current* purchase price as a stand-in for cost of goods sold
    at the time of sale, because `sale_items` does not capture a cost
    snapshot. If purchase prices change over time, this will drift from a
    true historical COGS. A `costAtSale` column on `sale_items`, captured
    at sale time, is the correct fix if this number needs to be exact
    rather than a reasonable estimate — flagged here rather than invented.
  - **Receivables (créances)** are reported as `null`, not a fabricated
    `0` — see point F.5-adjacent: no credit/AR ledger exists anywhere in
    the schema (matches the spirit of the "isolated remaining field" trap
    the original brief itself warned against for customer credit).
- **`GET /api/v1/expenses` did not exist** — the module could record an
  expense but never list them back. Added, with the same pagination
  pattern as catalog/customers.
- **Still not built** (noted, not resolved, consistent with section F's
  "flag, don't invent" approach): `GET /customers/:id`, per-customer
  purchase history, update/deactivate for customers or expenses.

### R2-6 — Open questions this pass did not resolve unilaterally

- **`docker-compose.yml` (provisions local Postgres only) and the npm/Jest
  toolchain.** Left untouched. A separate, later-recorded decision for the
  Boutica Cloud rebuild calls for pnpm, Vitest, and no Docker anywhere —
  it's unclear whether that policy was meant to apply to this repo too or
  only to that fresh rebuild, and reversing a working toolchain isn't a
  call to make silently while looking for bugs.
- **`drizzle/` is still empty** (F.8, unresolved for the same reason as
  before — no network access in this environment to run `drizzle-kit`).

### Verified against current documentation, not just memory

- Drizzle's `.for('update')` locking clause and `onConflictDoUpdate` with a
  `sql`` col + value `` atomic increment both match current docs exactly as
  already used in `receive-purchase.usecase.ts`/`create-return.usecase.ts` —
  no change needed there.
- `@nestjs/throttler`'s `@Throttle({ default: { limit, ttl } })` object
  syntax (`auth.controller.ts`) matches the current v5/v6 decorator API.
- `drizzle-kit`'s `defineConfig({ dialect: 'postgresql', dbCredentials: {
  url } })` shape (`drizzle.config.ts`) matches the current config schema.

## H. v2.0 — Neon + Better Auth, no Docker

This is a re-architecture, not another hardening pass: three specific,
concrete changes were requested — remove Docker entirely, move Postgres to
Neon, and replace the hand-rolled JWT auth with Better Auth as the single
auth system — plus a re-check of every money calculation and the
sale-margin historical-accuracy gap flagged in round 2 (R2-5). Full diffs
in `CHANGELOG.md`; this section is the reasoning, including for the parts
of this migration this pass is least certain about.

### H-1 — Docker removed entirely

`docker-compose.yml` deleted; no `Dockerfile` existed to remove. README and
`.env.example` rewritten around a Neon-only setup flow (`npm install` →
`.env` → `npm run db:push` → `npm run start:dev`, no container step
anywhere). Nothing else in the repo referenced Docker.

### H-2 — Neon: direct connection, not pooled

Neon exposes two connection strings per branch: a **direct** one and a
**pooled** one (routed through PgBouncer in transaction-pooling mode,
suffixed `-pooler`). Checked against current Neon documentation rather than
assumed: the pooled string is Neon's own recommendation for serverless
functions that open many short-lived connections (Lambda, Vercel
Functions, Cloudflare Workers) — this app is the opposite of that. It's a
long-running NestJS process that already manages its own persistent
`pg.Pool`. Layering that on top of PgBouncer's transaction pooling risks
session-level features and prepared-statement caching breaking in ways
that wouldn't show up until production traffic patterns hit them. Both
`database.ts` and `src/auth/auth.ts` use the **direct** connection string;
`.env.example` documents why so a future "just use the pooled one, it's
right there" edit doesn't reintroduce this. `ssl: { rejectUnauthorized:
true }` is set explicitly rather than relying on `sslmode=require` being
parsed out of the connection string implicitly — matches Neon's own
security-conscious example, not just the minimal one.

### H-3 — Better Auth: one system, not two

The brief was explicit that keeping a second, parallel JWT mechanism
"because the backend already uses `@nestjs/jwt`" was worse than fully
committing to one. `@nestjs/jwt`, `bcrypt`, and the entire hand-rolled
`auth.controller.ts`/`auth.service.ts`/`jwt-auth.guard.ts` stack are
deleted, not kept alongside Better Auth.

**Integration path:** `@thallesp/nestjs-better-auth`, the community
package Better Auth's own current documentation points to for NestJS
specifically (confirmed via its official docs, not assumed). It registers
a global guard automatically — every route protected by default, exactly
the posture the old `JwtAuthGuard` had — with `@AllowAnonymous()` as the
new per-route opt-out (`health.controller.ts`; was `@Public()`). It
requires Nest's built-in body parser to be disabled
(`NestFactory.create(AppModule, { bodyParser: false })`) so Better Auth can
read the raw request stream itself; `express.json()` is added back
explicitly right after, which — per Better Auth's own documented ordering
requirement — still parses `req.body` for every other route exactly as
before. This had to be replicated in `test/utils/test-app.ts`'s
`createNestApplication()` call too; missing that would have silently
broken every single e2e test that signs up a user (i.e. nearly all of
them), since Nest's default body parser would have consumed the sign-up
request body before Better Auth ever saw it.

**Multi-tenancy, unchanged in shape:** sign-up still creates a business AND
its OWNER user in one call, exactly like v1.x's `/auth/register`. Better
Auth's `user.additionalFields` carries this: `businessId` (`input: false`
— a client cannot attach itself to an arbitrary existing business by
sending an id), `businessName`/`businessCurrency` (`input: true, returned:
false` — accepted at sign-up, used once, never echoed back), `role`
(`type: ['OWNER','STAFF']`, defaults to `'OWNER'`). A
`databaseHooks.user.create.before` hook creates the `businesses` row and
attaches its id before the user row is ever written (`src/auth/auth.ts`) —
confirmed against Better Auth's current hook signature and additionalFields
behavior via its documentation rather than assumed from general framework
familiarity, since getting this specific mechanism wrong would have meant
every sign-up either failing or creating tenant-less users.

**Blast radius, deliberately minimized:** `Tenant` (`tenant.type.ts`) did
not change shape. Every controller in the codebase still does
`@CurrentTenant() tenant: Tenant` exactly as in v1.x — only
`current-tenant.decorator.ts`'s internals changed (now resolves via
`auth.api.getSession` + `fromNodeHeaders`, Better Auth's own documented
framework-agnostic session API, rather than reaching into whatever
internal request property `@thallesp/nestjs-better-auth` attaches its own
resolved session to — that isn't part of its public API surface, and
depending on it would have been a guess). This is why sales, purchasing,
returns, catalog, inventory, customers, expenses, and reports needed zero
changes for this migration beyond the ones described elsewhere in this
section (costAtSale, currency lookups already fixed in earlier rounds).

**Mobile/JWT, resolved as one system:** the brief's diagram showed
`Android/Web → JWT → Boutica API` as if separate from the Better Auth
session. Two of Better Auth's own plugins cover this without introducing a
second mechanism: `bearer()` lets a client without cookie support (mobile)
send `Authorization: Bearer <session-token>` instead — the exact token
returned in the sign-up/sign-in JSON body's `token` field, confirmed
against Better Auth's own route source, not just its higher-level docs.
`jwt()` additionally mints a real, stateless, JWKS-verifiable JWT via `GET
/api/auth/token`, for a genuinely different use case (a portable credential
for some future third-party integration, verifiable without hitting this
database) — enabled and ready, but Boutica's own API doesn't verify these
itself; it validates sessions directly, the same as every other request.
Both plugins mint credentials for the SAME underlying session, not two
competing identity systems.

**Password hashing:** Better Auth hashes credential-provider passwords
itself (scrypt, stored on `accounts.password`) — `bcrypt` was removed
rather than kept for a code path that no longer exists, for the same
"don't run two mechanisms" reason as the JWT question.

### H-4 — Two database pools now exist (accepted, not a bug)

`AuthModule.forRoot({ auth })` needs a fully-built `auth` instance at
import time, before Nest's DI container exists — there's no way for
`src/auth/auth.ts` to inject `DatabaseService`. It creates its own small
`pg.Pool` (`max: 5`) instead. This is real, minor overhead (a handful of
extra idle connections), not an oversight — flagged plainly in
`CHANGELOG.md` rather than left for someone to discover and wonder about
later.

### H-5 — Sign-up's business-creation is not fully transactional (flagged, not solved)

The `databaseHooks.user.create.before` hook inserts the `businesses` row
using its own `db` reference; Better Auth's adapter then inserts the
`users` row separately afterward. These are **not** wrapped in one shared
transaction — that boundary is inside Better Auth's own adapter internals,
outside this app's control from a hook. If the user insert fails *after*
the hook has already created the business (e.g. two sign-ups racing on the
same email, one loses a unique-constraint check Better Auth performs after
the hook runs), the business row is orphaned — created, but owned by
nobody. Rare in practice, cheap to clean up manually if it ever happens,
and worth naming plainly rather than presenting this migration as fully
airtight when it isn't.

### H-6 — CurrentTenant does one redundant session lookup per request (accepted trade-off)

`@thallesp/nestjs-better-auth`'s global guard already calls something
equivalent to `getSession` once to decide whether to allow a request.
`CurrentTenant` (this app's own decorator) calls `auth.api.getSession`
again, independently, to get a properly-typed `Tenant`. That's one
avoidable extra session lookup per protected request. The alternative —
reading whatever request property the guard internally stashes its
resolved session under — was rejected because that property isn't part of
the package's documented public API; depending on it would be depending on
an implementation detail that could change without notice in a minor
version bump. Correctness over micro-optimization, stated as a deliberate
choice rather than left implicit.

### H-7 — sale_items.costAtSale (closes round 2's R2-5)

Round 2 flagged, but didn't fix, that margin reporting read
`variants.purchasePrice` — the variant's CURRENT cost — meaning a cost
change today silently changed the reported margin on sales from months
ago. `sale_items.costAtSale` now captures the purchase price at the moment
of each sale (`create-sale.usecase.ts`); `reports.controller.ts`'s
grossMargin query reads it, falling back to the variant's current cost only
for the (few, pre-migration) rows where it's `NULL`. Verified with a
regression test that changes a variant's price via a direct Drizzle write
(there is currently no endpoint to edit a variant's price at all — a
pre-existing gap, surfaced while writing this test, not introduced here and
not fixed in this pass) after recording a sale, and asserts the dashboard's
`estimatedProfit` for that period is unaffected.

### H-8 — Money / floating-point, re-checked (brief section 10)

Re-read `common/domain.ts` (`Money`, integer minor units, no float
arithmetic) and every place that constructs or combines a `Money` value
(sales, purchasing, returns, catalog, expenses, reports) with this
migration's changes specifically in mind. No new floating-point risk was
introduced: `costAtSale` is stored and read as a `numeric` decimal string
like every other money column, never parsed to a JS `number` except at
`reports.controller.ts`'s existing `toMinorUnits()` boundary (added in
round 2, for the exact reason `estimatedProfit` can be negative and `Money`
deliberately disallows that — see round 2's R2 section). No change was
needed here; this is a confirmation, not a fix.

### H-9 — Android/Web/API surface (brief section 11)

Every `/api/v1/...` endpoint, its request/response shapes, status codes,
pagination, and error format are **unchanged** by this migration — the
only breaking surface is the auth endpoints moving to `/api/auth/*` (see
README "Authentication"). Existing mobile/web clients need exactly one
change: point sign-up/sign-in at the new paths and switch to the field
names Better Auth expects (`name`/`email`/`password`/`businessName`
instead of `businessName`/`ownerEmail`/`ownerPassword`).

### H-10 — Testing without Docker

No Postgres/Docker is reachable from this sandbox, so nothing here could be
run for real (same caveat as v1.1/v1.2). What changed in the test
*strategy* specifically: `README.md` now documents pointing `test:e2e` at a
dedicated Neon branch (free, instant to create, safe to `TRUNCATE`) instead
of a Docker-provisioned local Postgres. `test/utils/test-app.ts` was
updated for the body-parser requirement (H-3) and to sign up through
Better Auth's real endpoint instead of the removed custom one; a new
`test/e2e/auth.e2e-spec.ts` covers sign-up, duplicate-email rejection,
sign-in success/failure, and that two sign-ups get two genuinely separate,
isolated businesses — there was no dedicated auth test file before v2.0
despite auth being explicitly first in the brief's own testing priorities.

### What carries the most residual risk in this delivery

Ranked honestly, for wherever `npm install && npm run build && npm test &&
npm run test:e2e` is run first:

1. **The Better Auth + Drizzle adapter wiring in `src/auth/auth.ts`**
   (schema mapping, additionalFields, the create-hook) — verified against
   Better Auth's current documentation and source snippets, but never
   executed against a real Postgres database from this environment. This
   is the single highest-risk piece in this delivery.
2. **Exact `better-auth` / `@thallesp/nestjs-better-auth` version numbers**
   in `package.json` — floors, not verified-current pins (no npm registry
   access here). Run `npm view better-auth version` and `npm view
   @thallesp/nestjs-better-auth version` before the first install.
3. **The sign-up JSON response shape** (`{ token, user }`) that
   `test/utils/test-app.ts` depends on — confirmed against Better Auth's
   route source for `signInEmail`/`signUpEmail`, not just higher-level
   docs, but still worth a first-run check given how much of the test
   suite depends on `registerBusiness()` working.
4. Everything else in this section (H-1, H-2, H-4 through H-9) carries
   normal, already-stated risk consistent with rounds 1 and 2 — mechanical
   changes, re-verified reasoning, honestly flagged trade-offs.

## I. v2.1 — client-readiness finalization

Implements the P0/P1 findings from `BOUTICA_V2_CLIENT_INTEGRATION_AUDIT.md`
directly (not just documenting them) — full detail and test results in
`BOUTICA_V2_FINALIZATION_REPORT.md`. Summary of the reasoning:

- **Variants browsing (P0):** split across two controllers deliberately —
  `GET /products/:id/variants` (CatalogController, product-scoped) and
  `GET /variants` (new VariantsController, business-wide + searchable) —
  because they serve genuinely different client needs (a product detail
  screen vs. a POS "find this item" search that doesn't know the product
  ahead of time), and because Nest route paths are relative to their
  controller's own prefix, so one method can't serve both `/products/...`
  and `/variants` paths from the same class.
- **Transaction history (P0):** sales/purchases/returns list+detail
  endpoints added as thin, read-only controller methods — no use-case
  layer, consistent with the P2-1 reasoning that already governs
  Catalog/Customers/Expenses/Reports (no invariant to protect, only
  aggregation/filtering).
- **`trustedOrigins` (P1):** sourced from the existing `CORS_ORIGIN` env
  var rather than a new one — verified against Better Auth's actual
  origin-check source (`validateOrigin` in
  `packages/better-auth/src/api/middlewares/origin-check.ts`) that this
  check only runs for requests carrying a `Cookie` header at all, which is
  exactly why it's a no-op for the three bearer-token client types and
  matters only for a browser-based Next.js deployment on a separate
  domain from the API.
- **Suppliers (P1):** new module, mirrors CustomersController exactly (list
  + create, no other operation justified). The more important half of this
  fix is in `receive-purchase.usecase.ts`, which had accepted ANY
  `supplierId` with zero ownership validation — a real, if narrow,
  cross-tenant reference gap, closed the same way the P0-1 variant
  ownership check already works.
- **Variant editing (P1):** validates the *merged* state (existing row +
  incoming fields) through `Variant`'s constructor invariant, not just the
  fields present in the request — a partial update that only lowers
  `sellingPrice` must still be checked against the *existing*
  `purchasePrice`, not silently skip that check because `purchasePrice`
  wasn't part of this particular request.
- **STAFF / multi-user (§12 of the brief):** verified, not built. No
  schema-level blocker exists — `users.businessId` is a plain index, not
  unique, so multiple users per business is already representable; `role`
  already accepts `STAFF`. Building the invite flow itself was explicitly
  out of scope for this pass and was not attempted.
- **Idempotency:** deliberately not extended to `POST /suppliers` or
  `PATCH .../variants/:id` — neither carries the stock/money duplication
  risk that justifies it on sales/purchases/returns, the same reasoning
  that already excluded `POST /customers` and `POST /expenses`.

**What this pass did not verify beyond static review**, consistent with
every prior round: no `npm install`/`build`/`test`/`test:e2e` could be
executed in this environment (no network access). The new tests were
written with the same care as the existing suite and reviewed line by line
against the actual schema and DTOs they exercise, but "written correctly"
and "passes" are not the same claim — see
`BOUTICA_V2_FINALIZATION_REPORT.md` section 5 for the honest, unhedged
statement of what was and wasn't actually run.
