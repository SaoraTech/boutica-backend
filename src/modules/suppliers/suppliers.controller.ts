import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, count, eq } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { suppliers } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { PaginationQueryDto } from '../../common/pagination.dto';
import { CreateSupplierDto } from './dto/create-supplier.dto';

/**
 * NEW (v2.1) — the `suppliers` table existed in the schema and was already
 * referenced by `purchases.supplierId`, but no controller ever exposed it
 * (client-integration audit §11). Mirrors CustomersController exactly:
 * list + create only, no invariant beyond tenant scoping to protect.
 *
 * The other half of this fix is in receive-purchase.usecase.ts, which
 * previously accepted ANY supplierId with no ownership check at all — a
 * caller could reference another business's supplier row. That's fixed
 * there, not here; this controller existing is what makes a *legitimate*
 * supplierId reachable for a client in the first place.
 */
@ApiTags('suppliers')
@Controller('api/v1/suppliers')
export class SuppliersController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async list(@CurrentTenant() tenant: Tenant, @Query() query: PaginationQueryDto) {
    const filter = eq(suppliers.businessId, tenant.businessId);
    const [data, countResult] = await Promise.all([
      this.db.db.select().from(suppliers).where(filter).limit(query.limit).offset(query.offset),
      this.db.db.select({ value: count() }).from(suppliers).where(filter),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  @Post()
  async create(@CurrentTenant() tenant: Tenant, @Body() body: CreateSupplierDto) {
    const [supplier] = await this.db.db
      .insert(suppliers)
      .values({ businessId: tenant.businessId, name: body.name.trim(), phone: body.phone })
      .returning();
    return supplier;
  }
}
