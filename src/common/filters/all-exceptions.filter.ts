import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
} from '@nestjs/common';
import { AppError, ErrorCategory } from '../errors/domain-errors';
import {
  requestContextStorage,
  StructuredLoggerService,
} from '../logger/structured-logger.service';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    @Inject(StructuredLoggerService)
    private readonly logger: StructuredLoggerService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();
    const asyncStore = requestContextStorage.getStore();
    const requestId =
      request?.requestId || asyncStore?.request_id || 'req-unknown';

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let category: ErrorCategory = 'INFRASTRUCTURE_ERROR';
    let code = 'INTERNAL_SERVER_ERROR';
    let message = 'An unexpected infrastructure error occurred';
    let details: Record<string, unknown> | undefined;

    if (exception instanceof AppError) {
      statusCode = exception.statusCode;
      category = exception.category;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse() as any;
      message =
        typeof res === 'string'
          ? res
          : res?.message || exception.message || 'HTTP Exception';
      if (statusCode === 400) {
        category = 'VALIDATION_ERROR';
        code = 'INVALID_REQUEST';
      } else if (statusCode === 401 || statusCode === 403) {
        category = 'AUTH_ERROR';
        code = statusCode === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN';
      } else if (statusCode >= 400 && statusCode < 500) {
        category = 'BUSINESS_RULE_ERROR';
        code = 'CLIENT_ERROR';
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    this.logger.warn('http_request_error', {
      request_id: requestId,
      method: request?.method,
      path: request?.url,
      status_code: statusCode,
      error_category: category,
      error_code: code,
      message,
    });

    response.status(statusCode).json({
      error: {
        category,
        code,
        message,
        request_id: requestId,
        ...(details ? { details } : {}),
      },
    });
  }
}
