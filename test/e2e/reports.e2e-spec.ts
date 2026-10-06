import { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { adjustStock, createProductWithVariant, createTestApp, registerBusiness, resetDatabase } from '../utils/test-app';
import { DatabaseService } from '../../src/infrastructure/database/database';
import { variants } from '../../src/infrastructure/database/schema';

describe('Reports (e2e)', () => {
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

  it('aggregates revenue, expenses, profit, stock value, top products, and low-stock alerts', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { purchasePrice: 15, sellingPrice: 25 });
    await adjustStock(app, accessToken, variantId, 20);

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity: 4 }] })
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ category: 'Rent', amount: 10 })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/v1/reports/dashboard')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.revenue).toBe('100.00'); // 4 * 25
    expect(res.body.expensesTotal).toBe('10.00');
    expect(res.body.estimatedProfit).toBe('30.00'); // (25-15)*4 - 10
    expect(res.body.stockValue).toBe('240.00'); // (20-4) remaining * 15 cost
    expect(res.body.receivables).toBeNull();
    expect(res.body.recentSales).toHaveLength(1);
    expect(res.body.topProducts).toHaveLength(1);
    expect(res.body.topProducts[0]).toMatchObject({ variantId, quantitySold: 4 });
    expect(res.body.lowStockAlerts).toEqual([]); // 16 left, default threshold is 5
  });

  it('flags a variant as low stock once it drops to or below the threshold', async () => {
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { sellingPrice: 10 });
    await adjustStock(app, accessToken, variantId, 3);

    const res = await request(app.getHttpServer())
      .get('/api/v1/reports/dashboard?lowStockThreshold=5')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.lowStockAlerts).toHaveLength(1);
    expect(res.body.lowStockAlerts[0]).toMatchObject({ variantId, quantity: 3 });
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/v1/reports/dashboard').expect(401);
  });

  it('reports a negative estimatedProfit as a loss instead of erroring (round-2 regression test)', async () => {
    // estimatedProfit is a signed figure (a period can run at a loss), which
    // Money's constructor deliberately forbids — this exercises the
    // integer-minor-units path in reports.controller.ts that computes it
    // without going through Money.
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { purchasePrice: 10, sellingPrice: 12 });
    await adjustStock(app, accessToken, variantId, 5);

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity: 1 }] }) // margin: (12-10)*1 = 2.00
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/v1/expenses')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ category: 'Rent', amount: 50 })
      .expect(201);

    const res = await request(app.getHttpServer())
      .get('/api/v1/reports/dashboard')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(res.body.estimatedProfit).toBe('-48.00'); // 2.00 margin - 50.00 expenses
  });

  it('keeps an old sale\'s margin unchanged after the variant\'s purchase price is updated later (v2.0 regression test)', async () => {
    // Directly via Drizzle, not the API: there is currently no endpoint to
    // edit a variant's price after creation (flagged in AUDIT_REPORT.md
    // section H as a gap, not fixed here) — this is the only way to
    // reproduce "cost changes after the sale" today.
    const { accessToken } = await registerBusiness(app);
    const { variantId } = await createProductWithVariant(app, accessToken, { purchasePrice: 10, sellingPrice: 25 });
    await adjustStock(app, accessToken, variantId, 10);

    await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ items: [{ variantId, quantity: 2 }] }) // margin at sale time: (25-10)*2 = 30.00
      .expect(201);

    // The purchase price triples AFTER the sale.
    await db.db.update(variants).set({ purchasePrice: '30.00' }).where(eq(variants.id, variantId));

    const res = await request(app.getHttpServer())
      .get('/api/v1/reports/dashboard')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    // Without costAtSale, this would recompute as (25-30)*2 = -10.00 using
    // the now-current (higher) cost — a swing from a real profit to a
    // fabricated loss on a sale that never changed.
    expect(res.body.estimatedProfit).toBe('30.00');
  });
});
