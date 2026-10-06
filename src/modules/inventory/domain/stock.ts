import { DomainError, Quantity } from '../../../common/domain';

export class Stock {
  constructor(
    readonly variantId: string,
    private _quantity = 0,
  ) {
    if (_quantity < 0 || !Number.isInteger(_quantity)) {
      throw new DomainError('Invalid stock quantity');
    }
  }

  get quantity(): number {
    return this._quantity;
  }

  increase(q: Quantity): void {
    this._quantity += q.value;
  }

  decrease(q: Quantity): void {
    if (q.value > this._quantity) throw new DomainError('Insufficient stock');
    this._quantity -= q.value;
  }

  set(q: number): void {
    if (!Number.isInteger(q) || q < 0) throw new DomainError('Invalid stock quantity');
    this._quantity = q;
  }
}
