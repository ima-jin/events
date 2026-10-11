/**
 * Tests for src/lib/contact-email.ts (kernel parity #2058).
 *
 * Neither helper touches a database: `getContactEmail` reads and
 * `backfillContactEmail` writes through the kernel's public API
 * (`@/lib/kernel`, mocked here), mirroring how the check-in route
 * delegates to `evaluateEligibility`. Both are non-throwing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Logger } from '@ima-jin/logger';

const mocks = vi.hoisted(() => ({
  getContactEmailMock: vi.fn(),
  backfillContactEmailMock: vi.fn(),
}));

vi.mock('@/lib/kernel', () => ({
  getContactEmail: mocks.getContactEmailMock,
  backfillContactEmail: mocks.backfillContactEmailMock,
}));

import { getContactEmail, backfillContactEmail } from '../lib/contact-email';

const BUYER_DID = 'did:imajin:buyer';
const BUYER_EMAIL = 'buyer@example.com';

function makeLog() {
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
  return { log, logger: log as unknown as Logger };
}

beforeEach(() => {
  mocks.getContactEmailMock.mockReset();
  mocks.backfillContactEmailMock.mockReset();
});

describe('getContactEmail', () => {
  it('returns the contact email the kernel exposes for the DID', async () => {
    mocks.getContactEmailMock.mockResolvedValueOnce(BUYER_EMAIL);
    const { logger } = makeLog();

    const result = await getContactEmail(BUYER_DID, logger);

    expect(result).toBe(BUYER_EMAIL);
    expect(mocks.getContactEmailMock).toHaveBeenCalledWith(BUYER_DID);
  });

  it('returns null without warning when the kernel has no visible email', async () => {
    mocks.getContactEmailMock.mockResolvedValueOnce(null);
    const { log, logger } = makeLog();

    const result = await getContactEmail(BUYER_DID, logger);

    expect(result).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns null and logs a warning when the kernel client throws', async () => {
    mocks.getContactEmailMock.mockRejectedValueOnce(new Error('kernel down'));
    const { log, logger } = makeLog();

    const result = await getContactEmail(BUYER_DID, logger);

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.stringContaining('kernel down') }),
      expect.any(String),
    );
  });
});

describe('backfillContactEmail (#2058 — delegates to the kernel route)', () => {
  it('calls the kernel client with the did and email and stays quiet on success', async () => {
    mocks.backfillContactEmailMock.mockResolvedValueOnce(true);
    const { log, logger } = makeLog();

    await backfillContactEmail(BUYER_DID, BUYER_EMAIL, logger);

    expect(mocks.backfillContactEmailMock).toHaveBeenCalledWith(BUYER_DID, BUYER_EMAIL);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs a warning (non-fatal) when the kernel call fails, without throwing', async () => {
    mocks.backfillContactEmailMock.mockResolvedValueOnce(false);
    const { log, logger } = makeLog();

    await expect(backfillContactEmail(BUYER_DID, BUYER_EMAIL, logger)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith({ did: BUYER_DID }, expect.any(String));
  });
});
