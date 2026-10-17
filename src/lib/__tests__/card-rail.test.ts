import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/kernel', () => ({ kernelBaseUrl: vi.fn(), serviceUrl: vi.fn() }));

import { kernelBaseUrl, serviceUrl } from '@/lib/kernel';
import { cardRailCheckUrl, getCardRailReadiness } from '@/lib/card-rail';

const BASE = 'https://kernel.test';
const PAY = `${BASE}/pay`;
const SETUP = `${BASE}/auth/connectors/stripe`;
const DID = 'did:imajin:creator?x=1&other';
const fetchMock = vi.fn();

beforeEach(() => {
  vi.mocked(kernelBaseUrl).mockReturnValue(BASE);
  vi.mocked(serviceUrl).mockReturnValue(PAY);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('public card readiness', () => {
  it('encodes the seller DID and respects the configured pay service', () => {
    expect(cardRailCheckUrl(DID)).toBe(`${PAY}/api/card-rail/check?did=${encodeURIComponent(DID)}`);
    expect(serviceUrl).toHaveBeenCalledWith('pay');
  });

  it.each([true, false])('accepts only a boolean readiness (%s), uncached and without credentials', async (cardEnabled) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ cardEnabled, extra: 'ignored' }) });
    const timeout = vi.spyOn(AbortSignal, 'timeout');

    expect(await getCardRailReadiness(DID)).toEqual({ cardEnabled, setupUrl: SETUP });
    expect(timeout).toHaveBeenCalledWith(5000);
    expect(fetchMock).toHaveBeenCalledWith(cardRailCheckUrl(DID), {
      cache: 'no-store', signal: expect.any(AbortSignal),
    });
    expect(fetchMock.mock.calls[0][1]).not.toHaveProperty('headers');
  });

  it.each([null, [], {}, { cardEnabled: 'true' }, { cardEnabled: 1 }, { cardEnabled: null }])(
    'treats a malformed response (%j) as unavailable', async (data) => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => data });
      expect(await getCardRailReadiness(DID)).toEqual({ cardEnabled: null, setupUrl: SETUP });
    },
  );

  it.each([400, 401, 404, 429, 500, 503])('fails closed on HTTP %s', async (status) => {
    const json = vi.fn();
    fetchMock.mockResolvedValue({ ok: false, status, json });
    expect(await getCardRailReadiness(DID)).toEqual({ cardEnabled: null, setupUrl: SETUP });
    expect(json).not.toHaveBeenCalled();
  });

  it.each([new Error('unreachable'), new DOMException('timed out', 'TimeoutError')])(
    'treats a failed or timed-out request as unavailable', async (error) => {
      fetchMock.mockRejectedValue(error);
      expect(await getCardRailReadiness(DID)).toEqual({ cardEnabled: null, setupUrl: SETUP });
    },
  );

  it('treats invalid JSON as unavailable', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } });
    expect(await getCardRailReadiness(DID)).toEqual({ cardEnabled: null, setupUrl: SETUP });
  });

  it('does not fetch when pay is not configured', async () => {
    vi.mocked(serviceUrl).mockReturnValue(null);
    expect(cardRailCheckUrl(DID)).toBeNull();
    expect(await getCardRailReadiness(DID)).toEqual({ cardEnabled: null, setupUrl: SETUP });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not invent a setup URL when the kernel base is not configured', async () => {
    vi.mocked(kernelBaseUrl).mockReturnValue(null);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ cardEnabled: false }) });
    expect(await getCardRailReadiness(DID)).toEqual({ cardEnabled: false, setupUrl: null });
  });
});
