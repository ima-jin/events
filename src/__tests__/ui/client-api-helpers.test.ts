import { afterEach, describe, expect, it, vi } from 'vitest';
import { campaignRequest } from '@/hooks/campaign-api';
import { completeRegistration, readJson } from '@/components/buyer-tickets/api';
import { unlockTiers } from '@/components/tickets/checkout-api';
import { organizerPath, organizerRequest } from '@/components/organizer/organizer-data';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('existing client API prefix boundaries', () => {
  it.each(['', '/events'])('prefixes buyer, campaign, checkout and organizer paths once with basePath %j', async (base) => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', base);
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ tiers: [] })));
    vi.stubGlobal('fetch', fetch);
    await readJson('/api/events/event%2F1/my-ticket');
    await readJson('/api/tickets/ticket%2F1/qr');
    await completeRegistration('ticket/1', new AbortController().signal);
    await campaignRequest('/api/campaign/event%2F1/status');
    await campaignRequest('/api/campaign/event%2F1/my-pledge');
    await campaignRequest('/api/campaign/pledge', { eventId: 'event/1', amount: 2500 });
    await campaignRequest('/api/campaign/pledge/confirm', { pledgeId: 'pledge_1' });
    await unlockTiers('event/1', 'guest code');
    await organizerRequest(organizerPath('event/1', '/sales'));
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${base}/api/events/event%2F1/my-ticket`,
      `${base}/api/tickets/ticket%2F1/qr`,
      `${base}/api/register/ticket%2F1`,
      `${base}/api/campaign/event%2F1/status`,
      `${base}/api/campaign/event%2F1/my-pledge`,
      `${base}/api/campaign/pledge`,
      `${base}/api/campaign/pledge/confirm`,
      `${base}/api/events/event%2F1/tiers/unlock?code=guest%20code`,
      `${base}/api/events/event%2F1/sales`,
    ]);
  });
});
