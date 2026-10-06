import { DomainError, Quantity } from '../../../common/domain';
import { Stock } from './stock';

describe('Stock', () => {
  it('rejects a negative starting quantity', () => {
    expect(() => new Stock('v1', -1)).toThrow(DomainError);
  });

  it('increase adds to the current quantity', () => {
    const stock = new Stock('v1', 5);
    stock.increase(Quantity.of(3));
    expect(stock.quantity).toBe(8);
  });

  it('decrease subtracts when there is enough stock', () => {
    const stock = new Stock('v1', 5);
    stock.decrease(Quantity.of(3));
    expect(stock.quantity).toBe(2);
  });

  it('rejects decreasing past zero — the core overselling guard', () => {
    const stock = new Stock('v1', 5);
    expect(() => stock.decrease(Quantity.of(6))).toThrow(DomainError);
    expect(stock.quantity).toBe(5); // unchanged on rejection
  });

  it('set rejects a negative value', () => {
    const stock = new Stock('v1', 5);
    expect(() => stock.set(-1)).toThrow(DomainError);
  });
});
