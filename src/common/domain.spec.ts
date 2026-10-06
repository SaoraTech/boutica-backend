import { DomainError, Money, Quantity, SKU } from './domain';

describe('Money', () => {
  it('parses a decimal string and round-trips it exactly', () => {
    const m = Money.fromDecimal('19.99', 'XOF');
    expect(m.minorUnits).toBe(1999);
    expect(m.toDecimalString()).toBe('19.99');
  });

  it('never produces floating point drift across many additions', () => {
    // 0.1 + 0.2 famously != 0.3 in raw JS floats. Money must not inherit
    // that behaviour because all arithmetic happens on integer minor units.
    let total = Money.zero('XOF');
    for (let i = 0; i < 10; i++) {
      total = total.add(Money.fromDecimal('0.10', 'XOF'));
    }
    expect(total.toDecimalString()).toBe('1.00');
  });

  it('rejects a negative amount', () => {
    expect(() => Money.fromDecimal(-1, 'XOF')).toThrow(DomainError);
  });

  it('rejects a non-finite amount', () => {
    expect(() => Money.fromDecimal(NaN, 'XOF')).toThrow(DomainError);
  });

  it('multiply is exact integer arithmetic, not float multiplication', () => {
    const unitPrice = Money.fromDecimal('0.10', 'XOF');
    const line = unitPrice.multiply(3); // naive float: 0.1 * 3 = 0.30000000000000004
    expect(line.toDecimalString()).toBe('0.30');
  });

  it('subtract throws DomainError instead of going negative', () => {
    const a = Money.fromDecimal('5.00', 'XOF');
    const b = Money.fromDecimal('10.00', 'XOF');
    expect(() => a.subtract(b)).toThrow(DomainError);
  });

  it('rejects mixing currencies', () => {
    const xof = Money.fromDecimal('10', 'XOF');
    const usd = Money.fromDecimal('10', 'USD');
    expect(() => xof.add(usd)).toThrow(DomainError);
  });

  it('rejects a malformed currency code', () => {
    expect(() => Money.fromDecimal('10', 'x')).toThrow(DomainError);
  });
});

describe('Quantity', () => {
  it('accepts a positive integer', () => {
    expect(Quantity.of(3).value).toBe(3);
  });

  it('rejects zero', () => {
    expect(() => Quantity.of(0)).toThrow(DomainError);
  });

  it('rejects a negative quantity', () => {
    expect(() => Quantity.of(-2)).toThrow(DomainError);
  });

  it('rejects a non-integer quantity', () => {
    expect(() => Quantity.of(1.5)).toThrow(DomainError);
  });
});

describe('SKU', () => {
  it('accepts a valid SKU and trims whitespace', () => {
    expect(SKU.of('  ABC-123  ').value).toBe('ABC-123');
  });

  it('rejects a SKU that is too short', () => {
    expect(() => SKU.of('A')).toThrow(DomainError);
  });

  it('rejects a SKU with invalid characters', () => {
    expect(() => SKU.of('ABC 123 !!')).toThrow(DomainError);
  });
});
