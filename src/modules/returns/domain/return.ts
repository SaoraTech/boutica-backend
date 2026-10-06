import { DomainError, Money, Quantity } from '../../../common/domain';

export type ReturnItemCondition = 'RESTOCK' | 'DAMAGED';

export type ReturnItem = {
  saleItemId: string;
  variantId: string;
  quantity: Quantity;
  unitPrice: Money;
  condition: ReturnItemCondition;
};

/** What the use-case must supply, per referenced sale item, for the domain
 * to be able to enforce "returnedQuantity > soldQuantity" is impossible. */
export interface SaleItemReturnableInfo {
  saleItemId: string;
  variantId: string;
  unitPrice: Money;
  soldQuantity: number;
  alreadyReturnedQuantity: number;
}

export interface RequestedReturnItem {
  saleItemId: string;
  quantity: number;
  condition: ReturnItemCondition;
}

export class Return {
  private constructor(
    readonly id: string,
    readonly businessId: string,
    readonly saleId: string,
    private _items: ReturnItem[],
    readonly reason: string | null,
  ) {
    if (_items.length === 0) throw new DomainError('Return must contain at least one item');
  }

  /**
   * The core business rule from the mission brief: a return can never push
   * the cumulative returned quantity for a sale item past what was
   * actually sold. `returnable` carries soldQuantity and
   * alreadyReturnedQuantity per sale item, computed by the use-case under a
   * row lock so this check is race-free (see AUDIT_REPORT.md P0-3).
   *
   * ROUND 2 FIX: this used to check each requested line against
   * `soldQuantity - alreadyReturnedQuantity` independently. A single
   * request with two lines against the *same* saleItemId — a legitimate
   * case, e.g. 2 units RESTOCK + 1 unit DAMAGED from one sale line — could
   * each individually look fine while together over-returning, because
   * neither line's check accounted for the other line in the same request.
   * A running `consumedInThisRequest` map closes that gap without
   * rejecting the (valid) multi-condition-split case the way sales now
   * rejects duplicate lines outright.
   */
  static create(
    id: string,
    businessId: string,
    saleId: string,
    requests: RequestedReturnItem[],
    returnable: Map<string, SaleItemReturnableInfo>,
    reason?: string,
  ): Return {
    if (requests.length === 0) throw new DomainError('Return must contain at least one item');

    const consumedInThisRequest = new Map<string, number>();
    const items: ReturnItem[] = requests.map((req) => {
      const info = returnable.get(req.saleItemId);
      if (!info) throw new DomainError(`Sale item ${req.saleItemId} does not belong to this sale`);

      const consumedSoFar = consumedInThisRequest.get(req.saleItemId) ?? 0;
      const remaining = info.soldQuantity - info.alreadyReturnedQuantity - consumedSoFar;
      if (req.quantity > remaining) {
        throw new DomainError(
          `Cannot return ${req.quantity} unit(s) of sale item ${req.saleItemId}: only ${remaining} unit(s) remain returnable`,
        );
      }
      consumedInThisRequest.set(req.saleItemId, consumedSoFar + req.quantity);

      return {
        saleItemId: req.saleItemId,
        variantId: info.variantId,
        quantity: Quantity.of(req.quantity),
        unitPrice: info.unitPrice,
        condition: req.condition,
      };
    });

    return new Return(id, businessId, saleId, items, reason ?? null);
  }

  get items(): ReturnItem[] {
    return [...this._items];
  }

  total(currency: string, decimals = 2): Money {
    return this._items.reduce((sum, item) => sum.add(item.unitPrice.multiply(item.quantity.value)), Money.zero(currency, decimals));
  }
}
