// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { completeRegistration, errorMessage, readJson } from '@/components/buyer-tickets/api';
import { jsonResponse, mockFetch } from '../support/ui-support';

describe('buyer ticket API helpers', () => {
  it.each([404, 500])('retries a transient %s then succeeds with bounded backoff', async (status) => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetchSpy = mockFetch({ '/register/': () => {
      attempts++;
      return jsonResponse({}, attempts === 1 ? status : 200);
    } });
    const result = completeRegistration('ticket/1', new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledWith('/api/register/ticket%2F1', expect.anything());
  });

  it('retries network failures and stops after the third attempt', async () => {
    vi.useFakeTimers();
    const fetchSpy = mockFetch({ '/register/': () => { throw new Error('Offline'); } });
    const result = expect(completeRegistration('ticket', new AbortController().signal)).rejects.toThrow('Offline');
    await vi.runAllTimersAsync();
    await result;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('surfaces the last server failure and does not retry other client errors', async () => {
    vi.useFakeTimers();
    const fetchSpy = mockFetch({ '/register/': () => jsonResponse({}, 500) });
    const result = expect(completeRegistration('ticket', new AbortController().signal)).rejects.toThrow('Registration failed');
    await vi.runAllTimersAsync();
    await result;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const clientSpy = mockFetch({ '/register/': () => new Response('not json', { status: 403 }) });
    await expect(completeRegistration('ticket', new AbortController().signal)).rejects.toThrow('Registration failed');
    expect(clientSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry once its caller has aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchSpy = mockFetch({ '/register/': () => { throw new Error('Aborted'); } });
    await expect(completeRegistration('ticket', controller.signal)).rejects.toThrow('Aborted');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('provides useful errors without assuming every rejection is an Error', async () => {
    mockFetch({ '/api/test': () => jsonResponse({}, 503) });
    await expect(readJson('/api/test')).rejects.toThrow('Request failed (503)');
    expect(errorMessage('unknown')).toBe('Something went wrong. Please try again.');
  });
});
