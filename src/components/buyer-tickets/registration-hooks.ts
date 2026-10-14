'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { completeRegistration, errorMessage } from './api';

export function useTicketRegistration(ticketId: string, onComplete: () => void) {
  const controller = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  const complete = useCallback(async () => {
    if (controller.current) return;
    const attempt = new AbortController();
    controller.current = attempt;
    setBusy(true);
    setError(null);
    try {
      await completeRegistration(ticketId, attempt.signal);
      if (!attempt.signal.aborted) onComplete();
    } catch (error_) {
      if (!attempt.signal.aborted) setError(errorMessage(error_));
    } finally {
      controller.current = null;
      if (!attempt.signal.aborted) setBusy(false);
    }
  }, [ticketId, onComplete]);

  return { busy, error, complete };
}

/** Completion messages must come from this ticket's iframe on its configured origin. */
export function useRegistrationMessages(
  embedUrl: string | null,
  complete: () => Promise<void>,
) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(600);
  useEffect(() => {
    if (!embedUrl) return;
    const expectedOrigin = new URL(embedUrl, globalThis.location.href).origin;
    const receive = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin || event.source !== iframe.current?.contentWindow) return;
      const data = event.data;
      if (data?.type === 'survey-height' && typeof data.height === 'number' && Number.isFinite(data.height)) {
        setHeight(Math.max(400, Math.min(1200, data.height + 40)));
      }
      // On-load FYI messages have no answers and must not re-register or close a review form.
      if (data?.type === 'survey-completed' && data.answers != null) void complete();
    };
    globalThis.addEventListener('message', receive);
    return () => globalThis.removeEventListener('message', receive);
  }, [embedUrl, complete]);
  return { iframe, height };
}
