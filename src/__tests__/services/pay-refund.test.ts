import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ payUrl: 'https://kernel.test/pay' as string | null }));
const fetchMock = vi.fn();

vi.mock('@/lib/kernel', () => ({
  serviceUrl: (service: string) => (service === 'pay' ? state.payUrl : null),
}));

import { requestPayRefund } from '@/services/pay-refund';

beforeEach(() => {
  state.payUrl = 'https://kernel.test/pay';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('PAY_SERVICE_API_KEY', 'pay-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('requestPayRefund', () => {
  it('POSTs the refund to the pay service with the bearer key', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const result = await requestPayRefund({ paymentId: 'pi_1', amount: 500 });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('https://kernel.test/pay/api/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer pay-key' },
      body: JSON.stringify({ paymentId: 'pi_1', amount: 500 }),
    });
  });

  it('calls a relative /api/refund when the pay service is not configured', async () => {
    state.payUrl = null;
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    await requestPayRefund({ paymentId: 'pi_1' });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/refund');
  });

  it('reports the status and body text when pay rejects the refund', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'Stripe error' });

    expect(await requestPayRefund({ paymentId: 'pi_1', reason: 'order refund' })).toEqual({
      ok: false,
      status: 500,
      text: 'Stripe error',
    });
  });

  it('propagates network failures to the caller', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(requestPayRefund({ paymentId: 'pi_1' })).rejects.toThrow('network down');
  });
});
