import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createProductWithVariant, createTestApp, registerBusiness, resetDatabase } from '../utils/test-app';
import { DatabaseService } from '../../src/infrastructure/database/database';

describe('Purchasing (e2e)', () => {
  let app: INestApplication;
  let db: DatabaseService;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDatabase(db);
  });

  it('receives a purchase and increases stock atomically', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 20, purchasePrice: 10 });

    const res = await request(app.getHttpServer())
      .post('/api/v1/purchases/receive')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity: 20, unitPrice: 10 }] })
      .expect(201);

    expect(res.body.total).toBe('200.00');

    const stockRes = await request(app.getHttpServer())
      .get(`/api/v1/inventory/${variantId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(stockRes.body.quantity).toBe(20);
  });

  it('rejects a zero or negative quantity', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 20, purchasePrice: 10 });

    await request(app.getHttpServer())
      .post('/api/v1/purchases/receive')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity: 0, unitPrice: 10 }] })
      .expect(400);
  });

  it('rejects an invalid (negative/zero) unit price', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 20, purchasePrice: 10 });

    await request(app.getHttpServer())
      .post('/api/v1/purchases/receive')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity: 1, unitPrice: -5 }] })
      .expect(400);
  });

  it('rejects receiving stock against a variant that belongs to another business (P0-1 regression test)', async () => {
    const businessA = await registerBusiness(app, 'Shop A');
    const businessB = await registerBusiness(app, 'Shop B');
    const { variantId } = await createProductWithVariant(app, businessA.accessToken, { sellingPrice: 20, purchasePrice: 10 });

    await request(app.getHttpServer())
      .post('/api/v1/purchases/receive')
      .set('Authorization', `Bearer ${businessB.accessToken}`)
      .send({ items: [{ variantId, quantity: 5, unitPrice: 10 }] })
      .expect(400);
  });

  it('does not double-increment stock when a request is retried with the same Idempotency-Key', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 20, purchasePrice: 10 });
    const payload = { items: [{ variantId, quantity: 5, unitPrice: 10 }] };

    await request(app.getHttpServer())
      .post('/api/v1/purchases/receive')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'purchase-retry-1')
      .send(payload)
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/purchases/receive')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'purchase-retry-1')
      .send(payload)
      .expect(201);

    const stockRes = await request(app.getHttpServer())
      .get(`/api/v1/inventory/${variantId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(stockRes.body.quantity).toBe(5); // incremented once, not twice
  });

  // NEW (v2.1, client-integration audit P0 §6)
  describe('GET /api/v1/purchases and /:id', () => {
    it('lists and fetches a received purchase, rejecting an unknown supplierId', async () => {
      const { accessToken } = await registerBusiness(app);
      const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 20, purchasePrice: 8 });

      await request(app.getHttpServer())
        .post('/api/v1/purchases/receive')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ supplierId: '00000000-0000-0000-0000-000000000000', items: [{ variantId, quantity: 1, unitPrice: 8 }] })
        .expect(400); // FIX (v2.1): supplierId is now validated against the tenant

      const supplier = await request(app.getHttpServer())
        .post('/api/v1/suppliers')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Real Supplier' })
        .expect(201);

      const received = await request(app.getHttpServer())
        .post('/api/v1/purchases/receive')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ supplierId: supplier.body.id, items: [{ variantId, quantity: 3, unitPrice: 8 }] })
        .expect(201);

      const list = await request(app.getHttpServer())
        .get('/api/v1/purchases')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(list.body.data).toHaveLength(1);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/purchases/${received.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(detail.body.items[0]).toMatchObject({ variantId, quantity: 3, unitPrice: '8.00' });
    });

    it('returns 404 for a nonexistent purchase id', async () => {
      const { accessToken } = await registerBusiness(app);
      await request(app.getHttpServer())
        .get('/api/v1/purchases/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    });
  });
});
