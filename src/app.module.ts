import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { envSchema } from './config/env.schema';
import { DatabaseModule } from './infrastructure/database/database.module';
import { DomainExceptionFilter } from './common/errors/domain-exception.filter';
import { auth } from './auth/auth';
import { CatalogModule } from './modules/catalog/catalog.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { SalesModule } from './modules/sales/sales.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { ReturnsModule } from './modules/returns/returns.module';
import { SuppliersModule } from './modules/suppliers/suppliers.module';
import { ExpensesModule } from './modules/expenses/expenses.module';
import { CustomersModule } from './modules/customers/customers.module';
import { ReportsModule } from './modules/reports/reports.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    // ROUND 2 FIX: validates every env var the app reads (DATABASE_URL,
    // BETTER_AUTH_SECRET, PORT, CORS_ORIGIN, NODE_ENV) once at bootstrap
    // instead of failing later/silently — see src/config/env.schema.ts.
    ConfigModule.forRoot({ isGlobal: true, validationSchema: envSchema }),
    // Basic rate limiting (AUDIT_REPORT.md P1-2: "absence de rate
    // limiting"), applied to every route by default. This is independent
    // of Better Auth's OWN, tighter, built-in rate limiting on its
    // sign-in/sign-up endpoints specifically (see src/auth/auth.ts) — the
    // two aren't competing, they cover different scopes.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    DatabaseModule,
    // v2.0 — replaces the old hand-rolled AuthModule (register/login
    // controllers, JwtAuthGuard). Registers its OWN global guard
    // automatically: every route is protected by default, the same as
    // before, opted out per-route with @AllowAnonymous() (was @Public())
    // — see health.controller.ts. See AUDIT_REPORT.md section H.
    AuthModule.forRoot({ auth }),
    CatalogModule,
    InventoryModule,
    SalesModule,
    PurchasingModule,
    ReturnsModule,
    // NEW (v2.1) — the suppliers table existed with no API; also closes
    // the supplierId cross-tenant reference gap in receive-purchase.usecase.ts.
    SuppliersModule,
    ExpensesModule,
    CustomersModule,
    // NEW — dashboard/reports were entirely absent despite being an
    // explicit brief requirement. See reports.controller.ts.
    ReportsModule,
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
  ],
})
export class AppModule {}
