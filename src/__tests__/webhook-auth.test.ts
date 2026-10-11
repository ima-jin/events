/**
 * Tests for src/lib/webhook-auth.ts: constant-time shared-secret checks that fail closed.
 */
import { describe, expect, it } from 'vitest';
import { isBearerAuthorized, secretsMatch } from '@/lib/webhook-auth';

const SECRET = 'test-webhook-secret';

describe('secretsMatch', () => {
  it('accepts only the identical secret', () => {
    expect(secretsMatch(SECRET, SECRET)).toBe(true);
    expect(secretsMatch('test-webhook-secreT', SECRET)).toBe(false);
  });

  it('rejects a secret of a different length without comparing bytes', () => {
    expect(secretsMatch(`${SECRET}x`, SECRET)).toBe(false);
    expect(secretsMatch('', SECRET)).toBe(false);
  });

  it.each([undefined, null, 42, {}])('rejects a non-string (%s)', (value) => {
    expect(secretsMatch(value, SECRET)).toBe(false);
  });
});

describe('isBearerAuthorized', () => {
  it('accepts the configured secret as a Bearer token', () => {
    expect(isBearerAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    ['no header', null],
    ['an empty header', ''],
    ['a different scheme', `Basic ${SECRET}`],
    ['the bare secret', SECRET],
    ['the wrong token', 'Bearer nope'],
    ['a longer token', `Bearer ${SECRET}-extra`],
  ])('rejects %s', (_label, header) => {
    expect(isBearerAuthorized(header, SECRET)).toBe(false);
  });

  it('fails closed when no secret is configured, even for a matching-looking header', () => {
    expect(isBearerAuthorized('Bearer undefined', undefined)).toBe(false);
    expect(isBearerAuthorized('Bearer ', '')).toBe(false);
    expect(isBearerAuthorized(undefined, undefined)).toBe(false);
  });
});
