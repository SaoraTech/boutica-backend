import { Body, Controller, Get, Headers, HttpCode, HttpStatus, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, count, desc, eq, gte, lte } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { returnItems, returns } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { CreateReturnDto } from './dto/create-return.dto';
import { ListReturnsQueryDto } from './dto/list-returns-query.dto';
import { CreateReturnUseCase } from './application/create-return.usecase';

@ApiTags('returns')
@Controller('api/v1/returns')
export class ReturnsController {
  constructor(
    private readonly createReturn: CreateReturnUseCase,
    private readonly db: DatabaseService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentTenant() tenant: Tenant, @Body() body: CreateReturnDto, @Headers('idempotency-key') idempotencyKey?: string) {
    const { body: ret } = await this.createReturn.execute(tenant, body, idempotencyKey);
    return ret;
  }

  // NEW (v2.1, client-integration audit P0 §7) — same reasoning as
  // sales/purchases: thin, read-only, no invariant to protect.
  @Get()
  async list(@CurrentTenant() tenant: Tenant, @Query() query: ListReturnsQueryDto) {
    const filters = [eq(returns.businessId, tenant.businessId)];
    if (query.from) filters.push(gte(returns.createdAt, new Date(query.from)));
    if (query.to) filters.push(lte(returns.createdAt, new Date(query.to)));
    if (query.saleId) filters.push(eq(returns.saleId, query.saleId));

    const [data, countResult] = await Promise.all([
      this.db.db
        .select()
        .from(returns)
        .where(and(...filters))
        .orderBy(desc(returns.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      this.db.db.select({ value: count() }).from(returns).where(and(...filters)),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  @Get(':id')
  async get(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const [ret] = await this.db.db
      .select()
      .from(returns)
      .where(and(eq(returns.id, id), eq(returns.businessId, tenant.businessId)));
    if (!ret) throw new NotFoundException('Return not found');

    const items = await this.db.db.select().from(returnItems).where(eq(returnItems.returnId, id));
    return { ...ret, items };
  }
}
