/**
 * Typed failures raised by the service layer (`src/services/*`).
 *
 * Services know nothing about HTTP: they throw a {@link ServiceError} with a
 * semantic `code`, and the route layer (`app/api/**`) maps it to a response with
 * {@link ServiceError.status}. A service may pin a specific `status` when the
 * kernel behaviour used a code other than the default for that `code`
 * (kernel-parity responses).
 */
export type ServiceErrorCode =
  | 'invalid'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unavailable';

const DEFAULT_STATUS: Record<ServiceErrorCode, number> = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
};

export interface ServiceErrorOptions {
  /** HTTP status to use instead of the default for `code` (kernel parity). */
  status?: number;
  /** Extra response fields the route should echo (e.g. `{ field: 'quantity' }`). */
  details?: Record<string, unknown>;
}

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ServiceErrorCode, message: string, options: ServiceErrorOptions = {}) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = options.status ?? DEFAULT_STATUS[code];
    this.details = options.details;
  }
}

export function isServiceError(value: unknown): value is ServiceError {
  return value instanceof ServiceError;
}
