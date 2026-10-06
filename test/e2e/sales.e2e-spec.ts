import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adjustStock, createProductWithVariant, createTestApp, registerBusiness, resetDatabase } from '../utils/test-app';
import { DatabaseService } from '../../src/infrastructure/database/database';

describe('Sales (e2e)', () => {
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

  it('creates a sale, prices from the catalog, and decrements stock', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 25 });
    await adjustStock(app, accessToken, variantId, 10);

    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity: 3 }] })
      .expect(201);

    expect(res.body.total).toBe('75.00');
    expect(res.body.status).toBe('COMPLETED');

    const stockRes = await request(app.getHttpServer())
      .get(`/api/v1/inventory/${variantId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(stockRes.body.quantity).toBe(7);
  });

  it('rejects a sale when requested quantity exceeds available stock', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
    await adjustStock(app, accessToken, variantId, 2);

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity: 5 }] })
      .expect(400);
  });

  it('never oversells under two concurrent requests for the same stock (P0-2 regression test)', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
    await adjustStock(app, accessToken, variantId, 5);

    const fire = () =>
      request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ items: [{ variantId, quantity: 4 }] });

    const [first, second] = await Promise.all([fire(), fire()]);
    const statuses = [first.status, second.status].sort();
    // Exactly one of the two concurrent sales of 4 units (against a stock
    // of 5) must succeed; the other must be rejected. Both succeeding would
    // mean 8 units sold against 5 in stock — the exact bug this fixes.
    expect(statuses).toEqual([201, 400]);

    const stockRes = await request(app.getHttpServer())
      .get(`/api/v1/inventory/${variantId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(stockRes.body.quantity).toBe(1); // 5 - 4, never negative
  });

  it('rejects a client-supplied unit price on a sale item (P0-4 regression test)', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
    await adjustStock(app, accessToken, variantId, 5);

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity: 1, unitPrice: 0.01 }] })
      .expect(400); // forbidNonWhitelisted rejects the unknown field outright
  });

  it('rejects a negative or zero quantity', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
    await adjustStock(app, accessToken, variantId, 5);

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity: 0 }] })
      .expect(400);

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity: -1 }] })
      .expect(400);
  });

  it('does not create a duplicate sale when a request is retried with the same Idempotency-Key', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
    await adjustStock(app, accessToken, variantId, 10);

    const payload = { items: [{ variantId, quantity: 2 }] };
    const first = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'retry-key-1')
      .send(payload)
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'retry-key-1')
      .send(payload)
      .expect(201);

    expect(second.body.id).toBe(first.body.id);

    const stockRes = await request(app.getHttpServer())
      .get(`/api/v1/inventory/${variantId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(stockRes.body.quantity).toBe(8); // decremented once, not twice
  });

  it('rejects reusing an Idempotency-Key with a different payload', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
    await adjustStock(app, accessToken, variantId, 10);

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'retry-key-2')
      .send({ items: [{ variantId, quantity: 1 }] })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .set('Idempotency-Key', 'retry-key-2')
      .send({ items: [{ variantId, quantity: 2 }] })
      .expect(409);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).post('/api/v1/sales').send({ items: [] }).expect(401);
  });

  it('rejects a sale with two line items for the same variant (round-2 regression test)', async () => {
    // Before this fix, each line was checked and (worse) written against a
    // stock snapshot taken before the request started, so two lines for the
    // same variant would each individually look fine and the second write
    // would silently overwrite the first's decrement instead of compounding
    // it — see create-sale.usecase.ts. Splitting one variant across two
    // lines has no legitimate use (price always comes from the catalog), so
    // it's rejected outright at the DTO boundary.
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
    await adjustStock(app, accessToken, variantId, 10);

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity: 3 }, { variantId, quantity: 3 }] })
      .expect(400);
  });

  // NEW (v2.1, client-integration audit P0 §5) — sales could be created but
  // never listed or reviewed again.
  describe('GET /api/v1/sales', () => {
    it('lists sales for the caller\'s business, most recent first, and filters by customerId', async () => {
      const { accessToken } = await registerBusiness(app);
      const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
      await adjustStock(app, accessToken, variantId, 10);

      const customer = await request(app.getHttpServer())
        .post('/api/v1/customers')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Aissata' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ items: [{ variantId, quantity: 1 }] })
        .expect(201);
      const withCustomer = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ items: [{ variantId, quantity: 1 }], customerId: customer.body.id })
        .expect(201);

      const all = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(all.body.total).toBe(2);
      expect(all.body.data[0].id).toBe(withCustomer.body.id); // most recent first

      // Doubles as this business's "customer purchase history" — see
      // ListSalesQueryDto.
      const filtered = await request(app.getHttpServer())
        .get(`/api/v1/sales?customerId=${customer.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(filtered.body.data).toHaveLength(1);
      expect(filtered.body.data[0].id).toBe(withCustomer.body.id);
    });

    it('rejects an unauthenticated request', async () => {
      await request(app.getHttpServer()).get('/api/v1/sales').expect(401);
    });
  });

  describe('GET /api/v1/sales/:id', () => {
    it('returns the sale with its line items', async () => {
      const { accessToken } = await registerBusiness(app);
      const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10, purchasePrice: 6 });
      await adjustStock(app, accessToken, variantId, 5);

      const created = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ items: [{ variantId, quantity: 2 }] })
        .expect(201);

      const res = await request(app.getHttpServer())
        .get(`/api/v1/sales/${created.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.total).toBe('20.00');
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ variantId, quantity: 2, costAtSale: '6.00' });
    });

    it('returns 404 for a nonexistent sale id', async () => {
      const { accessToken } = await registerBusiness(app);
      await request(app.getHttpServer())
        .get('/api/v1/sales/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(404);
    });
  });
});
