import { Body, Controller, Get, Headers, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, count, desc, eq, gte, lte } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { saleItems, sales } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { CreateSaleDto } from './dto/create-sale.dto';
import { ListSalesQueryDto } from './dto/list-sales-query.dto';
import { CreateSaleUseCase } from './application/create-sale.usecase';

@ApiTags('sales')
@Controller('api/v1/sales')
export class SalesController {
  constructor(
    private readonly createSale: CreateSaleUseCase,
    private readonly db: DatabaseService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentTenant() tenant: Tenant, @Body() body: CreateSaleDto, @Headers('idempotency-key') idempotencyKey?: string) {
    const { body: sale } = await this.createSale.execute(tenant, body, idempotencyKey);
    return sale;
  }

  // NEW (v2.1, client-integration audit P0 §5): sales could be created but
  // never listed or reviewed afterward — no receipt screen, no history,
  // no reconciliation was possible against the real API. Read-only, no
  // invariant to protect, so — consistent with the thin-controller
  // pattern already used for Catalog/Customers/Expenses (AUDIT_REPORT.md
  // P2-1) — this talks to DatabaseService directly rather than adding a
  // use-case for it; CreateSaleUseCase's transactional logic is untouched.
  @Get()
  async list(@CurrentTenant() tenant: Tenant, @Query() query: ListSalesQueryDto) {
    const filters = [eq(sales.businessId, tenant.businessId)];
    if (query.from) filters.push(gte(sales.createdAt, new Date(query.from)));
    if (query.to) filters.push(lte(sales.createdAt, new Date(query.to)));
    if (query.customerId) filters.push(eq(sales.customerId, query.customerId));

    const [data, countResult] = await Promise.all([
      this.db.db
        .select()
        .from(sales)
        .where(and(...filters))
        .orderBy(desc(sales.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      this.db.db.select({ value: count() }).from(sales).where(and(...filters)),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  @Get(':id')
  async get(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const [sale] = await this.db.db
      .select()
      .from(sales)
      .where(and(eq(sales.id, id), eq(sales.businessId, tenant.businessId)));
    if (!sale) throw new NotFoundException('Sale not found');

    const items = await this.db.db.select().from(saleItems).where(eq(saleItems.saleId, id));
    return { ...sale, items };
  }
}
