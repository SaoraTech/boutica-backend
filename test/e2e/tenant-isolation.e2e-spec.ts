import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createProductWithVariant, createTestApp, registerBusiness, resetDatabase } from '../utils/test-app';
import { DatabaseService } from '../../src/infrastructure/database/database';

describe('Tenant isolation (e2e)', () => {
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

  it('rejects every request without a bearer token', async () => {
    await request(app.getHttpServer()).get('/api/v1/products').expect(401);
    await request(app.getHttpServer()).get('/api/v1/customers').expect(401);
  });

  it('rejects a garbage bearer token', async () => {
    await request(app.getHttpServer()).get('/api/v1/products').set('Authorization', 'Bearer not-a-real-token').expect(401);
  });

  it('business B cannot read business A products (GET Business B products)', async () => {
    const a = await registerBusiness(app, 'Shop A');
    const b = await registerBusiness(app, 'Shop B');
    const { productId } = await createProductWithVariant(app, a.accessToken);

    await request(app.getHttpServer())
      .get(`/api/v1/products/${productId}`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(404);

    const list = await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(list.body.data).toHaveLength(0);
  });

  it('business B cannot sell business A stock (UPDATE Business B stock)', async () => {
    const a = await registerBusiness(app, 'Shop A');
    const b = await registerBusiness(app, 'Shop B');
    const { variantId } = await createProductWithVariant(app, a.accessToken);

    await request(app.getHttpServer())
      .post(`/api/v1/inventory/${variantId}/adjust`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({ quantity: 999 })
      .expect(404);

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({ items: [{ variantId, quantity: 1 }] })
      .expect(400);
  });

  it("business B's sales list never includes business A's sales (v2.1: sales list/detail now exist)", async () => {
    const a = await registerBusiness(app, 'Shop A');
    const b = await registerBusiness(app, 'Shop B');
    const { variantId } = await createProductWithVariant(app, a.accessToken, { sellingPrice: 10 });

    await request(app.getHttpServer())
      .post(`/api/v1/inventory/${variantId}/adjust`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ quantity: 10 })
      .expect(201);

    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ items: [{ variantId, quantity: 1 }] })
      .expect(201);

    // B's own list must be empty, and B must not be able to fetch A's sale
    // by id even knowing its UUID directly.
    const bSales = await request(app.getHttpServer())
      .get('/api/v1/sales')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(bSales.body.data).toHaveLength(0);

    await request(app.getHttpServer())
      .get(`/api/v1/sales/${sale.body.id}`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(404);

    // A can see its own sale.
    const aSale = await request(app.getHttpServer())
      .get(`/api/v1/sales/${sale.body.id}`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .expect(200);
    expect(aSale.body.items).toHaveLength(1);

    const custRes = await request(app.getHttpServer())
      .get('/api/v1/customers')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(custRes.body.data).toHaveLength(0);
  });

  // v2.1 regression tests — multi-tenant re-audit (client-integration
  // finalization, §14) for every endpoint added this round.
  it('business B cannot list or fetch business A variants', async () => {
    const a = await registerBusiness(app, 'Shop A');
    const b = await registerBusiness(app, 'Shop B');
    const { productId, variantId } = await createProductWithVariant(app, a.accessToken);

    await request(app.getHttpServer())
      .get(`/api/v1/products/${productId}/variants`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(404); // product itself isn't B's

    const bVariants = await request(app.getHttpServer())
      .get('/api/v1/variants')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(bVariants.body.data).toHaveLength(0);

    await request(app.getHttpServer())
      .patch(`/api/v1/products/${productId}/variants/${variantId}`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({ name: 'Hijacked' })
      .expect(404);
  });

  it('business B cannot list/fetch business A purchases or returns, and cannot reference A\'s supplier', async () => {
    const a = await registerBusiness(app, 'Shop A');
    const b = await registerBusiness(app, 'Shop B');
    const { variantId } = await createProductWithVariant(app, a.accessToken, { sellingPrice: 10, purchasePrice: 5 });

    const supplierA = await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ name: 'Supplier A' })
      .expect(201);

    const purchase = await request(app.getHttpServer())
      .post('/api/v1/purchases/receive')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ supplierId: supplierA.body.id, items: [{ variantId, quantity: 5, unitPrice: 5 }] })
      .expect(201);

    const bPurchases = await request(app.getHttpServer())
      .get('/api/v1/purchases')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(bPurchases.body.data).toHaveLength(0);

    await request(app.getHttpServer())
      .get(`/api/v1/purchases/${purchase.body.id}`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(404);

    // B cannot list A's suppliers, and — the actual security fix — cannot
    // use A's supplierId in its OWN purchase either.
    const bSuppliers = await request(app.getHttpServer())
      .get('/api/v1/suppliers')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(bSuppliers.body.data).toHaveLength(0);

    const { variantId: bVariantId } = await createProductWithVariant(app, b.accessToken, { sellingPrice: 10, purchasePrice: 5 });
    await request(app.getHttpServer())
      .post('/api/v1/purchases/receive')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({ supplierId: supplierA.body.id, items: [{ variantId: bVariantId, quantity: 1, unitPrice: 5 }] })
      .expect(400);

    // Returns: B cannot list/fetch A's returns either.
    await request(app.getHttpServer())
      .post(`/api/v1/inventory/${variantId}/adjust`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ quantity: 10 })
      .expect(201);
    const sale = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ items: [{ variantId, quantity: 2 }] })
      .expect(201);
    const ret = await request(app.getHttpServer())
      .post('/api/v1/returns')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ saleId: sale.body.id, items: [{ saleItemId: sale.body.items[0].id, quantity: 1, condition: 'RESTOCK' }] })
      .expect(201);

    const bReturns = await request(app.getHttpServer())
      .get('/api/v1/returns')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(bReturns.body.data).toHaveLength(0);
    await request(app.getHttpServer())
      .get(`/api/v1/returns/${ret.body.id}`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(404);
  });

  it('SKUs can be reused across different businesses (P1-1 regression test)', async () => {
    const a = await registerBusiness(app, 'Shop A');
    const b = await registerBusiness(app, 'Shop B');

    const productA = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ name: 'Widget A' })
      .expect(201);
    const productB = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({ name: 'Widget B' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/api/v1/products/${productA.body.id}/variants`)
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ sku: 'SKU-001', name: 'Default', purchasePrice: 1, sellingPrice: 2 })
      .expect(201);

    // Same SKU, different business: must NOT collide.
    await request(app.getHttpServer())
      .post(`/api/v1/products/${productB.body.id}/variants`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .send({ sku: 'SKU-001', name: 'Default', purchasePrice: 1, sellingPrice: 2 })
      .expect(201);
  });

  it('business B cannot fetch a customer belonging to business A (v2.1: GET /customers/:id)', async () => {
    const a = await registerBusiness(app, 'Shop A');
    const b = await registerBusiness(app, 'Shop B');
    const customer = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ name: 'Customer A' })
      .expect(201);

    await request(app.getHttpServer())
      .get(`/api/v1/customers/${customer.body.id}`)
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(404);
  });
});
