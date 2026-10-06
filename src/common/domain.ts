/**
 * Shared domain primitives. Framework-agnostic on purpose: no NestJS, no
 * Drizzle, no HTTP concepts allowed in this file (or anywhere under
 * `domain/`). See AUDIT_REPORT.md P0-4 for why Money was rewritten to use
 * integer minor units instead of floating point `number`.
 */

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DomainError';
  }
}

/**
 * Money is stored and computed as an integer number of "minor units"
 * (e.g. cents for a 2-decimal currency) so that add/subtract/multiply never
 * touch floating point arithmetic. Decimal values only exist at the
 * boundary: when parsing a client/DB decimal string in, and when
 * serializing back out to a Postgres `numeric` column or an API response.
 *
 * `decimals` defaults to 2 to match the existing `numeric(14,2)` columns.
 * NOTE: some currencies (e.g. XOF, the current default) have no minor unit
 * in real-world use (0 decimals). Changing column precision is a schema
 * migration + product decision, not something this pass makes silently —
 * see AUDIT_REPORT.md section F.
 */
export class Money {
  private constructor(
    readonly minorUnits: number,
    readonly currency: string,
    readonly decimals: number,
  ) {
    if (!Number.isInteger(minorUnits) || minorUnits < 0) {
      throw new DomainError('Money amount must resolve to a non-negative integer number of minor units');
    }
    if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      throw new DomainError('Currency must be a 3-letter ISO 4217 code');
    }
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 6) {
      throw new DomainError('Invalid currency decimals');
    }
  }

  static zero(currency = 'XOF', decimals = 2): Money {
    return new Money(0, currency, decimals);
  }

  static fromMinorUnits(minorUnits: number, currency = 'XOF', decimals = 2): Money {
    return new Money(minorUnits, currency, decimals);
  }

  /**
   * Parses a decimal amount (as sent by a validated DTO, or as read back
   * from a Postgres `numeric` column, which the pg driver returns as a
   * string). Rounds to the nearest minor unit — this is the ONLY place
   * float rounding happens, and it happens exactly once, at the boundary.
   */
  static fromDecimal(amount: number | string, currency = 'XOF', decimals = 2): Money {
    const asNumber = typeof amount === 'string' ? Number(amount) : amount;
    if (!Number.isFinite(asNumber) || asNumber < 0) {
      throw new DomainError('Money amount must be a non-negative finite number');
    }
    const factor = 10 ** decimals;
    const minorUnits = Math.round(asNumber * factor);
    return new Money(minorUnits, currency, decimals);
  }

  toDecimalString(): string {
    return (this.minorUnits / 10 ** this.decimals).toFixed(this.decimals);
  }

  /** For display/logging only. Do not feed this back into arithmetic. */
  toDisplayNumber(): number {
    return this.minorUnits / 10 ** this.decimals;
  }

  add(other: Money): Money {
    this.assertCompatible(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency, this.decimals);
  }

  subtract(other: Money): Money {
    this.assertCompatible(other);
    const result = this.minorUnits - other.minorUnits;
    if (result < 0) throw new DomainError('Resulting amount cannot be negative');
    return new Money(result, this.currency, this.decimals);
  }

  multiply(quantity: number): Money {
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new DomainError('Quantity must be a non-negative integer');
    }
    return new Money(this.minorUnits * quantity, this.currency, this.decimals);
  }

  isGreaterThan(other: Money): boolean {
    this.assertCompatible(other);
    return this.minorUnits > other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.decimals === other.decimals && this.minorUnits === other.minorUnits;
  }

  private assertCompatible(other: Money): void {
    if (other.currency !== this.currency) throw new DomainError('Currency mismatch');
    if (other.decimals !== this.decimals) throw new DomainError('Incompatible money precision');
  }
}

export class Quantity {
  private constructor(readonly value: number) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new DomainError('Quantity must be a positive integer');
    }
  }
  static of(value: number): Quantity {
    return new Quantity(value);
  }
}

export class SKU {
  private constructor(readonly value: string) {
    if (!/^[A-Za-z0-9._-]{2,80}$/.test(value)) {
      throw new DomainError('Invalid SKU');
    }
  }
  static of(value: string): SKU {
    return new SKU(value.trim());
  }
}
