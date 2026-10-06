import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DomainError } from '../domain';

/**
 * Centralised error mapping. Before this filter existed, a thrown
 * DomainError (e.g. "Insufficient stock") bubbled up as an unhandled
 * exception and Nest returned an opaque 500, hiding a perfectly good
 * client-facing message. Conversely we never leak raw driver/stack details
 * for *unknown* errors (see AUDIT_REPORT.md P1 "erreurs trop verbeuses").
 */
interface PgErrorLike {
  code?: string;
  constraint?: string;
  detail?: string;
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      res.status(status).json({
        statusCode: status,
        path: req.url,
        ...(typeof body === 'string' ? { message: body } : body),
      });
      return;
    }

    if (exception instanceof DomainError) {
      res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'DomainError',
        message: exception.message,
        path: req.url,
      });
      return;
    }

    const pgError = exception as PgErrorLike;
    if (pgError?.code === '23505') {
      res.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: 'A resource with the same unique key already exists.',
        path: req.url,
      });
      return;
    }
    if (pgError?.code === '23514') {
      res.status(HttpStatus.CONFLICT).json({
        statusCode: HttpStatus.CONFLICT,
        error: 'Conflict',
        message: 'This operation would violate a data invariant (e.g. insufficient stock, over-return). Please retry.',
        path: req.url,
      });
      return;
    }
    if (pgError?.code === '23503') {
      res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'BadRequest',
        message: 'A referenced resource does not exist.',
        path: req.url,
      });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : exception);
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'InternalServerError',
      message: 'Unexpected error.',
      path: req.url,
    });
  }
}
