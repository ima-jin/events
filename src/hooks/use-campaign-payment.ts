'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { SetupIntent } from '@stripe/stripe-js';
import { campaignRequest, type CampaignPledge } from './campaign-api';
import {
  CAMPAIGN_RETURN_KEY, campaignStripe, confirmationFor, readCampaignReturn, rememberCampaignSetup, reconcileCampaignReturn,
  type CampaignConfirmation, type CampaignSetup,
} from './campaign-stripe';

export function useCampaignPayment(
  eventId: string,
  ownPledge: CampaignPledge | null,
  ready: boolean,
  onConfirmed: (pledge: CampaignPledge) => void,
) {
  const [setup, setSetup] = useState<CampaignSetup | null>(null);
  const [confirmation, setConfirmation] = useState<CampaignConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [returnInfo, setReturnInfo] = useState<ReturnType<typeof readCampaignReturn>>(null);
  const handledReturn = useRef(false);

  useEffect(() => { setReturnInfo(readCampaignReturn()); }, []);

  const confirm = useCallback(async (details: CampaignConfirmation) => {
    setConfirmation(details);
    setBusy(true);
    setError('');
    try {
      const result = await campaignRequest<{ success: boolean; pledge: CampaignPledge }>(
        '/api/campaign/pledge/confirm', details,
      );
      if (!result.success || result.pledge.status !== 'confirmed') throw new Error('Not confirmed');
      globalThis.sessionStorage.removeItem(CAMPAIGN_RETURN_KEY);
      setSetup(null);
      setConfirmation(null);
      onConfirmed(result.pledge);
    } catch {
      setError('Could not confirm your pledge. Retry confirmation; your card setup will not be repeated.');
    } finally {
      setBusy(false);
    }
  }, [onConfirmed]);

  useEffect(() => {
    if (!returnInfo || !ready || handledReturn.current) return;
    handledReturn.current = true;
    const returned = returnInfo;
    const pledge = ownPledge;
    async function reconcile() {
      setBusy(true);
      try {
        await confirm(await reconcileCampaignReturn(eventId, pledge, returned));
      } catch {
        setError('Could not reconcile the payment return with your pending pledge. Please retry payment setup.');
      } finally {
        setBusy(false);
        setReturnInfo(null);
      }
    }
    void reconcile();
  }, [returnInfo, ready, eventId, ownPledge, confirm]);

  async function create(amount: number) {
    setBusy(true);
    setError('');
    try {
      const stripe = await campaignStripe();
      if (!stripe) throw new Error('Unavailable Stripe');
      const result = await campaignRequest<CampaignSetup>('/api/campaign/pledge', { eventId, amount });
      if (!result.pledgeId || !result.clientSecret) throw new Error('Invalid setup');
      rememberCampaignSetup(eventId, result);
      setSetup(result);
    } catch {
      setError('Could not start card setup. Check payment configuration and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function complete(intent: SetupIntent) {
    if (!setup) return;
    try {
      await confirm(confirmationFor(setup.pledgeId, intent));
    } catch {
      setError('Card setup is not complete. Please try again.');
    }
  }

  return { setup, confirmation, busy, error, create, complete, retry: () => confirmation && confirm(confirmation) };
}
