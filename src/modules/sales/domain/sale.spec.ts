import { DomainError, Money, Quantity } from '../../../common/domain';
import { Sale } from './sale';

function item(variantId: string, qty: number, price: string) {
  return { variantId, quantity: Quantity.of(qty), unitPrice: Money.fromDecimal(price, 'XOF') };
}

describe('Sale', () => {
  it('rejects a sale with no items', () => {
    expect(() => Sale.create('s1', 'biz1', [], Money.zero('XOF'))).toThrow(DomainError);
  });

  it('computes subtotal as the sum of unitPrice * quantity for every line', () => {
    const sale = Sale.create('s1', 'biz1', [item('v1', 2, '10.00'), item('v2', 3, '5.50')], Money.zero('XOF'));
    // 2*10.00 + 3*5.50 = 20.00 + 16.50 = 36.50
    expect(sale.subtotal('XOF').toDecimalString()).toBe('36.50');
  });

  it('subtracts the discount from the subtotal to get the total', () => {
    const sale = Sale.create('s1', 'biz1', [item('v1', 1, '100.00')], Money.fromDecimal('15.00', 'XOF'));
    expect(sale.total('XOF').toDecimalString()).toBe('85.00');
  });

  it('rejects a discount greater than the subtotal', () => {
    const sale = Sale.create('s1', 'biz1', [item('v1', 1, '10.00')], Money.fromDecimal('20.00', 'XOF'));
    expect(() => sale.total('XOF')).toThrow(DomainError);
  });

  it('starts in DRAFT and moves to COMPLETED exactly once', () => {
    const sale = Sale.create('s1', 'biz1', [item('v1', 1, '10.00')], Money.zero('XOF'));
    expect(sale.status).toBe('DRAFT');
    sale.complete();
    expect(sale.status).toBe('COMPLETED');
    expect(() => sale.complete()).toThrow(DomainError);
  });

  it('cannot cancel an already-completed sale directly', () => {
    const sale = Sale.create('s1', 'biz1', [item('v1', 1, '10.00')], Money.zero('XOF'));
    sale.complete();
    expect(() => sale.cancel()).toThrow(DomainError);
  });
});
