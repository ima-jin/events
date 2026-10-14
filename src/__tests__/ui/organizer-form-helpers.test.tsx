// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { zonedDateTime, toInstant } from '@/components/organizer-form/dates';
import { eventPayload, initialDetails, minorUnits, newTier, tierDraft, tierPayload, validateForm } from '@/components/organizer-form/model';
import { saveForm, type SaveProgress } from '@/components/organizer-form/persistence';
import { eventFixture, jsonResponse, mockFetch, tierFixture } from '../support/organizer-ui-support';

const details = () => initialDetails({ mode: 'edit', event: eventFixture() });
const tier = () => tierDraft(tierFixture());

describe('organizer form helpers', () => {
  it('handles exact minor units and rejects invalid or unsafe money', () => {
    expect(minorUnits('0.29')).toBe(29);
    expect(minorUnits('12.3')).toBe(1230);
    for (const price of ['-1', '', 'NaN', '1.234', '9007199254740991']) expect(() => minorUnits(price)).toThrow();
  });

  it('converts selected zones, roundtrips UTC and rejects invalid/nonexistent times', () => {
    expect(zonedDateTime('2026-10-14T18:00:00Z', 'America/Toronto')).toBe('2026-10-14T14:00');
    expect(toInstant('2026-10-14T14:00', 'America/Toronto')).toBe('2026-10-14T18:00:00.000Z');
    expect(toInstant('2026-10-14T18:00', 'UTC')).toBe('2026-10-14T18:00:00.000Z');
    expect(() => toInstant('2026-03-08T02:30', 'America/Toronto')).toThrow('does not exist');
    expect(() => toInstant('2026-10-14T18:00', 'invalid')).toThrow();
    expect(() => toInstant('bad', 'UTC')).toThrow();
  });

  it('validates blank/fractional quantities, registration, URL and unsold policy', () => {
    expect(validateForm(details(), [tier()])).toBe('');
    expect(validateForm(details(), [{ ...tier(), quantity: '' }])).toBe('');
    expect(validateForm(details(), [{ ...tier(), quantity: '2.5' }])).toContain('whole number');
    expect(validateForm(details(), [{ ...tier(), requiresRegistration: true }])).toContain('form ID');
    expect(validateForm({ ...details(), locationType: 'virtual', virtualUrl: 'ftp://example.test' }, [tier()])).toContain('HTTP');
    expect(validateForm(details(), [tierDraft(tierFixture({ sold: 0, price: 100, perks: ['Old'] }))].map((item) => ({ ...item, price: '100', currency: 'USD', perks: '' })))).toBe('');
    expect(validateForm(details(), [])).toContain('at least one');
    expect(newTier().key).not.toBe(newTier().key);
  });

  it('clears only inactive location fields and emits explicit null access code', () => {
    const physical = eventPayload({ ...details(), virtualUrl: 'https://example.test' });
    expect(physical.virtualUrl).toBeNull();
    const virtual = eventPayload({ ...details(), locationType: 'virtual', venue: 'Old venue', city: 'Old city' });
    expect(virtual).toMatchObject({ venue: null, city: null, isVirtual: true });
    expect(tierPayload({ ...tier(), accessCode: ' ' }, 2)).toMatchObject({ accessCode: null, sortOrder: 2 });
  });

  it('does not create duplicate events after a later confirmed tier refusal', async () => {
    let refused = false;
    const fetch = mockFetch({
      '/api/events': (init) => {
        if (init?.method === 'POST' && String(init.body).includes('eventType')) return jsonResponse({ event: { id: 'new' } }, 201);
        if (init?.method === 'POST' && !refused) { refused = true; return jsonResponse({}, 400); }
        if (init?.method === 'POST') return jsonResponse({ tier: { id: 'new_tier' } }, 201);
        return jsonResponse({});
      },
    });
    const progress: SaveProgress = { tierIds: new Map(), uncertain: false };
    const drafts = [{ ...newTier(), name: 'General' }];
    await expect(saveForm(details(), drafts, progress)).rejects.toThrow('Unable to save');
    expect(progress.eventId).toBe('new');
    await expect(saveForm(details(), drafts, progress)).resolves.toBe('new');
    expect(fetch.mock.calls.filter(([url, init]) => url === '/api/events' && init?.method === 'POST')).toHaveLength(1);
  });

  it('never retries an ambiguous POST network or server failure', async () => {
    const fetch = mockFetch({ '/api/events': jsonResponse({ error: 'SECRET' }, 500) });
    const progress: SaveProgress = { tierIds: new Map(), uncertain: false };
    await expect(saveForm(details(), [tier()], progress)).rejects.toThrow('Unable to save');
    await expect(saveForm(details(), [tier()], progress)).rejects.toThrow('uncertain');
    expect(fetch).toHaveBeenCalledTimes(1);
    mockFetch({ '/api/events': () => { throw new Error('network'); } });
    const disconnected: SaveProgress = { tierIds: new Map(), uncertain: false };
    await expect(saveForm(details(), [tier()], disconnected)).rejects.toThrow();
    expect(disconnected.uncertain).toBe(true);
  });

  it('blocks blind retry when tier creation returns no ID', async () => {
    const fetch = mockFetch({
      '/api/events': (init) => init?.method === 'POST' ? jsonResponse({ tier: {} }, 201) : jsonResponse({}),
    });
    const progress: SaveProgress = { eventId: 'existing', tierIds: new Map(), uncertain: false };
    await expect(saveForm(details(), [{ ...newTier(), name: 'VIP' }], progress)).rejects.toThrow('uncertain');
    await expect(saveForm(details(), [{ ...newTier(), name: 'VIP' }], progress)).rejects.toThrow('uncertain');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('validates empty tiers and inherited location/payment defaults', () => {
    expect(validateForm(details(), [{ ...newTier(), name: '' }])).toContain('needs a name');
    expect(validateForm(details(), [{ ...tier(), currency: 'invalid' }])).toContain('CAD or USD');
    expect(validateForm({ ...details(), startsAt: '' }, [tier()])).toContain('valid date');
    expect(initialDetails({ mode: 'edit', event: eventFixture({ locationType: null, isVirtual: true }), creatorEmail: 'creator@example.test' }))
      .toMatchObject({ locationType: 'virtual', emtEmail: 'creator@example.test', emtEnabled: false });
  });
});
