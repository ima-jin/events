import type { EventFormEvent, EventFormTier } from '@/components/organizer-form/types';
import type { TicketTypeWithAvailability } from '@/services/events-service';

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function date(value: unknown): string {
  return new Date(value as string | Date).toISOString();
}

/** Explicit allowlist: signing keys and arbitrary metadata never reach a client component. */
export function eventFormView(event: Record<string, unknown>): EventFormEvent {
  return {
    id: String(event.id),
    title: String(event.title),
    description: text(event.description),
    startsAt: date(event.startsAt),
    endsAt: event.endsAt ? date(event.endsAt) : null,
    timezone: text(event.timezone),
    locationType: text(event.locationType) as EventFormEvent['locationType'],
    isVirtual: event.isVirtual === true,
    virtualUrl: text(event.virtualUrl),
    venue: text(event.venue),
    address: text(event.address),
    city: text(event.city),
    country: text(event.country),
    imageUrl: text(event.imageUrl),
    courseSlug: text(event.courseSlug),
    status: text(event.status) || 'draft',
    accessMode: text(event.accessMode) as EventFormEvent['accessMode'],
    emtEmail: text(event.emtEmail),
  };
}

export function tierFormView(tier: TicketTypeWithAvailability): EventFormTier {
  return {
    id: tier.id,
    name: tier.name,
    price: tier.price,
    currency: tier.currency || 'CAD',
    quantity: tier.quantity,
    description: tier.description,
    perks: Array.isArray(tier.perks) ? tier.perks.map(String) : [],
    sold: tier.sold || 0,
    requiresRegistration: tier.requiresRegistration || false,
    registrationFormId: tier.registrationFormId,
    accessCode: tier.accessCode,
    sortOrder: tier.sortOrder,
  };
}
