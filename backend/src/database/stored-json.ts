import { AppError } from '../errors.js';
import { assertDomainContract } from '../event-contract.js';

export function parseStoredJson<T>(raw: string, label: string, domainDefinition?: string): T {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new AppError(
      'INTERNAL_ERROR',
      `Stored JSON is invalid: ${label}`,
      { cause: error instanceof Error ? error.message : String(error) },
      500
    );
  }
  if (domainDefinition) assertDomainContract(domainDefinition, value);
  return value as T;
}

export function stringifyStoredJson(value: unknown, label: string): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new AppError(
      'INTERNAL_ERROR',
      `Value cannot be stored as JSON: ${label}`,
      { cause: error instanceof Error ? error.message : String(error) },
      500
    );
  }
}
