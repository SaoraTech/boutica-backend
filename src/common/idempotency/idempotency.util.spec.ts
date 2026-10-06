import { hashRequestPayload } from './idempotency.util';

describe('hashRequestPayload', () => {
  it('produces the same hash for structurally identical payloads', () => {
    const a = hashRequestPayload({ items: [{ variantId: 'v1', quantity: 2 }] });
    const b = hashRequestPayload({ items: [{ variantId: 'v1', quantity: 2 }] });
    expect(a).toBe(b);
  });

  it('produces a different hash when the payload differs', () => {
    const a = hashRequestPayload({ items: [{ variantId: 'v1', quantity: 2 }] });
    const b = hashRequestPayload({ items: [{ variantId: 'v1', quantity: 3 }] });
    expect(a).not.toBe(b);
  });
});
