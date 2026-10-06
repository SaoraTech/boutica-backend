import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, registerBusiness, resetDatabase } from '../utils/test-app';
import { DatabaseService } from '../../src/infrastructure/database/database';

describe('Suppliers (e2e)', () => {
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

  it('creates and lists suppliers scoped to the caller\'s business', async () => {
    const { accessToken } = await registerBusiness(app);

    const created = await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Quincaillerie du Nord', phone: '+22370000000' })
      .expect(201);
    expect(created.body).toMatchObject({ name: 'Quincaillerie du Nord', phone: '+22370000000' });

    const list = await request(app.getHttpServer())
      .get('/api/v1/suppliers')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.total).toBe(1);
  });

  it('rejects an empty name', async () => {
    const { accessToken } = await registerBusiness(app);
    await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: '' })
      .expect(400);
  });

  it('keeps suppliers isolated between businesses', async () => {
    const a = await registerBusiness(app, 'Shop A');
    const b = await registerBusiness(app, 'Shop B');
    await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ name: 'Supplier A' })
      .expect(201);

    const bList = await request(app.getHttpServer())
      .get('/api/v1/suppliers')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(bList.body.data).toHaveLength(0);
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer()).get('/api/v1/suppliers').expect(401);
    await request(app.getHttpServer()).post('/api/v1/suppliers').send({ name: 'X' }).expect(401);
  });
});
