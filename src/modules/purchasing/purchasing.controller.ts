import { Body, Controller, Get, Headers, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, count, desc, eq, gte, lte } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { purchaseItems, purchases } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { ReceivePurchaseDto } from './dto/receive-purchase.dto';
import { ListPurchasesQueryDto } from './dto/list-purchases-query.dto';
import { ReceivePurchaseUseCase } from './application/receive-purchase.usecase';

@ApiTags('purchasing')
@Controller('api/v1/purchases')
export class PurchasingController {
  constructor(
    private readonly receivePurchase: ReceivePurchaseUseCase,
    private readonly db: DatabaseService,
  ) {}

  @Post('receive')
  @HttpCode(HttpStatus.CREATED)
  async receive(@CurrentTenant() tenant: Tenant, @Body() body: ReceivePurchaseDto, @Headers('idempotency-key') idempotencyKey?: string) {
    const { body: purchase } = await this.receivePurchase.execute(tenant, body, idempotencyKey);
    return purchase;
  }

  // NEW (v2.1, client-integration audit P0 §6) — same reasoning as
  // sales.controller.ts's list()/get(): thin, read-only, no invariant to
  // protect, so no use-case layer added for this.
  @Get()
  async list(@CurrentTenant() tenant: Tenant, @Query() query: ListPurchasesQueryDto) {
    const filters = [eq(purchases.businessId, tenant.businessId)];
    if (query.from) filters.push(gte(purchases.createdAt, new Date(query.from)));
    if (query.to) filters.push(lte(purchases.createdAt, new Date(query.to)));
    if (query.supplierId) filters.push(eq(purchases.supplierId, query.supplierId));

    const [data, countResult] = await Promise.all([
      this.db.db
        .select()
        .from(purchases)
        .where(and(...filters))
        .orderBy(desc(purchases.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      this.db.db.select({ value: count() }).from(purchases).where(and(...filters)),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  @Get(':id')
  async get(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const [purchase] = await this.db.db
      .select()
      .from(purchases)
      .where(and(eq(purchases.id, id), eq(purchases.businessId, tenant.businessId)));
    if (!purchase) throw new NotFoundException('Purchase not found');

    const items = await this.db.db.select().from(purchaseItems).where(eq(purchaseItems.purchaseId, id));
    return { ...purchase, items };
  }
}
