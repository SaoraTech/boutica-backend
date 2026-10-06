import { DomainError, Money } from '../../../common/domain';

export class Expense {
  private constructor(
    readonly id: string,
    readonly businessId: string,
    readonly category: string,
    readonly amount: Money,
    readonly description: string | null,
  ) {}

  static create(id: string, businessId: string, category: string, amount: Money, description?: string): Expense {
    if (!category.trim()) throw new DomainError('Expense category is required');
    if (amount.minorUnits === 0) throw new DomainError('Expense amount must be greater than zero');
    return new Expense(id, businessId, category.trim(), amount, description?.trim() || null);
  }
}
