import { withBasePath } from '@/lib/base-path';

export function organizerPath(eventId: string, suffix = ''): string {
  return withBasePath(`/api/events/${encodeURIComponent(eventId)}${suffix}`);
}

export async function organizerRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', ...init });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(typeof data.error === 'string' ? data.error : 'Request failed. Please try again.');
  }
  return data as T;
}

export function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return '—';
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency: currency ?? 'CAD' }).format(amount / 100);
  } catch {
    return `${(amount / 100).toFixed(2)} ${currency ?? 'CAD'}`;
  }
}

export function identityLabel(name?: string | null, handle?: string | null, email?: string | null, did?: string | null): string {
  if (name) return name;
  if (handle) return `@${handle}`;
  return email || did || 'Unknown guest';
}

export const PANEL_CLASS = 'rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800 [&_button]:rounded [&_button]:border [&_button]:border-gray-300 [&_button]:px-3 [&_button]:py-2 [&_button]:text-sm [&_button]:disabled:opacity-50';
export const INPUT_CLASS = 'rounded border border-gray-300 bg-transparent px-3 py-2 dark:border-gray-600';
