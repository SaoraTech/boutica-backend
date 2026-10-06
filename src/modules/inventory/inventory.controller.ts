import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../../infrastructure/database/database';
import { stock, stockMovements, variants } from '../../infrastructure/database/schema';
import { CurrentTenant } from '../auth/current-tenant.decorator';
import { Tenant } from '../auth/tenant.type';
import { AdjustStockDto } from './dto/adjust-stock.dto';

@ApiTags('inventory')
@Controller('api/v1/inventory')
export class InventoryController {
  constructor(private readonly db: DatabaseService) {}

  @Get(':variantId')
  async get(@CurrentTenant() tenant: Tenant, @Param('variantId', ParseUUIDPipe) variantId: string) {
    // FIX (P0-1): the previous implementation looked up stock by variantId
    // alone, with no ownership check at all — any authenticated caller
    // could read (and, on the old adjust endpoint, overwrite) another
    // business's stock just by guessing/enumerating a variant UUID.
    const [variant] = await this.db.db
      .select({ id: variants.id })
      .from(variants)
      .where(and(eq(variants.id, variantId), eq(variants.businessId, tenant.businessId)));
    if (!variant) throw new NotFoundException('Variant not found');

    const [row] = await this.db.db.select().from(stock).where(eq(stock.variantId, variantId));
    return row ?? { variantId, businessId: tenant.businessId, quantity: 0 };
  }

  @Post(':variantId/adjust')
  async adjust(@CurrentTenant() tenant: Tenant, @Param('variantId', ParseUUIDPipe) variantId: string, @Body() body: AdjustStockDto) {
    return this.db.db.transaction(async (tx) => {
      const [variant] = await tx
        .select({ id: variants.id })
        .from(variants)
        .where(and(eq(variants.id, variantId), eq(variants.businessId, tenant.businessId)));
      if (!variant) throw new NotFoundException('Variant not found');

      const [current] = await tx
        .select()
        .from(stock)
        .where(eq(stock.variantId, variantId))
        .for('update');
      const previousQuantity = current?.quantity ?? 0;
      const delta = body.quantity - previousQuantity;

      const [updated] = await tx
        .insert(stock)
        .values({ variantId, businessId: tenant.businessId, quantity: body.quantity })
        .onConflictDoUpdate({ target: stock.variantId, set: { quantity: body.quantity, updatedAt: new Date() } })
        .returning();

      // FIX (P2-2): manual adjustments used to bypass stock_movements
      // entirely, silently breaking the audit trail the table exists for.
      if (delta !== 0) {
        await tx.insert(stockMovements).values({
          businessId: tenant.businessId,
          variantId,
          type: 'ADJUSTMENT',
          quantity: delta,
          note: body.note,
        });
      }

      return updated;
    });
  }
}
