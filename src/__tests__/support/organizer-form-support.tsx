import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, vi } from 'vitest';
import { EventForm, FairAttribution, type EventFormEvent, type EventFormProps, type EventFormTier, type FairAttributionManifest, type FairAttributionProps } from '@/components/organizer-form';
export { jsonResponse, mockFetch } from './ui-support';
import './ui-support';

export const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
beforeEach(() => { push.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); });

export function eventFixture(overrides: Partial<EventFormEvent> = {}): EventFormEvent {
  return {
    id: 'evt_edit', title: 'Meetup', startsAt: '2099-12-01T18:00:00.000Z', timezone: 'UTC',
    description: 'Original description', status: 'draft', accessMode: 'public',
    metadata: { linkedSurveys: [{ id: 'survey_old' }], campaign: { untouched: true } }, ...overrides,
  };
}

export function tierFixture(overrides: Partial<EventFormTier> = {}): EventFormTier {
  return {
    id: 'tier_existing', name: 'General', price: 2000, currency: 'CAD', quantity: 10, sold: 2,
    perks: ['Recording'], ...overrides,
  };
}

export function renderForm(props: EventFormProps = { mode: 'create' }) {
  return { user: userEvent.setup(), ...render(<EventForm {...props} />) };
}

export function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

export function fillCreate() {
  change('Event title', 'A new meetup');
  change('Start date and time', '2099-12-01T18:00');
}

export function body(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body || '{}'));
}

export function manifestFixture(): FairAttributionManifest {
  return {
    fair: '1.0', id: 'fair_event', type: 'ticket', owner: 'did:imajin:creator',
    created: '2026-10-14T15:00:00Z', access: 'public',
    attribution: [{ did: 'did:imajin:creator', role: 'creator', share: 1 }],
    transfer: { allowed: true, refundable: false, faceValueCap: true },
  };
}

export function renderAttribution(props: Partial<FairAttributionProps> = {}) {
  return {
    user: userEvent.setup(),
    ...render(<FairAttribution eventId="evt_edit" manifest={manifestFixture()} {...props} />),
  };
}
