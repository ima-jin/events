const SAVE_FAILED = 'Unable to save. Check your permissions and fields, then retry.';

export class OrganizerRequestError extends Error {
  constructor(message: string, readonly setupUrl: string | null = null, readonly retryable = false) {
    super(message);
    this.name = 'OrganizerRequestError';
  }
}

export function safeSetupUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function organizerError(data: unknown, fallback = SAVE_FAILED): OrganizerRequestError {
  if (typeof data !== 'object' || data === null) return new OrganizerRequestError(fallback);
  const body = data as Record<string, unknown>;
  const setupUrl = safeSetupUrl(body.setupUrl);
  if (body.code === 'SELLER_NO_CARD_RAIL') {
    return new OrganizerRequestError('Paid tickets need card payments or e-Transfer before publishing. Set up card payments or add a payment email, then retry.', setupUrl);
  }
  if (body.retryable === true) {
    return new OrganizerRequestError('Payment readiness could not be checked. Your confirmed saves are retained. Please retry.', setupUrl, true);
  }
  return new OrganizerRequestError(fallback);
}
