'use client';

import { useCallback, useEffect, useState } from 'react';
import { campaignRequest, type CampaignPledge, type CampaignStatus } from './campaign-api';

export function useCampaign(eventId: string, isAuthenticated: boolean) {
  const [status, setStatus] = useState<CampaignStatus | null>(null);
  const [pledge, setPledge] = useState<CampaignPledge | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [nextStatus, own] = await Promise.all([
        campaignRequest<CampaignStatus>(`/api/campaign/${encodeURIComponent(eventId)}/status`),
        isAuthenticated
          ? campaignRequest<{ pledge: CampaignPledge | null }>(`/api/campaign/${encodeURIComponent(eventId)}/my-pledge`)
          : Promise.resolve({ pledge: null }),
      ]);
      setStatus(nextStatus);
      setPledge(own.pledge);
    } catch {
      // Fail closed: an unavailable own-pledge read must not enable duplicate pledges.
      setError('Could not load campaign or your pledge. Please retry.');
    } finally {
      setLoading(false);
    }
  }, [eventId, isAuthenticated]);
  useEffect(() => { void refresh(); }, [refresh]);
  const confirmed = useCallback((nextPledge: CampaignPledge) => {
    setPledge(nextPledge);
    // Refresh totals independently: a delayed own-pledge projection must not erase confirmation.
    void campaignRequest<CampaignStatus>(`/api/campaign/${encodeURIComponent(eventId)}/status`)
      .then(setStatus).catch(() => setError('Your pledge is confirmed, but campaign totals could not refresh. Please retry.'));
  }, [eventId]);
  return { status, pledge, confirmed, loading, error, refresh };
}
