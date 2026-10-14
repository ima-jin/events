'use client';

import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from './api';

interface Resource<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/** Each resource is tied to its path; stale responses never replace a new viewer/event. */
export function useBuyerResource<T>(path: string | null, load: (path: string, signal: AbortSignal) => Promise<T>) {
  const [resource, setResource] = useState<Resource<T> & { path: string | null }>({
    path, data: null, loading: path !== null, error: null,
  });
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (path === null) return;
    const controller = new AbortController();
    setResource({ path, data: null, loading: true, error: null });
    load(path, controller.signal).then((data) => {
      if (!controller.signal.aborted) setResource({ path, data, loading: false, error: null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setResource({ path, data: null, loading: false, error: errorMessage(error) });
    });
    return () => controller.abort();
  }, [path, load, revision]);

  const current = resource.path === path ? resource : { data: null, loading: path !== null, error: null };
  return { ...current, retry };
}

export function useBuyerTab(hasOrders: boolean) {
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const syncHash = () => {
      const hash = globalThis.location.hash;
      if (hash === '#my-tickets' || hash === '#buy-tickets') setSelected(hash.slice(1));
    };
    syncHash();
    globalThis.addEventListener('hashchange', syncHash);
    return () => globalThis.removeEventListener('hashchange', syncHash);
  }, []);

  const select = (tab: string) => {
    setSelected(tab);
    globalThis.location.hash = tab;
  };
  return { active: selected ?? (hasOrders ? 'my-tickets' : 'buy-tickets'), select };
}
