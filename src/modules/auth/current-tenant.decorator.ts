import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import type { Request } from 'express';
import { auth } from '../../auth/auth';
import { Tenant, UserRole } from './tenant.type';

/**
 * v2.0: previously read `req.tenant`, populated by the old custom
 * JwtAuthGuard after manually verifying a JWT it had signed itself. That
 * guard is gone — @thallesp/nestjs-better-auth registers its own global
 * guard (see app.module.ts) that already validated this same request
 * before this decorator runs, so `auth.api.getSession` returning null
 * here should be unreachable in practice. It's called again anyway,
 * directly, via Better Auth's own framework-agnostic `getSession` API
 * (see `fromNodeHeaders` — the same pattern Better Auth documents for
 * Express) rather than reaching into whatever internal request property
 * the NestJS integration package attaches its own resolved session to,
 * which isn't part of its documented public API. The cost is one redundant
 * session lookup per protected request (the guard already did one) —
 * accepted deliberately for now in exchange for depending only on a
 * documented, stable API. See AUDIT_REPORT.md section H.
 */
export const CurrentTenant = createParamDecorator(async (_data: unknown, ctx: ExecutionContext): Promise<Tenant> => {
  const req = ctx.switchToHttp().getRequest<Request>();
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) {
    throw new UnauthorizedException('Missing authenticated session');
  }

  // session.user is typed by Better Auth's core User model, which knows
  // nothing about this app's additionalFields (businessId/role) at the
  // type level even though the adapter reads/writes them correctly at
  // runtime — see src/auth/auth.ts. Asserted here, in this one place,
  // rather than threading a app-specific session type through
  // @thallesp/nestjs-better-auth's own decorators.
  const user = session.user as typeof session.user & { businessId: string; role: UserRole };
  return { userId: user.id, businessId: user.businessId, role: user.role };
});
