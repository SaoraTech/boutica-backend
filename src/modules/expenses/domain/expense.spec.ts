import { DomainError, Money } from '../../../common/domain';
import { Expense } from './expense';

describe('Expense', () => {
  it('rejects an empty category', () => {
    expect(() => Expense.create('e1', 'biz1', '   ', Money.fromDecimal('10.00'))).toThrow(DomainError);
  });

  it('rejects a zero amount', () => {
    expect(() => Expense.create('e1', 'biz1', 'Rent', Money.zero('XOF'))).toThrow(DomainError);
  });

  it('trims category and description', () => {
    const expense = Expense.create('e1', 'biz1', '  Rent  ', Money.fromDecimal('10.00'), '  monthly  ');
    expect(expense.category).toBe('Rent');
    expect(expense.description).toBe('monthly');
  });
});
