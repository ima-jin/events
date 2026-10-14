// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { CampaignSection, type CampaignSectionProps } from '@/components/campaign/campaign-section';
import {
  campaignRoutes, elementsDouble, givenReturn, jsonResponse, loadStripeDouble,
  renderCampaign as renderCampaignComponent, requestBody, resetCampaign, stripeDouble, successIntent,
} from '../../support/campaign-ui-support';

vi.mock('@stripe/stripe-js', async () => ({
  loadStripe: (await import('../../support/campaign-ui-support')).loadStripeDouble,
}));
vi.mock('@stripe/react-stripe-js', async () =>
  (await import('../../support/campaign-ui-support')).stripeReactDouble);

beforeEach(resetCampaign);
function renderCampaign(props: Partial<CampaignSectionProps> = {}) {
  return renderCampaignComponent(CampaignSection, props);
}

async function startSetup(user: ReturnType<typeof renderCampaign>['user']) {
  await user.click(await screen.findByRole('button', { name: '$25' }));
  await user.click(screen.getByRole('button', { name: 'Continue to card setup' }));
  await screen.findByLabelText('Secure card form');
}

describe('campaign display and availability', () => {
  it('prefixes API requests when mounted below a base path', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
    const fetch = campaignRoutes();
    renderCampaign();
    await screen.findByRole('progressbar');
    expect(fetch.mock.calls[0][0]).toBe('/events/api/campaign/evt_1/status');
  });
  it('shows campaign progress and deadline and gates unauthenticated pledges', async () => {
    const fetch = campaignRoutes();
    renderCampaign({ isAuthenticated: false });
    expect((await screen.findByRole('progressbar')).getAttribute('value')).toBe('25');
    expect(screen.getByText(/Campaign deadline/)).toBeTruthy();
    expect(screen.getByText('Sign in to pledge.')).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('my-pledge'))).toBe(false);
  });

  it.each([
    { deadline: '2000-01-01T00:00:00Z' },
    { isFullyFunded: true },
  ])('closes an expired or fully funded campaign %j', async (status) => {
    campaignRoutes(status);
    renderCampaign();
    expect(await screen.findByText('Campaign closed for new pledges.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '$25' })).toBeNull();
  });

  it('closes non-published events', async () => {
    campaignRoutes();
    renderCampaign({ eventStatus: 'cancelled' });
    expect(await screen.findByText('Campaign closed for new pledges.')).toBeTruthy();
  });

  it.each(['pending', 'failed', 'cancelled', 'refunded'])('does not call %s pledges confirmed', async (status) => {
    campaignRoutes({}, { id: 'plg_1', amount: 2500, status });
    renderCampaign();
    expect(await screen.findByText(new RegExp(`Your pledge:.*${status}`))).toBeTruthy();
    expect(screen.queryByText(/Your card is saved/)).toBeNull();
    expect(screen.getByRole('button', { name: '$25' })).toBeTruthy();
  });

  it.each(['confirmed', 'charged'])('does not allow duplicate %s pledges', async (status) => {
    campaignRoutes({}, { id: 'plg_1', amount: 2500, status });
    renderCampaign();
    await screen.findByText(new RegExp(`Your pledge:.*${status}`));
    expect(screen.queryByRole('button', { name: '$25' })).toBeNull();
  });

  it.each(['/status', '/my-pledge'])('fails closed and can retry %s read failures', async (path) => {
    const fetch = campaignRoutes({}, null, { [path]: jsonResponse({}, 500) });
    const { user } = renderCampaign();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '$25' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Retry campaign' }));
    await waitFor(() => expect(fetch.mock.calls.filter(([url]) => String(url).includes(path)).length).toBe(2));
  });
});

