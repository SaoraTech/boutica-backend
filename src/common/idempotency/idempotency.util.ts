import { createHash } from 'node:crypto';

/**
 * Deterministic fingerprint of a request payload, used to detect an
 * `Idempotency-Key` being replayed against a *different* body — which is a
 * client bug we should reject loudly rather than silently return a stale
 * response for.
 */
export function hashRequestPayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
