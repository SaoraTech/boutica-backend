export type UserRole = 'OWNER' | 'STAFF';

/**
 * Resolved from the active Better Auth session by CurrentTenant — every
 * controller must read businessId from here — NEVER from the request
 * body/params — that was the root cause of the cross-tenant access holes
 * documented in AUDIT_REPORT.md P0-1. Unchanged shape from v1.x on
 * purpose: every controller in this codebase already depends on this
 * exact type, and the v2.0 auth migration was deliberately scoped to
 * replace HOW it's populated, not the type itself, to keep the change
 * contained to current-tenant.decorator.ts.
 */
export interface Tenant {
  userId: string;
  businessId: string;
  role: UserRole;
}
