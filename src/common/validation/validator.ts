import { createValidationError } from '../errors/domain-errors';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PaginationParams {
  limit: number;
  offset: number;
}

export function assertUuid(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value)) {
    throw createValidationError(
      'INVALID_UUID',
      `Field '${fieldName}' must be a valid UUID`,
      { field: fieldName, received: value },
    );
  }
  return value;
}

export function assertNonEmptyString(
  value: unknown,
  fieldName: string,
  maxLength = 5000,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw createValidationError(
      'INVALID_STRING',
      `Field '${fieldName}' must be a non-empty string`,
      { field: fieldName },
    );
  }
  if (value.length > maxLength) {
    throw createValidationError(
      'STRING_TOO_LONG',
      `Field '${fieldName}' exceeds maximum length of ${maxLength} characters`,
      { field: fieldName, maxLength },
    );
  }
  return value.trim();
}

export function assertRawString(
  value: unknown,
  fieldName: string,
  maxLength = 100000,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw createValidationError(
      'INVALID_STRING',
      `Field '${fieldName}' must be a non-empty string`,
      { field: fieldName },
    );
  }
  if (value.length > maxLength) {
    throw createValidationError(
      'STRING_TOO_LONG',
      `Field '${fieldName}' exceeds maximum length of ${maxLength} characters`,
      { field: fieldName, maxLength },
    );
  }
  return value;
}

export function assertIntInRange(
  value: unknown,
  fieldName: string,
  min: number,
  max: number,
): number {
  const num = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isInteger(num) || num < min || num > max) {
    throw createValidationError(
      'INVALID_INTEGER_RANGE',
      `Field '${fieldName}' must be an integer between ${min} and ${max}`,
      { field: fieldName, min, max, received: value },
    );
  }
  return num;
}

export function assertEnum<T extends string>(
  value: unknown,
  fieldName: string,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw createValidationError(
      'INVALID_ENUM_VALUE',
      `Field '${fieldName}' must be one of: ${allowed.join(', ')}`,
      { field: fieldName, allowed, received: value },
    );
  }
  return value as T;
}

export function assertIsoDate(value: unknown, fieldName: string): Date {
  if (typeof value !== 'string') {
    throw createValidationError(
      'INVALID_TIMESTAMP',
      `Field '${fieldName}' must be an ISO-8601 timestamp string`,
      { field: fieldName },
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw createValidationError(
      'INVALID_TIMESTAMP',
      `Field '${fieldName}' is not a valid timestamp`,
      { field: fieldName, received: value },
    );
  }
  return date;
}

export function parsePagination(
  query: Record<string, unknown>,
  defaultLimit = 20,
  maxLimit = 100,
): PaginationParams {
  let limit = defaultLimit;
  let offset = 0;

  if (query.limit !== undefined) {
    limit = assertIntInRange(query.limit, 'limit', 1, maxLimit);
  }
  if (query.offset !== undefined) {
    offset = assertIntInRange(query.offset, 'offset', 0, 1000000);
  }

  return { limit, offset };
}

