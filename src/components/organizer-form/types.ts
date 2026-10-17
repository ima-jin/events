import type { CardRailReadiness } from '@/lib/card-rail';

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type LocationType = 'physical' | 'virtual' | 'hybrid';

/** Explicit browser-safe projection; never pass a database event row. Dates are ISO strings. */
export interface EventFormEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt?: string | null;
  description?: string | null;
  timezone?: string | null;
  locationType?: LocationType | null;
  isVirtual?: boolean;
  virtualUrl?: string | null;
  venue?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  imageUrl?: string | null;
  courseSlug?: string | null;
  status?: string;
  accessMode?: 'public' | 'invite_only';
  emtEmail?: string | null;
  metadata?: { readonly [key: string]: JsonValue } | null;
}

/** Prices are integer minor units; callers must explicitly project organizer-only fields. */
export interface EventFormTier {
  id: string;
  name: string;
  price: number;
  currency: string;
  quantity: number | null;
  description?: string | null;
  perks?: readonly string[] | null;
  sold?: number | null;
  requiresRegistration?: boolean;
  registrationFormId?: string | null;
  accessCode?: string | null;
  sortOrder?: number | null;
}

export interface EventFormProps {
  mode: 'create' | 'edit';
  event?: EventFormEvent;
  existingTickets?: readonly EventFormTier[];
  creatorEmail?: string | null;
  loadError?: string;
  cardRailReadiness?: CardRailReadiness;
}

export interface FormDetails {
  title: string;
  tagline: string;
  description: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  locationType: LocationType;
  virtualUrl: string;
  venue: string;
  address: string;
  city: string;
  country: string;
  imageUrl: string;
  courseSlug: string;
  status: string;
  accessMode: 'public' | 'invite_only';
  emtEnabled: boolean;
  emtEmail: string;
}

export interface TierDraft {
  key: string;
  id?: string;
  name: string;
  price: string;
  currency: string;
  quantity: string;
  description: string;
  perks: string;
  sold: number;
  requiresRegistration: boolean;
  registrationFormId: string;
  accessCode: string;
  original?: EventFormTier;
}
