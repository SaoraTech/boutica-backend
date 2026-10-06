import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createProductWithVariant, createTestApp, registerBusiness, resetDatabase } from '../utils/test-app';
import { DatabaseService } from '../../src/infrastructure/database/database';

describe('Catalog — variants (e2e)', () => {
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

  it('lists variants for a product, including current stock quantity', async () => {
    const { accessToken } = await registerBusiness(app);
    const { productId, variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 20 });
    await request(app.getHttpServer())
      .post(`/api/v1/inventory/${variantId}/adjust`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ quantity: 7 })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/products/${productId}/variants`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ id: variantId, quantity: 7 });
  });

  it('returns 404 for variants of a nonexistent/foreign product', async () => {
    const { accessToken } = await registerBusiness(app);
    await request(app.getHttpServer())
      .get('/api/v1/products/00000000-0000-0000-0000-000000000000/variants')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);
  });

  it('searches variants business-wide by name or SKU, scoped to the caller\'s tenant', async () => {
    const { accessToken } = await registerBusiness(app);
    await createProductWithVariant(app, accessToken, { sku: 'RED-HAMMER', sellingPrice: 15 });
    await createProductWithVariant(app, accessToken, { sku: 'BLUE-WRENCH', sellingPrice: 12 });

    const res = await request(app.getHttpServer())
      .get('/api/v1/variants?search=hammer')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].sku).toBe('RED-HAMMER');
  });

  it('updates a variant, re-validating the price invariant against the merged state', async () => {
    const { accessToken } = await registerBusiness(app);
    const { productId, variantId } = await createProductWithVariant(app, accessToken, { purchasePrice: 10, sellingPrice: 20 });

    const ok = await request(app.getHttpServer())
      .patch(`/api/v1/products/${productId}/variants/${variantId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ sellingPrice: 25 })
      .expect(200);
    expect(ok.body.sellingPrice).toBe('25.00');

    // Lowering sellingPrice below the EXISTING (unchanged) purchasePrice
    // must still be rejected — this only works if the update validates
    // against the merged state, not just the fields sent in this request.
    await request(app.getHttpServer())
      .patch(`/api/v1/products/${productId}/variants/${variantId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ sellingPrice: 5 })
      .expect(400);
  });

  it('rejects a variant update that collides with another variant\'s SKU in the same business', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId: variantA } = await createProductWithVariant(app, accessToken, { sku: 'SKU-A' });
    const { productId: productB, variantId: variantB } = await createProductWithVariant(app, accessToken, { sku: 'SKU-B' });

    await request(app.getHttpServer())
      .patch(`/api/v1/products/${productB}/variants/${variantB}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ sku: 'SKU-A' })
      .expect(409);

    // Sanity: variantA is untouched by the rejected attempt.
    const check = await request(app.getHttpServer())
      .get(`/api/v1/variants?search=SKU-A`)
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(check.body.data.map((v: { id: string }) => v.id)).toEqual([variantA]);
  });
});
