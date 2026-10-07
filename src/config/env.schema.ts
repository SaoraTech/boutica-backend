import { z } from 'zod';

/**
 * Every environment variable the app reads, validated once at bootstrap via
 * `ConfigModule.forRoot({ validationSchema: envSchema })`. If anything is
 * missing or malformed, the app refuses to start with a single, readable
 * error listing every problem — instead of failing later, confusingly, the
 * first time a route touches the missing config (or, worse, silently
 * degrading to an unsafe default).
 *
 * ROUND 2 FIX: before this file existed, `JWT_SECRET` was the only env var
 * validated (a manual length check in auth.module.ts); `DATABASE_URL`,
 * `PORT`, `CORS_ORIGIN`, and `NODE_ENV` were all read raw from
 * `process.env` in main.ts/database.ts with no validation at all — an
 * empty/misspelled `DATABASE_URL` would only surface as an opaque
 * connection error at the first query, not at startup. `zod` was already a
 * listed dependency for exactly this purpose but was never actually wired
 * up anywhere in the codebase.
 *
 * v2.0: `JWT_SECRET`/`JWT_EXPIRES_IN` are gone — Better Auth signs its own
 * sessions/JWTs from `BETTER_AUTH_SECRET`, and keeping a second secret
 * around for a system that no longer verifies anything with it is exactly
 * the "two competing auth mechanisms" this migration was asked to avoid.
 *
 * This schema is imported from two different bootstrap entry points:
 * `main.ts`'s `ConfigModule.forRoot({ validationSchema: envSchema })` (the
 * normal Nest DI path), AND `src/auth/auth.ts`, which calls
 * `envSchema.parse(process.env)` directly. Better Auth's instance has to
 * exist as a plain module-scope object *before* Nest's DI container is
 * even running (`AuthModule.forRoot({ auth })` needs a concrete instance
 * at import time), so it can't wait for `ConfigService` — it validates
 * against this exact same schema instead, so the two bootstrap paths can
 * never drift out of sync with different rules.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

    PORT: z.coerce.number().int().positive().default(3000),

    // A Neon "direct" (non "-pooler") connection string is recommended
    // here, not the pooled one — this app already manages its own
    // persistent pg.Pool, and layering that on top of Neon's own PgBouncer
    // pooling (meant for serverless functions with many short-lived
    // connections) risks session-level features breaking under PgBouncer's
    // transaction-pooling mode. See .env.example.
    DATABASE_URL: z
      .string()
      .min(1, 'DATABASE_URL is required (e.g. a Neon connection string — see .env.example)'),

    // FIX (P0-1 origin, tightened here): a short/predictable secret makes
    // every issued session/JWT forgeable. 32 chars is a floor, not a
    // target — use a real random value (e.g. `openssl rand -base64 48`) in
    // every environment, not just production.
    BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be a random string of at least 32 characters'),
    // The externally-reachable base URL of this API — Better Auth uses it
    // to build callback links and as the issuer/audience for the JWT
    // plugin's tokens and JWKS discovery document. Must match what clients
    // actually hit (e.g. http://localhost:3000 in dev).
    BETTER_AUTH_URL: z.string().url('BETTER_AUTH_URL must be a full URL, e.g. http://localhost:3000'),

    // FIX (P1-3 origin, centralized here): kept optional at the schema
    // level (dev doesn't require it — main.ts falls back to a
    // documented localhost default) but enforced below via .refine() once
    // NODE_ENV=production, so the fail-closed behavior lives in one place
    // instead of a separate manual check in main.ts.
    CORS_ORIGIN: z.string().optional(),
  })
  .refine((env) => env.NODE_ENV !== 'production' || !!env.CORS_ORIGIN, {
    message: 'CORS_ORIGIN must be set explicitly when NODE_ENV=production (comma-separated origins)',
    path: ['CORS_ORIGIN'],
  });

// Bridge for NestJS ConfigModule.forRoot({ validationSchema: envSchema })
// which expects a schema object with a Joi-like .validate() function.
Object.assign(envSchema, {
  validate(config: Record<string, unknown>) {
    const result = envSchema.safeParse(config);
    if (result.success) {
      return { value: result.data };
    }
    return { error: result.error };
  },
});

export type Env = z.infer<typeof envSchema>;
