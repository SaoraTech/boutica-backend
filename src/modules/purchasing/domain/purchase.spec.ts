import { DomainError, Money, Quantity } from '../../../common/domain';
import { Purchase } from './purchase';

function item(variantId: string, qty: number, price: string) {
  return { variantId, quantity: Quantity.of(qty), unitPrice: Money.fromDecimal(price, 'XOF') };
}

describe('Purchase', () => {
  it('rejects a purchase with no items', () => {
    expect(() => Purchase.create('p1', 'biz1', null, [])).toThrow(DomainError);
  });

  it('computes total as the sum of unitPrice * quantity for every line', () => {
    const purchase = Purchase.create('p1', 'biz1', null, [item('v1', 10, '2.50'), item('v2', 4, '1.25')]);
    // 10*2.50 + 4*1.25 = 25.00 + 5.00 = 30.00
    expect(purchase.total('XOF').toDecimalString()).toBe('30.00');
  });

  it('moves from DRAFT to RECEIVED exactly once', () => {
    const purchase = Purchase.create('p1', 'biz1', null, [item('v1', 1, '1.00')]);
    expect(purchase.status).toBe('DRAFT');
    purchase.receive();
    expect(purchase.status).toBe('RECEIVED');
    expect(() => purchase.receive()).toThrow(DomainError);
  });

  it('cannot cancel an already-received purchase directly', () => {
    const purchase = Purchase.create('p1', 'biz1', null, [item('v1', 1, '1.00')]);
    purchase.receive();
    expect(() => purchase.cancel()).toThrow(DomainError);
  });
});
