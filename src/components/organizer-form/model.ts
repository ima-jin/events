import { toInstant, zonedDateTime } from './dates';
import type { EventFormEvent, EventFormProps, EventFormTier, FormDetails, TierDraft } from './types';

function text(value?: string | null): string {
  return value ?? '';
}

function initialLocation(event?: EventFormEvent) {
  return {
    locationType: event?.locationType || (event?.isVirtual ? 'virtual' as const : 'physical' as const),
    virtualUrl: text(event?.virtualUrl), venue: text(event?.venue), address: text(event?.address),
    city: text(event?.city), country: text(event?.country), imageUrl: text(event?.imageUrl),
  };
}

export function initialDetails(props: Readonly<EventFormProps>): FormDetails {
  const event = props.event;
  const timezone = event?.timezone || 'UTC';
  return {
    title: text(event?.title), tagline: '', description: text(event?.description),
    startsAt: event ? zonedDateTime(event.startsAt, timezone) : '',
    endsAt: event?.endsAt ? zonedDateTime(event.endsAt, timezone) : '',
    timezone, ...initialLocation(event),
    courseSlug: text(event?.courseSlug), status: event?.status || 'draft',
    accessMode: event?.accessMode || 'public', emtEnabled: Boolean(event?.emtEmail),
    emtEmail: event?.emtEmail || props.creatorEmail || '',
  };
}

export function newTier(currency = 'CAD'): TierDraft {
  return {
    key: globalThis.crypto.randomUUID(), name: '', price: '0', currency, quantity: '',
    description: '', perks: '', sold: 0, requiresRegistration: false, registrationFormId: '', accessCode: '',
  };
}

export function tierDraft(tier: EventFormTier): TierDraft {
  return {
    ...newTier(tier.currency), key: tier.id, id: tier.id, name: tier.name,
    price: (tier.price / 100).toFixed(2), quantity: tier.quantity === null ? '' : String(tier.quantity),
    description: tier.description || '', perks: (tier.perks || []).join('\n'), sold: tier.sold || 0,
    requiresRegistration: tier.requiresRegistration || false,
    registrationFormId: tier.registrationFormId || '', accessCode: tier.accessCode || '', original: tier,
  };
}

export function minorUnits(price: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(price)) throw new Error('Price must be a nonnegative amount with at most two decimal places');
  const [whole, fraction = ''] = price.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error('Price is too large');
  return amount;
}

export function tierPayload(tier: TierDraft, sortOrder: number) {
  return {
    name: tier.name.trim(), description: tier.description, price: minorUnits(tier.price), currency: tier.currency,
    quantity: tier.quantity === '' ? null : Number(tier.quantity),
    perks: tier.perks.split('\n').map((perk) => perk.trim()).filter(Boolean), sortOrder,
    requiresRegistration: tier.requiresRegistration, registrationFormId: tier.registrationFormId.trim() || null,
    accessCode: tier.accessCode.trim() || null,
  };
}

function validateSoldTier(tier: TierDraft, payload: ReturnType<typeof tierPayload>): string {
  if (!tier.original || tier.sold === 0) return '';
  if (payload.price > tier.original.price) return 'Prices can only decrease after tickets are sold';
  if (tier.currency !== tier.original.currency) return 'Currency cannot change after tickets are sold';
  if ((tier.original.perks || []).some((perk) => !payload.perks.includes(perk))) return 'Sold tier perks can only be added, not removed';
  return '';
}

function validateTier(tier: TierDraft): string {
  if (!tier.name.trim()) return 'Every tier needs a name';
  const payload = tierPayload(tier, 0);
  if (tier.currency !== 'CAD' && tier.currency !== 'USD') return 'Choose CAD or USD';
  if (payload.quantity !== null && (!Number.isSafeInteger(payload.quantity) || payload.quantity < tier.sold || payload.quantity < 0)) {
    return 'Quantity must be a whole number at least equal to the sold count';
  }
  if (tier.requiresRegistration && !payload.registrationFormId) return 'Registration form ID is required';
  return validateSoldTier(tier, payload);
}

function isPaymentEmail(value: string): boolean {
  if (value.length > 254 || /\s/.test(value)) return false;
  const parts = value.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return local.length > 0 && domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

function validateDetails(details: FormDetails): string {
  if (!details.title.trim()) return 'Event title is required';
  const start = toInstant(details.startsAt, details.timezone);
  if (details.endsAt && toInstant(details.endsAt, details.timezone) <= start) return 'End must be after start';
  if (details.emtEnabled && !isPaymentEmail(details.emtEmail.trim())) return 'Enter a valid payment email';
  if (details.locationType !== 'physical' && details.virtualUrl) {
    const url = new URL(details.virtualUrl);
    if (!['https:', 'http:'].includes(url.protocol)) return 'Virtual URL must use HTTP or HTTPS';
  }
  return '';
}

export function validateForm(details: FormDetails, tiers: readonly TierDraft[]): string {
  try {
    const detailsError = validateDetails(details);
    if (detailsError) return detailsError;
    if (tiers.length === 0) return 'Add at least one ticket tier';
    for (const tier of tiers) {
      const error = validateTier(tier);
      if (error) return error;
    }
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : 'Check the event fields';
  }
}

export function eventPayload(details: FormDetails) {
  const physical = details.locationType !== 'virtual';
  return {
    title: details.title.trim(), description: [details.tagline.trim(), details.description].filter(Boolean).join('\n\n'),
    startsAt: toInstant(details.startsAt, details.timezone),
    endsAt: details.endsAt ? toInstant(details.endsAt, details.timezone) : null,
    timezone: details.timezone, locationType: details.locationType, isVirtual: details.locationType !== 'physical',
    virtualUrl: details.locationType === 'physical' ? null : details.virtualUrl || null,
    venue: physical ? details.venue : null, address: physical ? details.address : null,
    city: physical ? details.city : null, country: physical ? details.country : null,
    imageUrl: details.imageUrl || null, courseSlug: details.courseSlug.trim() || null,
    accessMode: details.accessMode, status: details.status, emtEmail: details.emtEnabled ? details.emtEmail.trim() : null,
  };
}
