import { describe, expect, it } from 'vitest';
import { isServiceError, ServiceError, type ServiceErrorCode } from '@/services/errors';

describe('ServiceError', () => {
  it.each<[ServiceErrorCode, number]>([
    ['invalid', 400],
    ['unauthenticated', 401],
    ['forbidden', 403],
    ['not_found', 404],
    ['conflict', 409],
    ['unavailable', 503],
  ])('maps %s to HTTP %i by default', (code, status) => {
    const error = new ServiceError(code, 'nope');

    expect(error.status).toBe(status);
    expect(error.message).toBe('nope');
    expect(error.code).toBe(code);
  });

  it('lets a service pin a kernel-parity status and carry response details', () => {
    const error = new ServiceError('conflict', 'Sold out', { status: 400, details: { field: 'quantity' } });

    expect(error.status).toBe(400);
    expect(error.details).toEqual({ field: 'quantity' });
  });

  it('is recognised by isServiceError and not confused with plain errors', () => {
    expect(isServiceError(new ServiceError('invalid', 'x'))).toBe(true);
    expect(isServiceError(new Error('x'))).toBe(false);
    expect(isServiceError('x')).toBe(false);
  });
});
