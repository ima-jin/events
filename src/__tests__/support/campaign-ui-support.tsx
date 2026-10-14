import { useEffect, type ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import type { CampaignSection, CampaignSectionProps } from '@/components/campaign/campaign-section';
import { jsonResponse, mockFetch } from './ui-support';
import type { CampaignPledge, CampaignStatus } from '@/hooks/campaign-api';

export { jsonResponse, mockFetch, requestBody } from './ui-support';

export const stripeDouble = {
  confirmSetup: vi.fn(),
  retrieveSetupIntent: vi.fn(),
};
export const elementsDouble = { submit: vi.fn() };
export const loadStripeDouble = vi.fn();
export const successIntent = { id: 'seti_1', status: 'succeeded', payment_method: 'pm_1' };

export const stripeReactDouble = {
  Elements: ({ children }: Readonly<{ children: ReactNode }>) => children,
  PaymentElement: ({ onReady }: Readonly<{ onReady: () => void }>) => {
    useEffect(() => { onReady(); }, [onReady]);
    return <div aria-label="Secure card form">Payment Element</div>;
  },
  useStripe: () => stripeDouble,
  useElements: () => elementsDouble,
};

export function resetCampaign() {
  vi.stubEnv('NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'pk_test_example');
  vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '');
  globalThis.history.replaceState(null, '', '/evt_1');
  globalThis.sessionStorage.clear();
  loadStripeDouble.mockReset().mockResolvedValue(stripeDouble);
  stripeDouble.confirmSetup.mockReset().mockResolvedValue({ setupIntent: successIntent });
  stripeDouble.retrieveSetupIntent.mockReset().mockResolvedValue({ setupIntent: successIntent });
  elementsDouble.submit.mockReset().mockResolvedValue({});
}

export function campaignRoutes(
  status: Partial<CampaignStatus> = {},
  pledge: CampaignPledge | null = null,
  overrides: Parameters<typeof mockFetch>[0] = {},
) {
  return mockFetch({
    '/status': jsonResponse({
      targetAmount: 10000, currentAmount: 2500, pledgeCount: 2,
      deadline: '2099-01-01T00:00:00Z', percentFunded: 25, isFullyFunded: false, ...status,
    }),
    '/my-pledge': jsonResponse({ pledge }),
    '/pledge/confirm': jsonResponse({ success: true, pledge: { id: 'plg_1', amount: 2500, status: 'confirmed' } }),
    '/pledge': jsonResponse({ pledgeId: 'plg_1', clientSecret: 'seti_1_secret_example' }),
    ...overrides,
  });
}

export function renderCampaign(Component: typeof CampaignSection, props: Partial<CampaignSectionProps> = {}) {
  return {
    user: userEvent.setup(),
    ...render(<Component eventId="evt_1" eventTitle="Community show" isAuthenticated {...props} />),
  };
}

export function givenReturn(binding: Record<string, unknown> = {}) {
  globalThis.sessionStorage.setItem('events.campaign.setup', JSON.stringify({
    eventId: 'evt_1', pledgeId: 'plg_1', setupIntentId: 'seti_1', createdAt: Date.now(), ...binding,
  }));
  globalThis.history.replaceState(null, '',
    '/evt_1?setup_intent=seti_1&setup_intent_client_secret=seti_1_secret_example&redirect_status=succeeded&keep=yes');
}

export async function startSetup(user: ReturnType<typeof renderCampaign>['user']) {
  await user.click(await screen.findByRole('button', { name: '$25' }));
  await user.click(screen.getByRole('button', { name: 'Continue to card setup' }));
  await screen.findByLabelText('Secure card form');
}
