import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DatabaseService } from '../../../infrastructure/database/database';
import {
  businesses,
  idempotencyKeys,
  returnItems,
  returns,
  saleItems,
  sales,
  stock,
  stockMovements,
} from '../../../infrastructure/database/schema';
import { Money } from '../../../common/domain';
import { hashRequestPayload } from '../../../common/idempotency/idempotency.util';
import { Tenant } from '../../auth/tenant.type';
import { Return, SaleItemReturnableInfo } from '../domain/return';
import { CreateReturnDto } from '../dto/create-return.dto';

const ENDPOINT = 'returns.create';

export interface CreateReturnResult {
  body: unknown;
  replayed: boolean;
}

@Injectable()
export class CreateReturnUseCase {
  constructor(private readonly db: DatabaseService) {}

  async execute(tenant: Tenant, dto: CreateReturnDto, idempotencyKey: string | undefined): Promise<CreateReturnResult> {
    const requestHash = hashRequestPayload(dto);

    return this.db.db.transaction(async (tx) => {
      if (idempotencyKey) {
        const [existing] = await tx
          .select()
          .from(idempotencyKeys)
          .where(
            and(
              eq(idempotencyKeys.businessId, tenant.businessId),
              eq(idempotencyKeys.endpoint, ENDPOINT),
              eq(idempotencyKeys.key, idempotencyKey),
            ),
          );
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new ConflictException('Idempotency-Key was already used with a different request payload');
          }
          return { body: existing.responseBody, replayed: true };
        }
      }

      const [business] = await tx.select().from(businesses).where(eq(businesses.id, tenant.businessId));
      const currency = business?.currency ?? 'XOF';

      const [sale] = await tx.select().from(sales).where(and(eq(sales.id, dto.saleId), eq(sales.businessId, tenant.businessId)));
      if (!sale) throw new NotFoundException('Sale not found');
      if (sale.status !== 'COMPLETED') {
        throw new BadRequestException('Only a completed sale can have returns');
      }

      const saleItemIds = [...new Set(dto.items.map((i) => i.saleItemId))].sort();

      // Lock the referenced sale_items rows so two concurrent return
      // requests against the same sale item serialize, mirroring the stock
      // locking strategy used for sales. Without this, two concurrent
      // returns could both read "0 already returned" and both succeed,
      // together over-returning — the exact race the mission brief warns
      // about for stock, applied to returns.
      const lockedSaleItems = await tx
        .select()
        .from(saleItems)
        .where(and(inArray(saleItems.id, saleItemIds), eq(saleItems.saleId, sale.id)))
        .for('update');
      if (lockedSaleItems.length !== saleItemIds.length) {
        throw new BadRequestException('One or more sale items do not belong to this sale');
      }

      const previouslyReturned = await tx
        .select({ saleItemId: returnItems.saleItemId, quantity: returnItems.quantity })
        .from(returnItems)
        .innerJoin(returns, eq(returnItems.returnId, returns.id))
        .where(and(inArray(returnItems.saleItemId, saleItemIds), eq(returns.status, 'COMPLETED')));

      const alreadyReturnedByItem = new Map<string, number>();
      for (const row of previouslyReturned) {
        alreadyReturnedByItem.set(row.saleItemId, (alreadyReturnedByItem.get(row.saleItemId) ?? 0) + row.quantity);
      }

      const returnable = new Map<string, SaleItemReturnableInfo>(
        lockedSaleItems.map((row) => [
          row.id,
          {
            saleItemId: row.id,
            variantId: row.variantId,
            unitPrice: Money.fromDecimal(row.unitPrice, currency),
            soldQuantity: row.quantity,
            alreadyReturnedQuantity: alreadyReturnedByItem.get(row.id) ?? 0,
          },
        ]),
      );

      const returnId = randomUUID();
      const returnEntity = Return.create(
        returnId,
        tenant.businessId,
        sale.id,
        dto.items.map((i) => ({ saleItemId: i.saleItemId, quantity: i.quantity, condition: i.condition ?? 'RESTOCK' })),
        returnable,
        dto.reason,
      );
      const total = returnEntity.total(currency);

      const [returnRow] = await tx
        .insert(returns)
        .values({ id: returnId, businessId: tenant.businessId, saleId: sale.id, status: 'COMPLETED', total: total.toDecimalString(), reason: dto.reason })
        .returning();

      const itemRows = [];
      for (const item of returnEntity.items) {
        const [row] = await tx
          .insert(returnItems)
          .values({
            returnId,
            saleItemId: item.saleItemId,
            variantId: item.variantId,
            quantity: item.quantity.value,
            unitPrice: item.unitPrice.toDecimalString(),
            condition: item.condition,
          })
          .returning();
        itemRows.push(row);

        if (item.condition === 'RESTOCK') {
          await tx
            .insert(stock)
            .values({ variantId: item.variantId, businessId: tenant.businessId, quantity: item.quantity.value })
            .onConflictDoUpdate({
              target: stock.variantId,
              set: { quantity: sql`${stock.quantity} + ${item.quantity.value}`, updatedAt: new Date() },
            });
        }

        // Movement quantity always reflects the actual physical count for
        // the audit trail. A DAMAGE movement is informational only — it
        // does NOT get added back into `stock.quantity` above — the
        // distinction is carried by `type`, not by zeroing the quantity.
        await tx.insert(stockMovements).values({
          businessId: tenant.businessId,
          variantId: item.variantId,
          type: item.condition === 'RESTOCK' ? 'RETURN' : 'DAMAGE',
          quantity: item.quantity.value,
          referenceId: returnId,
          note: item.condition === 'DAMAGED' ? 'Returned as damaged — excluded from sellable stock' : undefined,
        });
      }

      const responseBody = { ...returnRow, items: itemRows };

      if (idempotencyKey) {
        await tx.insert(idempotencyKeys).values({
          businessId: tenant.businessId,
          endpoint: ENDPOINT,
          key: idempotencyKey,
          requestHash,
          responseStatus: 201,
          responseBody,
        });
      }

      return { body: responseBody, replayed: false };
    });
  }
}
