/**
 * Tests for src/lib/contact-email.ts (ported from kernel apps/events, #2058).
 *
 * Both helpers delegate to the kernel's public API through `src/lib/kernel.ts`
 * (resolved profile email / `POST /auth/api/identity/:did/contact`) — this app
 * never reads or writes kernel tables, so neither helper may touch SQL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  sqlMock: vi.fn(),
  getContactEmailMock: vi.fn(),
  backfillContactEmailMock: vi.fn(),
}));

vi.mock('@/db', () => ({
  getClient: () => mocks.sqlMock,
}));

vi.mock('@/lib/kernel', () => ({
  getContactEmail: mocks.getContactEmailMock,
  backfillContactEmail: mocks.backfillContactEmailMock,
}));

import { getContactEmail, backfillContactEmail } from '../lib/contact-email';
import type { Logger } from '@ima-jin/logger';

function makeLog() {
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { log, asLogger: log as unknown as Logger };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getContactEmail', () => {
  it('returns the contact email the kernel resolves for the DID', async () => {
    mocks.getContactEmailMock.mockResolvedValueOnce('buyer@example.com');

    const result = await getContactEmail('did:imajin:buyer', makeLog().asLogger);

    expect(result).toBe('buyer@example.com');
    expect(mocks.getContactEmailMock).toHaveBeenCalledWith('did:imajin:buyer');
    expect(mocks.sqlMock).not.toHaveBeenCalled();
  });

  it('returns null when the kernel has no email for the DID', async () => {
    mocks.getContactEmailMock.mockResolvedValueOnce(null);

    expect(await getContactEmail('did:imajin:buyer', makeLog().asLogger)).toBeNull();
  });

  it('returns null and logs a warning when the lookup throws', async () => {
    mocks.getContactEmailMock.mockRejectedValueOnce(new Error('kernel down'));
    const { log, asLogger } = makeLog();

    const result = await getContactEmail('did:imajin:buyer', asLogger);

    expect(result).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('backfillContactEmail (#2058 — delegates to the kernel route)', () => {
  it('calls the kernel client with the did and email, and never touches sql directly', async () => {
    mocks.backfillContactEmailMock.mockResolvedValueOnce(true);
    const { log, asLogger } = makeLog();

    await backfillContactEmail('did:imajin:buyer', 'buyer@example.com', asLogger);

    expect(mocks.backfillContactEmailMock).toHaveBeenCalledWith('did:imajin:buyer', 'buyer@example.com');
    expect(mocks.sqlMock).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('logs a warning (non-fatal) when the kernel call fails, without throwing', async () => {
    mocks.backfillContactEmailMock.mockResolvedValueOnce(false);
    const { log, asLogger } = makeLog();

    await expect(
      backfillContactEmail('did:imajin:buyer', 'buyer@example.com', asLogger),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});
