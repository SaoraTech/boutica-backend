import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { count, desc, eq } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { businesses, expenses } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { Money } from '../../common/domain';
import { PaginationQueryDto } from '../../common/pagination.dto';
import { Expense } from './domain/expense';
import { CreateExpenseDto } from './dto/create-expense.dto';

@ApiTags('expenses')
@Controller('api/v1/expenses')
export class ExpensesController {
  constructor(private readonly db: DatabaseService) {}

  // ROUND 2 FIX: this module had a POST but no way to ever list what had
  // been recorded — the brief is explicit that expenses need to be
  // manageable (section 6), and a write-only ledger isn't. Mirrors the
  // same pagination pattern already used by catalog/customers.
  @Get()
  async list(@CurrentTenant() tenant: Tenant, @Query() query: PaginationQueryDto) {
    const filter = eq(expenses.businessId, tenant.businessId);
    const [data, countResult] = await Promise.all([
      this.db.db.select().from(expenses).where(filter).orderBy(desc(expenses.createdAt)).limit(query.limit).offset(query.offset),
      this.db.db.select({ value: count() }).from(expenses).where(filter),
    ]);
    const total = countResult[0]?.value ?? 0;
    return { data, page: query.page, pageSize: query.pageSize, total };
  }

  @Post()
  async create(@CurrentTenant() tenant: Tenant, @Body() body: CreateExpenseDto) {
    // ROUND 2 FIX: same currency-consistency fix as catalog.controller.ts —
    // Money used to silently default to XOF instead of the business's
    // configured currency.
    const [business] = await this.db.db.select({ currency: businesses.currency }).from(businesses).where(eq(businesses.id, tenant.businessId));
    const amount = Money.fromDecimal(body.amount, business?.currency ?? 'XOF');
    const expense = Expense.create(randomUUID(), tenant.businessId, body.category, amount, body.description);

    const [row] = await this.db.db
      .insert(expenses)
      .values({
        businessId: expense.businessId,
        category: expense.category,
        amount: expense.amount.toDecimalString(),
        description: expense.description,
      })
      .returning();
    return row;
  }
}
