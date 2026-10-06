import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, registerBusiness, resetDatabase } from '../utils/test-app';
import { DatabaseService } from '../../src/infrastructure/database/database';

describe('Auth (e2e)', () => {
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

  it('signs up, creating a business and an OWNER user, and returns a usable bearer token', async () => {
    const { accessToken, businessId } = await registerBusiness(app, 'New Shop');
    expect(accessToken).toBeTruthy();
    expect(businessId).toBeTruthy();

    // The token must actually work against a protected route.
    await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });

  it('rejects sign-up with an email that is already registered', async () => {
    const email = `dup-${Date.now()}@example.test`;
    await request(app.getHttpServer())
      .post('/api/auth/sign-up/email')
      .send({ name: 'Owner One', email, password: 'a-very-long-password-123', businessName: 'Shop One' })
      .expect((res) => {
        if (res.status >= 400) throw new Error(`first sign-up unexpectedly failed: ${JSON.stringify(res.body)}`);
      });

    const res = await request(app.getHttpServer())
      .post('/api/auth/sign-up/email')
      .send({ name: 'Owner Two', email, password: 'a-different-password-456', businessName: 'Shop Two' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.code).toBe('USER_ALREADY_EXISTS');
  });

  it('signs in with correct credentials and rejects incorrect ones', async () => {
    const email = `signin-${Date.now()}@example.test`;
    const password = 'a-very-long-password-123';
    await request(app.getHttpServer())
      .post('/api/auth/sign-up/email')
      .send({ name: 'Owner', email, password, businessName: 'Sign-in Shop' });

    const good = await request(app.getHttpServer()).post('/api/auth/sign-in/email').send({ email, password });
    expect(good.body.token).toBeTruthy();

    const bad = await request(app.getHttpServer())
      .post('/api/auth/sign-in/email')
      .send({ email, password: 'the-wrong-password' });
    expect(bad.status).toBeGreaterThanOrEqual(400);
  });

  it('rejects a protected route with no token, and allows /health with none', async () => {
    await request(app.getHttpServer()).get('/api/v1/products').expect(401);
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  // Regression test for the multi-tenant sign-up hook (src/auth/auth.ts):
  // every sign-up must create its OWN business, never reuse or leak into
  // another one, even when two sign-ups happen close together.
  it('gives two separate sign-ups two separate, isolated businesses', async () => {
    const a = await registerBusiness(app, 'Shop A');
    const b = await registerBusiness(app, 'Shop B');
    expect(a.businessId).not.toBe(b.businessId);

    await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({ name: 'A-only product' })
      .expect(201);

    const bProducts = await request(app.getHttpServer())
      .get('/api/v1/products')
      .set('Authorization', `Bearer ${b.accessToken}`)
      .expect(200);
    expect(bProducts.body.data).toHaveLength(0);
  });

  // NEW (v2.1, client-integration audit P1 §8 — trustedOrigins).
  //
  // Better Auth's own origin/CSRF check only runs for requests that carry a
  // `Cookie` header at all (see validateOrigin in Better Auth's source) —
  // which is exactly the browser/Next.js case this exists for, and why
  // every bearer-token test elsewhere in this suite never exercises this
  // path: Kotlin/RN/Expo/Electron send no cookies, so this check is a
  // no-op for them, matching README.md's description of the mechanism.
  // A dummy Cookie header is enough to reach the check itself — it does
  // not need to be a real session.
  describe('trustedOrigins (cookie-based requests only)', () => {
    it('rejects a cookie-bearing request from an origin not in CORS_ORIGIN', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .set('Cookie', 'dummy=1')
        .set('Origin', 'https://not-trusted.example.test')
        .send({ email: 'nobody@example.test', password: 'irrelevant-but-long-enough' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INVALID_ORIGIN');
    });

    it('does not reject a cookie-bearing request from a CORS_ORIGIN-listed origin', async () => {
      const trustedOrigin = process.env.CORS_ORIGIN?.split(',')[0]?.trim() ?? 'http://localhost:5173';

      const res = await request(app.getHttpServer())
        .post('/api/auth/sign-in/email')
        .set('Cookie', 'dummy=1')
        .set('Origin', trustedOrigin)
        .send({ email: 'nobody@example.test', password: 'irrelevant-but-long-enough' });

      // Not asserting 200 — these credentials don't exist, so this fails
      // for an unrelated reason (invalid credentials). What matters here
      // is specifically that it does NOT fail with the origin-check's own
      // 403/INVALID_ORIGIN — proving the origin, not the request itself,
      // was the only thing rejected in the test above.
      expect(res.body.code).not.toBe('INVALID_ORIGIN');
    });
  });
});
