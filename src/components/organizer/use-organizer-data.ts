'use client';

import { useEffect, useState } from 'react';
import { organizerRequest } from './organizer-data';

export function useOrganizerData<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    organizerRequest<T>(path, { signal: controller.signal })
      .then((result) => { if (active) setData(result); })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Request failed. Please try again.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => {
      active = false;
      controller.abort();
    };
  }, [path, attempt]);

  return { data, setData, error, loading, retry: () => setAttempt((value) => value + 1) };
}
