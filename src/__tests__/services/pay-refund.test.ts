import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_TOKEN, getPayAppTokenMock, invalidatePayAppTokenMock, resetPayAppTokenMocks } from '../support/pay-app-token-support';

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
  resetPayAppTokenMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('requestPayRefund', () => {
  it('POSTs the refund to the pay service with events own app-service token', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const result = await requestPayRefund({ paymentId: 'pi_1', amount: 500 });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('https://kernel.test/pay/api/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${APP_TOKEN}` },
      body: JSON.stringify({ paymentId: 'pi_1', amount: 500 }),
      cache: 'no-store',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
  });

  it('fails closed when the pay service is not configured', async () => {
    state.payUrl = null;
    await expect(requestPayRefund({ paymentId: 'pi_1' })).rejects.toThrow('pay service URL is not configured');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getPayAppTokenMock).not.toHaveBeenCalled();
  });

  it('re-mints once after 401 without changing the refund body', async () => {
    getPayAppTokenMock.mockResolvedValueOnce('expired').mockResolvedValueOnce('fresh');
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}'));

    expect(await requestPayRefund({ paymentId: 'pi_1' })).toEqual({ ok: true });
    expect(invalidatePayAppTokenMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual(['Bearer expired', 'Bearer fresh']);
    expect(fetchMock.mock.calls[0][1].body).toBe(fetchMock.mock.calls[1][1].body);
  });

  it('stops after a second 401 even if invalidation fails', async () => {
    invalidatePayAppTokenMock.mockRejectedValue(new Error('provider lost'));
    fetchMock.mockImplementation(() => new Response('Unauthorized', { status: 401 }));
    expect(await requestPayRefund({ paymentId: 'pi_1' })).toEqual({ ok: false, status: 401, text: 'Unauthorized' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(invalidatePayAppTokenMock).toHaveBeenCalledOnce();
  });

  it.each(['scope not granted', 'payment was not created by this app'])('does not retry 403: %s', async (error) => {
    fetchMock.mockResolvedValue(new Response(error, { status: 403 }));
    const result = await requestPayRefund({ paymentId: 'pi_1' });
    expect(result).toMatchObject({
      ok: false, status: 403, text: expect.stringContaining('approve pay:refund'),
    });
    expect(result).toMatchObject({ text: expect.stringContaining(error) });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(invalidatePayAppTokenMock).not.toHaveBeenCalled();
  });

  it('fails closed without a token', async () => {
    getPayAppTokenMock.mockRejectedValue(new Error('not provisioned'));
    await expect(requestPayRefund({ paymentId: 'pi_1' })).rejects.toThrow('not provisioned');
    expect(fetchMock).not.toHaveBeenCalled();
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
