import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import {
  requestContextStorage,
  StructuredLoggerService,
} from '../logger/structured-logger.service';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(StructuredLoggerService)
    private readonly logger: StructuredLoggerService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    const headerReqId = request.headers?.['x-request-id'];
    const requestId =
      typeof headerReqId === 'string' && headerReqId.trim().length > 0
        ? headerReqId.trim()
        : `req-${randomUUID()}`;

    request.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);

    const startTime = Date.now();
    const store = {
      request_id: requestId,
      organization_id: request.params?.orgId,
      actor_id: request.actor?.userId,
    };

    return new Observable((subscriber) => {
      requestContextStorage.run(store, () => {
        next
          .handle()
          .pipe(
            tap({
              next: () => {
                const durationMs = Date.now() - startTime;
                this.logger.info('http_request_completed', {
                  request_id: requestId,
                  organization_id: request.params?.orgId,
                  actor_id: request.actor?.userId,
                  method: request.method,
                  path: request.url,
                  status_code: response.statusCode,
                  duration_ms: durationMs,
                });
              },
            }),
          )
          .subscribe(subscriber);
      });
    });
  }
}
