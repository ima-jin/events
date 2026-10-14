import { withBasePath } from '@/lib/base-path';
import type { BuyerOrder, BuyerTicket } from '@/lib/buyer-tickets';

export interface BuyerTicketsResponse {
  orders: BuyerOrder[];
  registrationEmbedBaseUrl: string | null;
}

export function canPresentQr(ticket: BuyerTicket): boolean {
  return (ticket.status === 'valid' || ticket.status === 'used') && ticket.registrationStatus !== 'pending';
}

export async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(path), { cache: 'no-store', ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
async function registrationAttempt(path: string, signal: AbortSignal, lastAttempt: boolean): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(path, { method: 'POST', signal });
  } catch (error) {
    if (lastAttempt || signal.aborted) throw error;
    return false;
  }
  if (response.ok || response.status === 409) return true;
  const data = await response.json().catch(() => ({}));
  const retryable = response.status === 404 || response.status >= 500;
  if (!retryable || lastAttempt) throw new Error(data.error || 'Registration failed');
  return false;
}

/** Survey persistence can race the completion message; preserve the kernel's bounded retries. */
export async function completeRegistration(ticketId: string, signal: AbortSignal): Promise<void> {
  const path = withBasePath(`/api/register/${encodeURIComponent(ticketId)}`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (await registrationAttempt(path, signal, attempt === 3)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    signal.throwIfAborted();
  }
}
