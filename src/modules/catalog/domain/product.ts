import { DomainError, Money, SKU } from '../../../common/domain';

export type ProductStatus = 'ACTIVE' | 'INACTIVE';

/**
 * Pure validation object: enforces "selling price >= purchase price" and
 * "non-empty name" the same way whether called from a use-case or a thin
 * controller. The same invariant is also enforced at the DB layer via a
 * CHECK constraint (defence in depth — see schema.ts) because the current
 * write path (CatalogController) persists primitives directly rather than
 * loading/saving a full Product aggregate. See AUDIT_REPORT.md P2-1 for the
 * reasoning behind that trade-off.
 */
export class Variant {
  constructor(
    readonly id: string,
    readonly sku: SKU,
    readonly name: string,
    readonly purchasePrice: Money,
    readonly sellingPrice: Money,
    readonly attributes: Record<string, string> = {},
  ) {
    if (!name.trim()) throw new DomainError('Variant name is required');
    if (purchasePrice.isGreaterThan(sellingPrice)) {
      throw new DomainError('Selling price cannot be below purchase price');
    }
  }
}

export class Product {
  private constructor(
    public readonly id: string,
    private _name: string,
    private _status: ProductStatus,
    private _variants: Variant[] = [],
  ) {
    if (!_name.trim()) throw new DomainError('Product name is required');
  }

  static create(id: string, name: string): Product {
    return new Product(id, name.trim(), 'ACTIVE');
  }

  get name(): string {
    return this._name;
  }
  get status(): ProductStatus {
    return this._status;
  }
  get variants(): Variant[] {
    return [...this._variants];
  }

  rename(name: string): void {
    if (!name.trim()) throw new DomainError('Product name is required');
    this._name = name.trim();
  }

  addVariant(v: Variant): void {
    if (this._variants.some((x) => x.sku.value === v.sku.value)) {
      throw new DomainError('SKU already exists on this product');
    }
    this._variants.push(v);
  }

  deactivate(): void {
    this._status = 'INACTIVE';
  }
  activate(): void {
    this._status = 'ACTIVE';
  }
}