describe('pledge and card setup', () => {
  it('refreshes funding totals after confirmation without rereading and erasing the own pledge', async () => {
    let reads = 0;
    const fetch = campaignRoutes({}, null, {
      '/status': () => {
        reads += 1;
        return jsonResponse({
          targetAmount: 10000, currentAmount: reads * 2500, pledgeCount: reads,
          deadline: null, percentFunded: reads * 25, isFullyFunded: false,
        });
      },
    });
    const { user } = renderCampaign();
    await startSetup(user);
    await user.click(screen.getByRole('button', { name: 'Save card and confirm pledge' }));
    await screen.findByText(/Your card is saved/);
    await waitFor(() => expect(screen.getByRole('progressbar').getAttribute('value')).toBe('50'));
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/my-pledge'))).toHaveLength(1);
  });
  it('creates the selected pledge, mounts Payment Element and confirms with all server identifiers', async () => {
    const fetch = campaignRoutes();
    const { user } = renderCampaign();
    await startSetup(user);
    expect(requestBody(fetch, '/pledge')).toEqual({ eventId: 'evt_1', amount: 2500 });
    expect(globalThis.sessionStorage.getItem('events.campaign.setup')).not.toContain('secret');
    await user.click(screen.getByRole('button', { name: 'Save card and confirm pledge' }));
    expect(await screen.findByText(/Your card is saved/)).toBeTruthy();
    expect(elementsDouble.submit).toHaveBeenCalledOnce();
    expect(stripeDouble.confirmSetup).toHaveBeenCalledWith(expect.objectContaining({
      elements: elementsDouble, redirect: 'if_required',
    }));
    expect(requestBody(fetch, '/pledge/confirm')).toEqual({
      pledgeId: 'plg_1', setupIntentId: 'seti_1', paymentMethodId: 'pm_1',
    });
    expect(globalThis.sessionStorage.getItem('events.campaign.setup')).toBeNull();
  });

  it('accepts exact custom decimal amounts', async () => {
    const fetch = campaignRoutes();
    const { user } = renderCampaign();
    await user.type(await screen.findByLabelText('Pledge amount (CAD)'), '12.34');
    await user.click(screen.getByRole('button', { name: 'Continue to card setup' }));
    await screen.findByLabelText('Secure card form');
    expect(requestBody(fetch, '/pledge').amount).toBe(1234);
  });

  it.each(['0.99', '-10', '1.001', '1e3', 'Infinity', '999999999999999999'])('rejects invalid amount %s', async (amount) => {
    const fetch = campaignRoutes();
    const { user } = renderCampaign();
    await user.type(await screen.findByLabelText('Pledge amount (CAD)'), amount);
    await user.click(screen.getByRole('button', { name: 'Continue to card setup' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) => String(url) === '/api/campaign/pledge')).toBe(false);
  });

  it('reports pledge creation failures without displaying server payloads', async () => {
    campaignRoutes({}, null, { '/pledge': jsonResponse({ error: 'private-secret' }, 500) });
    const { user } = renderCampaign();
    await user.click(await screen.findByRole('button', { name: '$25' }));
    await user.click(screen.getByRole('button', { name: 'Continue to card setup' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/private-secret/)).toBeNull();
  });

  it.each(['missing config', 'failed loader'])('does not create a pledge for %s', async (failure) => {
    if (failure === 'missing config') vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', '');
    else loadStripeDouble.mockResolvedValue(null);
    const fetch = campaignRoutes();
    const { user } = renderCampaign();
    await user.click(await screen.findByRole('button', { name: '$25' }));
    await user.click(screen.getByRole('button', { name: 'Continue to card setup' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) => String(url) === '/api/campaign/pledge')).toBe(false);
  });

  it.each(['stripe error', 'stripe throws', 'validation error', 'processing', 'missing payment method'])(
    'does not confirm after %s', async (failure) => {
      if (failure === 'stripe error') stripeDouble.confirmSetup.mockResolvedValue({ error: { message: 'secret' } });
      if (failure === 'stripe throws') stripeDouble.confirmSetup.mockRejectedValue(new Error('secret'));
      if (failure === 'validation error') elementsDouble.submit.mockResolvedValue({ error: { message: 'invalid' } });
      if (failure === 'processing') stripeDouble.confirmSetup.mockResolvedValue({ setupIntent: { ...successIntent, status: 'processing' } });
      if (failure === 'missing payment method') stripeDouble.confirmSetup.mockResolvedValue({ setupIntent: { ...successIntent, payment_method: null } });
      const fetch = campaignRoutes();
      const { user } = renderCampaign();
      await startSetup(user);
      await user.click(screen.getByRole('button', { name: 'Save card and confirm pledge' }));
      expect(await screen.findByRole('alert')).toBeTruthy();
      expect(fetch.mock.calls.some(([url]) => String(url).includes('/pledge/confirm'))).toBe(false);
      expect(screen.queryByText(/secret/)).toBeNull();
    },
  );

  it('retries only the server confirmation after a successful Stripe setup', async () => {
    let attempts = 0;
    const fetch = campaignRoutes({}, null, {
      '/pledge/confirm': () => {
        attempts += 1;
        return attempts === 1 ? jsonResponse({}, 500) : jsonResponse({
          success: true, pledge: { id: 'plg_1', amount: 2500, status: 'confirmed' },
        });
      },
    });
    const { user } = renderCampaign();
    await startSetup(user);
    await user.click(screen.getByRole('button', { name: 'Save card and confirm pledge' }));
    await user.click(await screen.findByRole('button', { name: 'Retry confirmation' }));
    expect(await screen.findByText(/Your card is saved/)).toBeTruthy();
    expect(stripeDouble.confirmSetup).toHaveBeenCalledOnce();
    expect(fetch.mock.calls.filter(([url]) => String(url) === '/api/campaign/pledge')).toHaveLength(1);
  });
});

describe('Stripe redirect return', () => {
  it('reconciles only the bound own pending pledge and scrubs the return secret', async () => {
    givenReturn();
    const fetch = campaignRoutes({}, { id: 'plg_1', amount: 2500, status: 'pending' });
    renderCampaign();
    expect(await screen.findByText(/Your card is saved/)).toBeTruthy();
    expect(stripeDouble.retrieveSetupIntent).toHaveBeenCalledWith('seti_1_secret_example');
    expect(requestBody(fetch, '/pledge/confirm').pledgeId).toBe('plg_1');
    expect(globalThis.location.search).toBe('?keep=yes');
    expect(stripeDouble.confirmSetup).not.toHaveBeenCalled();
  });

  it.each([
    { pledgeId: 'other_pledge' }, { eventId: 'other_event' },
    { setupIntentId: 'seti_other' }, { createdAt: 1 },
  ])('rejects unrelated or expired redirect binding %j', async (binding) => {
    givenReturn(binding);
    campaignRoutes({}, { id: 'plg_1', amount: 2500, status: 'pending' });
    renderCampaign();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(stripeDouble.retrieveSetupIntent).not.toHaveBeenCalled();
    expect(globalThis.location.search).toBe('?keep=yes');
  });

  it.each(['confirmed', 'failed', 'charged'])('never reconciles an own %s pledge', async (status) => {
    givenReturn();
    const fetch = campaignRoutes({}, { id: 'plg_1', amount: 2500, status });
    renderCampaign();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/pledge/confirm'))).toBe(false);
  });

  it('does not reconcile a guest return and still removes the URL secret', async () => {
    givenReturn();
    campaignRoutes();
    renderCampaign({ isAuthenticated: false });
    await screen.findByText('Sign in to pledge.');
    expect(globalThis.location.search).toBe('?keep=yes');
    expect(stripeDouble.retrieveSetupIntent).not.toHaveBeenCalled();
  });

  it('does not trust the redirect succeeded query when Stripe reports failure', async () => {
    givenReturn();
    stripeDouble.retrieveSetupIntent.mockResolvedValue({ error: { message: 'bad' } });
    const fetch = campaignRoutes({}, { id: 'plg_1', amount: 2500, status: 'pending' });
    renderCampaign();
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/pledge/confirm'))).toBe(false);
  });
});
