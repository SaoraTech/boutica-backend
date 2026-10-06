import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { expenses, products, saleItems, sales, stock, variants } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { DashboardQueryDto } from './dto/dashboard-query.dto';

/**
 * NEW — the mission brief (section 6, "Dashboard et rapports") explicitly
 * asks for revenue, expenses, estimated profit, stock value, receivables,
 * recent sales, best-selling products, and low-stock alerts. None of this
 * existed anywhere in the codebase and it wasn't flagged in AUDIT_REPORT.md
 * either — round 1 scoped itself to hardening what already existed, and
 * this had never been built at all. Added here as a single read-only
 * endpoint, deliberately thin (same "controller talks to the DB directly"
 * pattern already used by catalog/customers — see AUDIT_REPORT.md P2-1):
 * there's no write path and no invariant to protect, just aggregation
 * queries, so a use-case/repository layer would add indirection without
 * adding safety.
 */
@ApiTags('reports')
@Controller('api/v1/reports')
export class ReportsController {
  constructor(private readonly db: DatabaseService) {}

  @Get('dashboard')
  async dashboard(@CurrentTenant() tenant: Tenant, @Query() query: DashboardQueryDto) {
    const now = new Date();
    const from = query.from ? new Date(query.from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const to = query.to ? new Date(query.to) : now;
    const businessId = tenant.businessId;

    const completedSalesInRange = and(
      eq(sales.businessId, businessId),
      eq(sales.status, 'COMPLETED'),
      gte(sales.createdAt, from),
      lte(sales.createdAt, to),
    );

    const [
      revenueRows,
      expensesRows,
      grossMarginRows,
      stockValueRows,
      recentSales,
      topProducts,
      lowStock,
    ] = await Promise.all([
      // Chiffre d'affaires — sum of completed sale totals in the window.
      this.db.db
        .select({ revenue: sql<string>`coalesce(sum(${sales.total}), 0)` })
        .from(sales)
        .where(completedSalesInRange),

      // Dépenses — sum of recorded expenses in the same window.
      this.db.db
        .select({ expensesTotal: sql<string>`coalesce(sum(${expenses.amount}), 0)` })
        .from(expenses)
        .where(and(eq(expenses.businessId, businessId), gte(expenses.createdAt, from), lte(expenses.createdAt, to))),

      // Bénéfice estimé — gross margin (unitPrice - cost) * quantity across
      // sold line items, before subtracting operating expenses below.
      // FIX (v2.0): reads sale_items.costAtSale — the purchase price
      // captured at the moment of THAT sale — instead of the variant's
      // CURRENT purchase price, so a cost change today no longer changes
      // the reported margin on old sales (AUDIT_REPORT.md round 2, R2-5).
      // costAtSale is only NULL on sales recorded before this column
      // existed; those fall back to the variant's current cost, which
      // matches this query's old (imprecise) behavior exactly — so past
      // reports don't change retroactively, only sales from here on get
      // the accurate figure.
      this.db.db
        .select({
          grossMargin: sql<string>`coalesce(sum((${saleItems.unitPrice} - coalesce(${saleItems.costAtSale}, ${variants.purchasePrice})) * ${saleItems.quantity}), 0)`,
        })
        .from(saleItems)
        .innerJoin(sales, eq(saleItems.saleId, sales.id))
        .innerJoin(variants, eq(saleItems.variantId, variants.id))
        .where(completedSalesInRange),

      // Valeur du stock — current stock valued at cost (purchasePrice),
      // not selling price, per standard inventory-valuation convention.
      this.db.db
        .select({ stockValue: sql<string>`coalesce(sum(${stock.quantity} * ${variants.purchasePrice}), 0)` })
        .from(stock)
        .innerJoin(variants, eq(stock.variantId, variants.id))
        .where(eq(stock.businessId, businessId)),

      // Ventes récentes — most recent completed sales, independent of the
      // from/to window (this is "what just happened", not a range report).
      this.db.db
        .select({ id: sales.id, total: sales.total, customerId: sales.customerId, createdAt: sales.createdAt })
        .from(sales)
        .where(and(eq(sales.businessId, businessId), eq(sales.status, 'COMPLETED')))
        .orderBy(desc(sales.createdAt))
        .limit(10),

      // Produits les plus vendus — by units sold within the window.
      this.db.db
        .select({
          variantId: variants.id,
          productName: products.name,
          variantName: variants.name,
          sku: variants.sku,
          quantitySold: sql<number>`sum(${saleItems.quantity})`.mapWith(Number),
        })
        .from(saleItems)
        .innerJoin(sales, eq(saleItems.saleId, sales.id))
        .innerJoin(variants, eq(saleItems.variantId, variants.id))
        .innerJoin(products, eq(variants.productId, products.id))
        .where(completedSalesInRange)
        .groupBy(variants.id, products.name, variants.name, variants.sku)
        .orderBy(desc(sql`sum(${saleItems.quantity})`))
        .limit(5),

      // Alertes de stock — anything at or below the threshold, lowest
      // first so the most urgent restocks surface at the top.
      this.db.db
        .select({ variantId: stock.variantId, quantity: stock.quantity, variantName: variants.name, sku: variants.sku })
        .from(stock)
        .innerJoin(variants, eq(stock.variantId, variants.id))
        .where(and(eq(stock.businessId, businessId), lte(stock.quantity, query.lowStockThreshold)))
        .orderBy(stock.quantity),
    ]);

    const revenue = revenueRows[0]?.revenue ?? '0.00';
    const expensesTotal = expensesRows[0]?.expensesTotal ?? '0.00';
    const grossMargin = grossMarginRows[0]?.grossMargin ?? '0.00';
    const stockValue = stockValueRows[0]?.stockValue ?? '0.00';

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      revenue,
      expensesTotal,
      // Bénéfice estimé = gross margin on sold goods minus operating
      // expenses for the same window. Computed in integer minor units, not
      // as JS floats — see toMinorUnits() below for why.
      estimatedProfit: ((toMinorUnits(grossMargin) - toMinorUnits(expensesTotal)) / 100).toFixed(2),
      stockValue,
      // Créances (customer credit/receivables) — not tracked anywhere in
      // the current schema (no balance-due field on customers or sales, no
      // partial-payment ledger). Returned as null rather than a fabricated
      // 0, matching AUDIT_REPORT.md's own note that credit tracking needs
      // a real ledger, not an isolated "remaining" field, if/when it's
      // built.
      receivables: null,
      recentSales,
      topProducts,
      lowStockAlerts: lowStock,
    };
  }
}

/**
 * estimatedProfit can legitimately be negative (a loss for the period),
 * which common/domain.ts's Money deliberately forbids — Money there is a
 * non-negative price/amount type, not a signed P&L figure, and widening it
 * to allow negatives would weaken that invariant for every other caller.
 * Doing this one subtraction in integer minor units instead of as JS
 * `number` keeps the same "money is integers, not floats" discipline Money
 * itself documents, without forcing Money to support a case it isn't
 * meant to.
 */
function toMinorUnits(decimal: string, decimals = 2): number {
  return Math.round(Number(decimal) * 10 ** decimals);
}
