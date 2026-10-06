import { DomainError, Money, Quantity } from '../../../common/domain';

export type PurchaseStatus = 'DRAFT' | 'RECEIVED' | 'CANCELLED';
export type PurchaseItem = { variantId: string; quantity: Quantity; unitPrice: Money };

export class Purchase {
  private constructor(
    readonly id: string,
    readonly businessId: string,
    readonly supplierId: string | null,
    private _items: PurchaseItem[],
    private _status: PurchaseStatus = 'DRAFT',
  ) {
    if (!_items.length) throw new DomainError('Purchase must contain at least one item');
  }

  static create(id: string, businessId: string, supplierId: string | null, items: PurchaseItem[]): Purchase {
    return new Purchase(id, businessId, supplierId, items);
  }

  get items(): PurchaseItem[] {
    return [...this._items];
  }
  get status(): PurchaseStatus {
    return this._status;
  }

  total(currency: string, decimals = 2): Money {
    return this._items.reduce((sum, item) => sum.add(item.unitPrice.multiply(item.quantity.value)), Money.zero(currency, decimals));
  }

  receive(): void {
    if (this._status !== 'DRAFT') throw new DomainError('Only a draft purchase can be received');
    this._status = 'RECEIVED';
  }

  cancel(): void {
    if (this._status === 'RECEIVED') throw new DomainError('A received purchase cannot be cancelled directly');
    this._status = 'CANCELLED';
  }
}
