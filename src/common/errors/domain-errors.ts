export type ErrorCategory =
  | 'VALIDATION_ERROR'
  | 'AUTH_ERROR'
  | 'BUSINESS_RULE_ERROR'
  | 'INFRASTRUCTURE_ERROR';

export class AppError extends Error {
  public readonly category: ErrorCategory;
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  constructor(params: {
    category: ErrorCategory;
    code: string;
    statusCode: number;
    message: string;
    details?: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = 'AppError';
    this.category = params.category;
    this.code = params.code;
    this.statusCode = params.statusCode;
    this.details = params.details;
  }
}

export function createValidationError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError({
    category: 'VALIDATION_ERROR',
    code,
    statusCode: 400,
    message,
    details,
  });
}

export function createAuthenticationError(
  code: string,
  message: string,
): AppError {
  return new AppError({
    category: 'AUTH_ERROR',
    code,
    statusCode: 401,
    message,
  });
}

export function createAuthorizationError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError({
    category: 'AUTH_ERROR',
    code,
    statusCode: 403,
    message,
    details,
  });
}

export function createNotFoundError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError({
    category: 'BUSINESS_RULE_ERROR',
    code,
    statusCode: 404,
    message,
    details,
  });
}

export function createBusinessRuleError(
  code: string,
  message: string,
  statusCode: 409 | 422 = 409,
  details?: Record<string, unknown>,
): AppError {
  return new AppError({
    category: 'BUSINESS_RULE_ERROR',
    code,
    statusCode,
    message,
    details,
  });
}

export function createInfrastructureError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): AppError {
  return new AppError({
    category: 'INFRASTRUCTURE_ERROR',
    code,
    statusCode: 503,
    message,
    details,
  });
}
