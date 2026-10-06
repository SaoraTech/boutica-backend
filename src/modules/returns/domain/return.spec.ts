import { DomainError, Money } from '../../../common/domain';
import { Return, SaleItemReturnableInfo } from './return';

function returnable(saleItemId: string, variantId: string, unitPrice: string, sold: number, alreadyReturned = 0): [string, SaleItemReturnableInfo] {
  return [saleItemId, { saleItemId, variantId, unitPrice: Money.fromDecimal(unitPrice, 'XOF'), soldQuantity: sold, alreadyReturnedQuantity: alreadyReturned }];
}

describe('Return', () => {
  it('allows returning up to (but not more than) the sold quantity', () => {
    const map = new Map([returnable('si1', 'v1', '10.00', 5)]);
    const ret = Return.create('r1', 'biz1', 'sale1', [{ saleItemId: 'si1', quantity: 5, condition: 'RESTOCK' }], map);
    expect(ret.total('XOF').toDecimalString()).toBe('50.00');
  });

  it('rejects a return quantity greater than the sold quantity — the core mission invariant', () => {
    const map = new Map([returnable('si1', 'v1', '10.00', 5)]);
    expect(() => Return.create('r1', 'biz1', 'sale1', [{ saleItemId: 'si1', quantity: 6, condition: 'RESTOCK' }], map)).toThrow(DomainError);
  });

  it('accounts for quantity already returned in previous returns', () => {
    // Sold 5, 3 already returned -> only 2 remain returnable.
    const map = new Map([returnable('si1', 'v1', '10.00', 5, 3)]);
    expect(() => Return.create('r1', 'biz1', 'sale1', [{ saleItemId: 'si1', quantity: 3, condition: 'RESTOCK' }], map)).toThrow(DomainError);
    expect(() => Return.create('r1', 'biz1', 'sale1', [{ saleItemId: 'si1', quantity: 2, condition: 'RESTOCK' }], map)).not.toThrow();
  });

  it('rejects a sale item that is not part of the referenced sale', () => {
    const map = new Map([returnable('si1', 'v1', '10.00', 5)]);
    expect(() => Return.create('r1', 'biz1', 'sale1', [{ saleItemId: 'unknown', quantity: 1, condition: 'RESTOCK' }], map)).toThrow(DomainError);
  });

  it('rejects an empty item list', () => {
    expect(() => Return.create('r1', 'biz1', 'sale1', [], new Map())).toThrow(DomainError);
  });

  // ROUND 2 regression tests: two lines in the SAME request referencing the
  // same saleItemId used to be checked independently against
  // soldQuantity - alreadyReturnedQuantity, so together they could
  // over-return even though each line looked fine alone.
  it('sums multiple lines against the same sale item within one request (round-2 regression test)', () => {
    const map = new Map([returnable('si1', 'v1', '10.00', 5)]);
    // 3 RESTOCK + 3 DAMAGED against a sale item with only 5 sold: 6 > 5,
    // must be rejected even though each individual line (3 <= 5) would
    // pass on its own.
    expect(() =>
      Return.create(
        'r1',
        'biz1',
        'sale1',
        [
          { saleItemId: 'si1', quantity: 3, condition: 'RESTOCK' },
          { saleItemId: 'si1', quantity: 3, condition: 'DAMAGED' },
        ],
        map,
      ),
    ).toThrow(DomainError);
  });

  it('allows a within-limit split of the same sale item across two conditions (round-2 regression test)', () => {
    const map = new Map([returnable('si1', 'v1', '10.00', 5)]);
    // 3 RESTOCK + 2 DAMAGED = 5, exactly the sold quantity — must succeed.
    const ret = Return.create(
      'r1',
      'biz1',
      'sale1',
      [
        { saleItemId: 'si1', quantity: 3, condition: 'RESTOCK' },
        { saleItemId: 'si1', quantity: 2, condition: 'DAMAGED' },
      ],
      map,
    );
    expect(ret.items).toHaveLength(2);
    expect(ret.total('XOF').toDecimalString()).toBe('50.00');
  });
});
