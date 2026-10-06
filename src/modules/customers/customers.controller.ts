import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, count, eq } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { customers } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { PaginationQueryDto } from '../../common/pagination.dto';
import { CreateCustomerDto } from './dto/create-customer.dto';

@ApiTags('customers')
@Controller('api/v1/customers')
export class CustomersController {
  constructor(private readonly db: DatabaseService) {}

  @Get()
  async list(@CurrentTenant() tenant: Tenant, @Query() query: PaginationQueryDto) {
    const filter = eq(customers.businessId, tenant.businessId);
    const [data, countResult] = await Promise.all([
      this.db.db.select().from(customers).where(filter).limit(query.limit).offset(query.offset),
      this.db.db.select({ value: count() }).from(customers).where(filter),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  // NEW (v2.1, client-integration audit P1 §9). A customer's purchase
  // history is deliberately NOT a nested endpoint here — it's
  // GET /api/v1/sales?customerId=X, the same list endpoint every other
  // sales query already goes through, rather than a second, near-duplicate
  // one (see the comment on ListSalesQueryDto.customerId).
  @Get(':id')
  async get(@CurrentTenant() tenant: Tenant, @Param('id', ParseUUIDPipe) id: string) {
    const [customer] = await this.db.db
      .select()
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.businessId, tenant.businessId)));
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  @Post()
  async create(@CurrentTenant() tenant: Tenant, @Body() body: CreateCustomerDto) {
    const [customer] = await this.db.db
      .insert(customers)
      .values({ businessId: tenant.businessId, name: body.name.trim(), phone: body.phone })
      .returning();
    return customer;
  }
}
