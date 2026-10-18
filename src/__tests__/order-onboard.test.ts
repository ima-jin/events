import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claimOrderOnboard: vi.fn(),
  sendOrderOnboard: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('@/repositories/orders-repository', () => ({ claimOrderOnboard: mocks.claimOrderOnboard }));
vi.mock('@/lib/kernel', () => ({ sendOrderOnboard: mocks.sendOrderOnboard }));
vi.mock('@ima-jin/logger', () => ({ createLogger: () => ({ warn: mocks.warn }) }));

import { requestOrderOnboard } from '@/lib/order-onboard';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.claimOrderOnboard.mockResolvedValue('tx_stored');
  mocks.sendOrderOnboard.mockResolvedValue(true);
});

describe('private order onboarding', () => {
  it('sends exactly the reference from the confirmed stored order claim', async () => {
    await requestOrderOnboard('ord_local');
    expect(mocks.claimOrderOnboard).toHaveBeenCalledWith('ord_local');
    expect(mocks.sendOrderOnboard).toHaveBeenCalledTimes(1);
    expect(mocks.sendOrderOnboard).toHaveBeenCalledWith('tx_stored');
  });

  it('does not call the kernel without an order', async () => {
    await requestOrderOnboard(null);
    expect(mocks.claimOrderOnboard).not.toHaveBeenCalled();
    expect(mocks.sendOrderOnboard).not.toHaveBeenCalled();
  });

  it('does not manufacture a reference when the stored order is ineligible or already claimed', async () => {
    mocks.claimOrderOnboard.mockResolvedValue(null);
    await requestOrderOnboard('ord_local');
    expect(mocks.sendOrderOnboard).not.toHaveBeenCalled();
  });

  it('makes no automatic retry after refusal', async () => {
    mocks.sendOrderOnboard.mockResolvedValue(false);
    await expect(requestOrderOnboard('ord_local')).resolves.toBeUndefined();
    expect(mocks.sendOrderOnboard).toHaveBeenCalledTimes(1);
  });

  it('does not send again when a resend sees the already-claimed stored order', async () => {
    mocks.claimOrderOnboard.mockResolvedValueOnce('tx_stored').mockResolvedValueOnce(null);
    await requestOrderOnboard('ord_local');
    await requestOrderOnboard('ord_local');
    expect(mocks.sendOrderOnboard).toHaveBeenCalledTimes(1);
  });

  it('contains unavailable transport and storage failures without logging response details', async () => {
    mocks.sendOrderOnboard.mockRejectedValue(new Error('private provider details'));
    await expect(requestOrderOnboard('ord_local')).resolves.toBeUndefined();
    mocks.claimOrderOnboard.mockRejectedValue(new Error('database unavailable'));
    await expect(requestOrderOnboard('ord_local')).resolves.toBeUndefined();
    expect(mocks.warn).toHaveBeenCalledWith({ orderId: 'ord_local' }, expect.any(String));
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain('private provider details');
  });
});
