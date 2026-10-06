import { DomainError, Money, SKU } from '../../../common/domain';
import { Product, Variant } from './product';

describe('Product', () => {
  it('rejects an empty name', () => {
    expect(() => Product.create('p1', '   ')).toThrow(DomainError);
  });

  it('rejects renaming to an empty name', () => {
    const product = Product.create('p1', 'Phone');
    expect(() => product.rename('   ')).toThrow(DomainError);
  });

  it('rejects two variants sharing the same SKU on the same product', () => {
    const product = Product.create('p1', 'Phone');
    const v1 = new Variant('v1', SKU.of('SKU-1'), '64GB', Money.fromDecimal('100'), Money.fromDecimal('150'));
    const v2 = new Variant('v2', SKU.of('SKU-1'), '128GB', Money.fromDecimal('120'), Money.fromDecimal('170'));
    product.addVariant(v1);
    expect(() => product.addVariant(v2)).toThrow(DomainError);
  });
});

describe('Variant', () => {
  it('rejects a selling price below the purchase price', () => {
    expect(() => new Variant('v1', SKU.of('SKU-1'), '64GB', Money.fromDecimal('150'), Money.fromDecimal('100'))).toThrow(DomainError);
  });

  it('accepts a selling price equal to the purchase price', () => {
    expect(() => new Variant('v1', SKU.of('SKU-1'), '64GB', Money.fromDecimal('100'), Money.fromDecimal('100'))).not.toThrow();
  });
});
