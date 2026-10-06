import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { adjustStock, createProductWithVariant, createTestApp, registerBusiness, resetDatabase } from '../utils/test-app';
import { DatabaseService } from '../../src/infrastructure/database/database';

describe('Returns (e2e)', () => {
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

  async function makeSale(accessToken: string, variantId: string, quantity: number) {
    const res = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity }] })
      .expect(201);
    return { saleId: res.body.id as string, saleItemId: res.body.items[0].id as string };
  }

  it('restocks a returned item and records a RETURN stock movement', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
    await adjustStock(app, accessToken, variantId, 10);
    const { saleId, saleItemId } = await makeSale(accessToken, variantId, 4);

    const res = await request(app.getHttpServer())
      .post('/api/v1/returns')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ saleId, items: [{ saleItemId, quantity: 2, condition: 'RESTOCK' }] })
      .expect(201);

    expect(res.body.total).toBe('20.00');

    const stockRes = await request(app.getHttpServer())
      .get(`/api/v1/inventory/${variantId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    // 10 - 4 sold + 2 returned = 8
    expect(stockRes.body.quantity).toBe(8);
  });

  it('does not restock a DAMAGED return', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
    await adjustStock(app, accessToken, variantId, 10);
    const { saleId, saleItemId } = await makeSale(accessToken, variantId, 4);

    await request(app.getHttpServer())
      .post('/api/v1/returns')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ saleId, items: [{ saleItemId, quantity: 2, condition: 'DAMAGED' }] })
      .expect(201);

    const stockRes = await request(app.getHttpServer())
      .get(`/api/v1/inventory/${variantId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    // 10 - 4 sold = 6, damaged units never re-enter sellable stock
    expect(stockRes.body.quantity).toBe(6);
  });

  it('rejects returning more than was sold (core mission invariant)', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
    await adjustStock(app, accessToken, variantId, 10);
    const { saleId, saleItemId } = await makeSale(accessToken, variantId, 3);

    await request(app.getHttpServer())
      .post('/api/v1/returns')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ saleId, items: [{ saleItemId, quantity: 4 }] })
      .expect(400);
  });

  it('rejects returning more than what remains after a previous partial return', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
    await adjustStock(app, accessToken, variantId, 10);
    const { saleId, saleItemId } = await makeSale(accessToken, variantId, 5);

    await request(app.getHttpServer())
      .post('/api/v1/returns')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ saleId, items: [{ saleItemId, quantity: 3 }] })
      .expect(201);

    // 5 sold, 3 already returned -> only 2 remain returnable.
    await request(app.getHttpServer())
      .post('/api/v1/returns')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ saleId, items: [{ saleItemId, quantity: 3 }] })
      .expect(400);
  });

  it('rejects a return for a sale that belongs to another business', async () => {
    const businessA = await registerBusiness(app, 'Shop A');
    const businessB = await registerBusiness(app, 'Shop B');
    const { variantId } = await createProductWithVariant(app, businessA.accessToken, { sellingPrice: 10 });
    await adjustStock(app, businessA.accessToken, variantId, 10);
    const { saleId, saleItemId } = await makeSale(businessA.accessToken, variantId, 3);

    await request(app.getHttpServer())
      .post('/api/v1/returns')
      .set('Authorization', `Bearer ${businessB.accessToken}`)
      .send({ saleId, items: [{ saleItemId, quantity: 1 }] })
      .expect(404);
  });

  // NEW (v2.1, client-integration audit P0 §7)
  describe('GET /api/v1/returns and /:id', () => {
    it('lists and fetches a return, filterable by the originating sale', async () => {
      const { accessToken } = await registerBusiness(app);
      const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
      await adjustStock(app, accessToken, variantId, 10);
      const { saleId, saleItemId } = await makeSale(accessToken, variantId, 4);

      const created = await request(app.getHttpServer())
        .post('/api/v1/returns')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ saleId, items: [{ saleItemId, quantity: 1, condition: 'DAMAGED' }] })
        .expect(201);

      const bySale = await request(app.getHttpServer())
        .get(`/api/v1/returns?saleId=${saleId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(bySale.body.data).toHaveLength(1);
      expect(bySale.body.data[0].id).toBe(created.body.id);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/returns/${created.body.id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(detail.body.items[0]).toMatchObject({ saleItemId, quantity: 1, condition: 'DAMAGED' });
    });

    it('returns 404 for a return belonging to another business', async () => {
      const businessA = await registerBusiness(app, 'Shop A');
      const businessB = await registerBusiness(app, 'Shop B');
      const { variantId } = await createProductWithVariant(app, businessA.accessToken, { sellingPrice: 10 });
      await adjustStock(app, businessA.accessToken, variantId, 10);
      const { saleId, saleItemId } = await makeSale(businessA.accessToken, variantId, 2);
      const ret = await request(app.getHttpServer())
        .post('/api/v1/returns')
        .set('Authorization', `Bearer ${businessA.accessToken}`)
        .send({ saleId, items: [{ saleItemId, quantity: 1 }] })
        .expect(201);

      await request(app.getHttpServer())
        .get(`/api/v1/returns/${ret.body.id}`)
        .set('Authorization', `Bearer ${businessB.accessToken}`)
        .expect(404);

      const list = await request(app.getHttpServer())
        .get('/api/v1/returns')
        .set('Authorization', `Bearer ${businessB.accessToken}`)
        .expect(200);
      expect(list.body.data).toHaveLength(0);
    });
  });
});
