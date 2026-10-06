import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { DatabaseService } from '../../src/infrastructure/database/database';

/**
 * Boots the real AppModule (real Postgres, real guards, real transactions)
 * for integration tests. Requires DATABASE_URL to point at a database with
 * the current schema already pushed (`npm run db:push`) — see README.md
 * "Running the tests".
 */
export async function createTestApp(): Promise<{ app: INestApplication; db: DatabaseService }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  // v2.0: mirrors main.ts's body-parser handling exactly — Better Auth
  // needs the raw request body, so Nest's own parser is disabled here too
  // and express.json() is re-added for every other route. Without this,
  // every test that calls registerBusiness() (i.e. nearly all of them)
  // would fail: Nest's default body parser would consume the sign-up
  // request body before Better Auth's handler ever saw it.
  const app = moduleRef.createNestApplication({ bodyParser: false });
  app.use(express.json());
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  await app.init();
  const db = moduleRef.get(DatabaseService);
  return { app, db };
}

/** Wipes every table between tests so each test starts from a clean slate. */
export async function resetDatabase(db: DatabaseService): Promise<void> {
  await db.db.execute(sql`
    TRUNCATE TABLE
      idempotency_keys, return_items, returns, sale_items, sales,
      purchase_items, purchases, stock_movements, stock, variants,
      products, customers, suppliers, expenses,
      sessions, accounts, verifications, users, businesses
    RESTART IDENTITY CASCADE
  `);
}

export interface RegisteredBusiness {
  accessToken: string;
  businessId: string;
}

let counter = 0;

/**
 * Registers a fresh business + owner user and returns a bearer token.
 *
 * v2.0: goes through Better Auth's own `/api/auth/sign-up/email` instead of
 * the old custom `/api/v1/auth/register`. `businessName` is a Boutica
 * additionalField (see src/auth/auth.ts) accepted alongside Better Auth's
 * own required `name`/`email`/`password` fields; the sign-up response's
 * top-level `token` field is the session token to use as a bearer token on
 * every other request (confirmed against current Better Auth source — the
 * `set-auth-token` response header is the client-SDK convention, but the
 * raw JSON body already carries the same token directly for anyone calling
 * the endpoint themselves, which is what supertest does here).
 */
export async function registerBusiness(app: INestApplication, name = 'Test Shop'): Promise<RegisteredBusiness> {
  counter += 1;
  const res = await request(app.getHttpServer())
    .post('/api/auth/sign-up/email')
    .send({
      name: 'Test Owner',
      email: `owner${counter}-${Date.now()}@example.test`,
      password: 'a-very-long-password-123',
      businessName: `${name} ${counter}`,
    });
  if (!res.body?.token || !res.body?.user?.businessId) {
    throw new Error(`Sign-up did not return the expected shape: ${JSON.stringify(res.body)}`);
  }
  return { accessToken: res.body.token, businessId: res.body.user.businessId };
}

export async function createProductWithVariant(
  app: INestApplication,
  token: string,
  opts: { sellingPrice?: number; purchasePrice?: number; sku?: string } = {},
): Promise<{ productId: string; variantId: string }> {
  counter += 1;
  const product = await request(app.getHttpServer())
    .post('/api/v1/products')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: `Product ${counter}` })
    .expect(201);

  const variant = await request(app.getHttpServer())
    .post(`/api/v1/products/${product.body.id}/variants`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      sku: opts.sku ?? `SKU-${counter}`,
      name: 'Default',
      purchasePrice: opts.purchasePrice ?? opts.sellingPrice ?? 10,
      sellingPrice: opts.sellingPrice ?? 10,
    })
    .expect(201);

  return { productId: product.body.id, variantId: variant.body.id };
}

export async function adjustStock(app: INestApplication, token: string, variantId: string, quantity: number): Promise<void> {
  await request(app.getHttpServer())
    .post(`/api/v1/inventory/${variantId}/adjust`)
    .set('Authorization', `Bearer ${token}`)
    .send({ quantity })
    .expect(201);
}
