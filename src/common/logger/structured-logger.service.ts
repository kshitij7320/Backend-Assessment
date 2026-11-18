import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

export interface LogContext {
  request_id?: string;
  submission_id?: string;
  attempt_id?: string;
  fencing_token?: number | string;
  organization_id?: string;
  actor_id?: string;
  worker_id?: string;
}

export interface StructuredLogEntry extends LogContext {
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  service: string;
  event: string;
  message?: string;
  duration_ms?: number;
  meta?: Record<string, unknown>;
}

const REDACTED_KEYS = new Set([
  'authorization',
  'auth_token',
  'token',
  'password',
  'secret',
  'input_data',
  'expected_output',
  'actual_output',
  'hidden_input',
  'hidden_output',
]);

export const requestContextStorage = new AsyncLocalStorage<LogContext>();

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(k.toLowerCase())) {
        clean[k] = '[REDACTED]';
      } else {
        clean[k] = sanitizeValue(v, depth + 1);
      }
    }
    return clean;
  }
  return value;
}

@Injectable()
export class StructuredLoggerService {
  private static ringBuffer: StructuredLogEntry[] = [];
  private static readonly MAX_BUFFER = 2000;
  private readonly serviceName: string;

  constructor() {
    this.serviceName = process.env.SERVICE_NAME || 'shodh-api';
  }

  public info(
    event: string,
    fields: Partial<StructuredLogEntry> & Record<string, unknown> = {},
  ): void {
    this.emit('info', event, fields);
  }

  public warn(
    event: string,
    fields: Partial<StructuredLogEntry> & Record<string, unknown> = {},
  ): void {
    this.emit('warn', event, fields);
  }

  public error(
    event: string,
    fields: Partial<StructuredLogEntry> & Record<string, unknown> = {},
  ): void {
    this.emit('error', event, fields);
  }

  private emit(
    level: 'info' | 'warn' | 'error' | 'debug',
    event: string,
    fields: Record<string, unknown>,
  ): void {
    const asyncCtx = requestContextStorage.getStore() || {};
    const sanitizedFields = sanitizeValue(fields) as Record<string, unknown>;

    const {
      request_id,
      submission_id,
      attempt_id,
      fencing_token,
      organization_id,
      actor_id,
      worker_id,
      service,
      message,
      duration_ms,
      ...rest
    } = sanitizedFields;

    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: (service as string) || this.serviceName,
      event,
      request_id: (request_id as string) || asyncCtx.request_id,
      submission_id: (submission_id as string) || asyncCtx.submission_id,
      attempt_id: (attempt_id as string) || asyncCtx.attempt_id,
      fencing_token:
        (fencing_token as number | string) ?? asyncCtx.fencing_token,
      organization_id:
        (organization_id as string) || asyncCtx.organization_id,
      actor_id: (actor_id as string) || asyncCtx.actor_id,
      worker_id: (worker_id as string) || asyncCtx.worker_id,
      message: message as string | undefined,
      duration_ms: duration_ms as number | undefined,
      meta: Object.keys(rest).length > 0 ? rest : undefined,
    };

    // Strip undefined keys for compact JSON output
    const cleanEntry = JSON.parse(JSON.stringify(entry)) as StructuredLogEntry;

    StructuredLoggerService.ringBuffer.push(cleanEntry);
    if (
      StructuredLoggerService.ringBuffer.length >
      StructuredLoggerService.MAX_BUFFER
    ) {
      StructuredLoggerService.ringBuffer.shift();
    }

    if (process.env.LOG_SILENT !== 'true') {
      process.stdout.write(JSON.stringify(cleanEntry) + '\n');
    }
  }

  public static getRecentLogs(): StructuredLogEntry[] {
    return [...StructuredLoggerService.ringBuffer];
  }

  public static clearLogs(): void {
    StructuredLoggerService.ringBuffer = [];
  }
}
