import { loadStripe, type SetupIntent } from '@stripe/stripe-js';
import type { CampaignPledge } from './campaign-api';
import { isStripePublishableKey } from '@/lib/stripe-publishable-key';

export const CAMPAIGN_RETURN_KEY = 'events.campaign.setup';

export function campaignStripe(publishableKey: unknown) {
  return isStripePublishableKey(publishableKey) ? loadStripe(publishableKey) : null;
}

export interface CampaignSetup {
  pledgeId: string;
  clientSecret: string;
  publishableKey: string;
}

export interface CampaignConfirmation {
  pledgeId: string;
  setupIntentId: string;
  paymentMethodId: string;
}

export function confirmationFor(pledgeId: string, intent: SetupIntent): CampaignConfirmation {
  const method = intent.payment_method;
  const paymentMethodId = typeof method === 'string' ? method : method?.id;
  if (intent.status !== 'succeeded' || !paymentMethodId) {
    throw new Error('Card setup is not complete. Please try again.');
  }
  return { pledgeId, setupIntentId: intent.id, paymentMethodId };
}

export function rememberCampaignSetup(eventId: string, pledgeId: string, setupIntentId: string, publishableKey: string) {
  // Bind the account's public key for redirect retrieval; never persist a client secret.
  globalThis.sessionStorage.setItem(CAMPAIGN_RETURN_KEY, JSON.stringify({
    eventId, pledgeId, setupIntentId, publishableKey, createdAt: Date.now(),
  }));
}

export function readCampaignReturn() {
  const url = new URL(globalThis.location.href);
  const secret = url.searchParams.get('setup_intent_client_secret');
  const setupIntentId = url.searchParams.get('setup_intent');
  if (!secret && !setupIntentId) return null;
  for (const key of ['setup_intent_client_secret', 'setup_intent', 'redirect_status']) {
    url.searchParams.delete(key);
  }
  globalThis.history.replaceState(globalThis.history.state, '', url);
  return { secret, setupIntentId };
}

function validateReturnBinding(eventId: string, pledge: CampaignPledge | null, setupIntentId: string | null) {
  const binding = JSON.parse(globalThis.sessionStorage.getItem(CAMPAIGN_RETURN_KEY) ?? 'null');
  if (pledge?.status !== 'pending') throw new Error('No pending pledge');
  if (binding?.eventId !== eventId || binding.pledgeId !== pledge.id) throw new Error('Unmatched pledge');
  if (!setupIntentId || binding.setupIntentId !== setupIntentId) throw new Error('Unmatched setup');
  const age = Date.now() - binding.createdAt;
  if (!Number.isFinite(binding.createdAt) || age < 0 || age > 3_600_000) throw new Error('Expired binding');
  if (!isStripePublishableKey(binding.publishableKey)) throw new Error('Missing seller account');
  return { pledgeId: pledge.id, publishableKey: binding.publishableKey };
}

export async function reconcileCampaignReturn(
  eventId: string, pledge: CampaignPledge | null, returned: NonNullable<ReturnType<typeof readCampaignReturn>>,
) {
  const { pledgeId, publishableKey } = validateReturnBinding(eventId, pledge, returned.setupIntentId);
  if (!returned.secret?.startsWith(`${returned.setupIntentId}_secret_`)) throw new Error('Unmatched secret');
  const stripe = await campaignStripe(publishableKey);
  if (!stripe) throw new Error('Unavailable Stripe');
  const result = await stripe.retrieveSetupIntent(returned.secret);
  if (result.error || result.setupIntent?.id !== returned.setupIntentId) {
    throw new Error('Invalid setup');
  }
  return confirmationFor(pledgeId, result.setupIntent);
}
