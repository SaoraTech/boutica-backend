import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer, jwt } from 'better-auth/plugins';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { envSchema } from '../config/env.schema';
import { accounts, businesses, sessions, users, verifications } from '../infrastructure/database/schema';

/**
 * v2.0 — Better Auth is now the ONLY authentication system in this app. It
 * replaces the previous hand-rolled register/login controllers, bcrypt
 * hashing, and @nestjs/jwt sign/verify calls entirely, rather than running
 * alongside them — the brief was explicit that two competing auth
 * mechanisms is worse than one, even an imperfect one. See
 * AUDIT_REPORT.md section H for the full reasoning behind every choice
 * below.
 *
 * WHY THIS FILE HAS ITS OWN DATABASE POOL, SEPARATE FROM DatabaseService:
 * `AuthModule.forRoot({ auth })` (see app.module.ts) needs a fully-built
 * `auth` instance at *import time*, before Nest's dependency-injection
 * container exists — there is no way to inject `DatabaseService` here.
 * This is a real, if minor, duplication (two small connection pools
 * instead of one), forced by how the NestJS integration package has to
 * bootstrap; it is not an oversight. Kept small (max 5) since
 * authentication traffic is much lower-volume than the domain queries
 * DatabaseService serves.
 *
 * Same reasoning for reading env vars via `envSchema.parse(process.env)`
 * directly instead of `ConfigService`: this file is evaluated before
 * Nest's `ConfigModule` exists. It validates against the exact same
 * schema `main.ts` uses via `ConfigModule.forRoot({ validationSchema })`,
 * so there is exactly one set of rules for what a valid environment looks
 * like, checked twice, never two different sets of rules that could drift
 * apart.
 */
const env = envSchema.parse(process.env);

const useSsl = env.DATABASE_URL.includes('sslmode=require') || env.NODE_ENV === 'production';
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 5,
  ...(useSsl ? { ssl: { rejectUnauthorized: env.NODE_ENV === 'production' } } : {}),
});
const db = drizzle(pool, { schema: { users, sessions, accounts, verifications, businesses } });

export const auth = betterAuth({
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  // v2.1 FIX (client-integration audit, P1 §8): Better Auth does its own
  // origin/CSRF checking, independent of Express's CORS middleware
  // (main.ts) — without this, a cross-origin web client (Next.js on a
  // separate domain from the API, the normal production shape) would be
  // rejected by Better Auth itself even with CORS otherwise configured
  // correctly. Reuses CORS_ORIGIN rather than a second env var: one list
  // of trusted origins, not two that could drift apart. Bearer-token
  // clients (Kotlin, RN/Expo, Electron) are unaffected either way — this
  // only governs cookie/origin-based requests.
  trustedOrigins: env.CORS_ORIGIN?.split(',').map((o) => o.trim()),
  // Auth routes live at /api/auth/* — Better Auth's own convention, NOT
  // this app's usual /api/v1/* prefix. Fighting that convention (moving
  // its basePath) buys nothing and risks breaking its client SDKs/plugins,
  // which assume the default. Documented in README.md.
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: users,
      session: sessions,
      account: accounts,
      verification: verifications,
    },
  }),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10, // matches the length this app previously required
    // No email-sending infrastructure exists (see AUDIT_REPORT.md F.4 —
    // this was already true before this migration). Requiring
    // verification with no way to ever send the verification email would
    // permanently lock every new sign-up out; auto sign-in keeps the
    // previous "register returns you a usable session immediately"
    // behavior.
    requireEmailVerification: false,
    autoSignIn: true,
  },

  user: {
    additionalFields: {
      // Set by the databaseHooks.user.create.before hook below, never by
      // client input directly — a client cannot attach itself to an
      // arbitrary existing business by guessing/sending an id.
      businessId: {
        type: 'string',
        required: false,
        input: false,
      },
      // Write-only: required at sign-up, used once by the hook below to
      // create the business row, never sent back in any response
      // (`returned: false`). See the schema.ts comment on why this still
      // occupies a column on `users` rather than living somewhere cleaner.
      businessName: {
        type: 'string',
        required: true,
        input: true,
        returned: false,
      },
      // Optional ISO 4217 override, same purpose/lifecycle as
      // businessName. Loosely validated in the hook (falls back to XOF
      // rather than rejecting the sign-up outright) — this is a
      // deliberately small feature and a hard 400 from inside a
      // lifecycle hook is more error-handling machinery than it's worth.
      businessCurrency: {
        type: 'string',
        required: false,
        input: true,
        returned: false,
      },
      role: {
        type: ['OWNER', 'STAFF'],
        required: false,
        defaultValue: 'OWNER',
        input: false,
      },
    },
  },

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const rawCurrency = (user as { businessCurrency?: string }).businessCurrency;
          const currency = rawCurrency && /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'XOF';
          const businessName = (user as { businessName?: string }).businessName?.trim();
          if (!businessName) {
            // Belt-and-braces: `required: true` above should already have
            // rejected this, but the hook receiving arbitrary
            // Record<string, unknown> means TypeScript can't prove it, and
            // an empty business name is not a state worth allowing.
            throw new Error('businessName is required');
          }

          // NOTE (flagged, not solved here): this insert and the user row
          // Better Auth writes right after this hook returns are NOT in
          // one shared transaction — that boundary is inside Better
          // Auth's own adapter internals, outside this app's control. A
          // sign-up that fails *after* this hook runs (e.g. a duplicate
          // email racing with itself) can leave an orphaned business row
          // with no owner. Rare, and cheap to clean up manually if it
          // ever happens, but real — see AUDIT_REPORT.md section H.
          const [business] = await db.insert(businesses).values({ name: businessName, currency }).returning();
          if (!business) {
            throw new Error('Failed to create business record');
          }

          return {
            data: {
              ...user,
              businessId: business.id,
              role: 'OWNER',
            },
          };
        },
      },
    },
  },

  // Both plugins exist for the SAME session, not two parallel systems:
  // - bearer(): lets mobile/API clients that can't use cookies send
  //   `Authorization: Bearer <token>` instead. The sign-in response
  //   exposes that token via a `set-auth-token` response header for
  //   exactly this purpose.
  // - jwt(): mints a real, stateless, JWKS-verifiable JWT from an active
  //   session via `GET /api/auth/token`, for cases that genuinely need a
  //   portable signed credential (e.g. a future third-party integration)
  //   rather than hitting this database on every request. Boutica's own
  //   API does not verify these itself — it validates sessions directly
  //   via `auth.api.getSession`, the same as every other request; the
  //   JWKS endpoint is there for whoever else eventually needs it.
  plugins: [bearer(), jwt()],

  // Better Auth's own defaults already rate-limit /sign-in* and /sign-up*
  // more tightly than this app's old @Throttle(5/60s) on login (see
  // AUDIT_REPORT.md P1-2) — 3 requests per 10 seconds. Not overridden
  // here; default storage is in-memory, which is correct for this app's
  // current single-instance deployment and would need `storage:
  // 'database'` if it's ever run as more than one instance.
});
