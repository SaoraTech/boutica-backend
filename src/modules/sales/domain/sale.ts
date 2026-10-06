import { DomainError, Money, Quantity } from '../../../common/domain';

export type SaleStatus = 'DRAFT' | 'COMPLETED' | 'CANCELLED';
export type SaleItem = { variantId: string; quantity: Quantity; unitPrice: Money };

export class Sale {
  private constructor(
    readonly id: string,
    readonly businessId: string,
    private _items: SaleItem[],
    private _discount: Money,
    private _status: SaleStatus = 'DRAFT',
    readonly customerId: string | null = null,
  ) {
    if (_items.length === 0) throw new DomainError('Sale must contain at least one item');
  }

  static create(id: string, businessId: string, items: SaleItem[], discount: Money, customerId: string | null = null): Sale {
    return new Sale(id, businessId, items, discount, 'DRAFT', customerId);
  }

  get items(): SaleItem[] {
    return [...this._items];
  }
  get status(): SaleStatus {
    return this._status;
  }
  get discount(): Money {
    return this._discount;
  }

  subtotal(currency: string, decimals = 2): Money {
    return this._items.reduce((sum, item) => sum.add(item.unitPrice.multiply(item.quantity.value)), Money.zero(currency, decimals));
  }

  total(currency: string, decimals = 2): Money {
    const sub = this.subtotal(currency, decimals);
    if (this._discount.isGreaterThan(sub)) throw new DomainError('Discount cannot exceed subtotal');
    return sub.subtract(this._discount);
  }

  complete(): void {
    if (this._status !== 'DRAFT') throw new DomainError('Only draft sales can be completed');
    this._status = 'COMPLETED';
  }

  cancel(): void {
    if (this._status === 'COMPLETED') throw new DomainError('Completed sale cannot be cancelled directly');
    this._status = 'CANCELLED';
  }
}
