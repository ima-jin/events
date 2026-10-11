// @vitest-environment jsdom
/** Tests for src/lib/public-event.ts: allow-listed view models and pure display helpers. */
import { describe, expect, it } from 'vitest';
import {
  describeLocation,
  effectiveMax,
  formatCents,
  formatDeadline,
  formatEventSchedule,
  isFreeTier,
  isHiddenStatus,
  isSoldOut,
  mergeTiers,
  resolveEventTheme,
  resolveLocationType,
  salesClosedMessage,
  toPublicEventView,
  toPublicTier,
  visibleTiers,
} from '@/lib/public-event';
import { makeEventRow, makeEventView, makeTier, makeTierRow } from '../support/ui-support';

describe('toPublicEventView', () => {
  it('never carries the private key, the e-Transfer address, the .fair manifest or the creator DID', () => {
    const view = toPublicEventView(makeEventRow({ emtEmail: 'pay@example.com' }));

    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain('super-secret-key');
    expect(serialised).not.toContain('pay@example.com');
    expect(serialised).not.toContain('manifest');
    expect(serialised).not.toContain('did:imajin:creator');
    expect(view.etransferEnabled).toBe(true);
  });

  it('serialises dates and applies defaults', () => {
    const view = toPublicEventView({ id: 'e', title: 'T', startsAt: new Date('2030-01-02T03:04:05.000Z') });

    expect(view).toMatchObject({
      startsAt: '2030-01-02T03:04:05.000Z',
      endsAt: null,
      timezone: 'UTC',
      status: 'draft',
      accessMode: 'public',
      eventType: 'event',
      locationType: 'physical',
      etransferEnabled: false,
      featured: false,
      maxTicketsPerOrder: null,
    });
  });

  it('reads featured, the per-event order cap and the theme from metadata', () => {
    const view = toPublicEventView(
      makeEventRow({ metadata: { featured: true, maxTicketsPerOrder: 4, theme: { color: 'blue', emoji: '🎸' } } }),
    );

    expect(view.featured).toBe(true);
    expect(view.maxTicketsPerOrder).toBe(4);
    expect(view.theme).toEqual({ emoji: '🎸', gradient: ['from-blue-500', 'to-indigo-600'] });
  });
});

describe('resolveLocationType / resolveEventTheme', () => {
  it('prefers locationType, then the legacy isVirtual flag', () => {
    expect(resolveLocationType({ locationType: 'hybrid', isVirtual: true })).toBe('hybrid');
    expect(resolveLocationType({ isVirtual: true })).toBe('virtual');
    expect(resolveLocationType({})).toBe('physical');
  });

  it('falls back to the orange gradient for unknown colours and honours explicit gradients', () => {
    expect(resolveEventTheme({ theme: { color: 'nope' } }).gradient).toEqual(['from-orange-500', 'to-amber-600']);
    expect(resolveEventTheme({ theme: { gradient: ['a', 'b'] } }).gradient).toEqual(['a', 'b']);
    expect(resolveEventTheme({}).emoji).toBe('🎉');
  });
});

describe('tiers', () => {
  it('toPublicTier keeps only display fields (no access code, no sold counter)', () => {
    const tier = toPublicTier(makeTierRow({ accessCode: 'VIP', sold: 3, perks: ['Swag', 7], description: 'Hi' }));

    expect(tier).toEqual({
      id: 'tier_general',
      name: 'General',
      description: 'Hi',
      price: 2000,
      currency: 'CAD',
      quantity: null,
      available: null,
      perks: ['Swag'],
      maxPerOrder: null,
    });
  });

  it('visibleTiers hides access-code tiers and reports that some are hidden', () => {
    const rows = [makeTierRow({ id: 'a' }), makeTierRow({ id: 'b', accessCode: 'SECRET' })];

    const { tiers, hasHiddenTiers } = visibleTiers(rows);

    expect(tiers.map((t) => t.id)).toEqual(['a']);
    expect(hasHiddenTiers).toBe(true);
    expect(visibleTiers([rows[0]]).hasHiddenTiers).toBe(false);
  });

  it('mergeTiers appends new tiers without duplicating ids', () => {
    const merged = mergeTiers([makeTier({ id: 'a' })], [makeTier({ id: 'a' }), makeTier({ id: 'b' })]);

    expect(merged.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('classifies free and sold-out tiers', () => {
    expect(isFreeTier(makeTier({ price: 0 }))).toBe(true);
    expect(isFreeTier(makeTier())).toBe(false);
    expect(isSoldOut(makeTier({ available: 0 }))).toBe(true);
    expect(isSoldOut(makeTier({ available: 2 }))).toBe(false);
    expect(isSoldOut(makeTier({ available: null }))).toBe(false);
  });

  it('effectiveMax: tier override > event cap > 10, bounded by stock and 20', () => {
    expect(effectiveMax(makeTier(), null)).toBe(10);
    expect(effectiveMax(makeTier(), 4)).toBe(4);
    expect(effectiveMax(makeTier({ maxPerOrder: 2 }), 4)).toBe(2);
    expect(effectiveMax(makeTier({ maxPerOrder: 99 }), null)).toBe(20);
    expect(effectiveMax(makeTier({ available: 3 }), null)).toBe(3);
    expect(effectiveMax(makeTier({ available: 0 }), null)).toBe(0);
  });
});

describe('formatting', () => {
  it('formats prices in the tier currency', () => {
    expect(formatCents(2000, 'CAD')).toContain('20.00');
  });

  it('formats the e-Transfer deadline with weekday and time', () => {
    expect(formatDeadline('2030-01-02T15:30:00.000Z')).toMatch(/\d{4}|January/);
  });

  it('formats a same-day schedule with no end date', () => {
    const schedule = formatEventSchedule('2030-06-01T18:00:00.000Z', '2030-06-01T20:00:00.000Z', 'UTC');

    expect(schedule.date).toBe('Saturday, June 1, 2030');
    expect(schedule.time).toContain('6:00');
    expect(schedule.endTime).toContain('8:00');
    expect(schedule.endDate).toBeNull();
  });

  it('shows the end date when the event runs past midnight and omits the end entirely when absent', () => {
    expect(formatEventSchedule('2030-06-01T22:00:00.000Z', '2030-06-02T02:00:00.000Z', 'UTC').endDate).toBe('Sunday, June 2');
    expect(formatEventSchedule('2030-06-01T22:00:00.000Z', null, 'UTC')).toMatchObject({ endTime: null, endDate: null });
  });

  it('describes physical, hybrid and virtual locations (never a join link)', () => {
    expect(describeLocation(makeEventView())).toEqual({ icon: '📍', title: 'The Hall', lines: ['1 Main St', 'Toronto'] });
    expect(describeLocation(makeEventView({ venue: null, address: null, city: null }))).toMatchObject({ title: 'TBA', lines: [] });
    expect(describeLocation(makeEventView({ locationType: 'hybrid', venue: null })).title).toBe('Hybrid Event');
    expect(describeLocation(makeEventView({ locationType: 'virtual' }))).toEqual({ icon: '💻', title: 'Virtual Event', lines: [] });
  });

  it('explains why sales are closed', () => {
    expect(salesClosedMessage('cancelled')).toMatch(/cancelled/);
    expect(salesClosedMessage('completed')).toMatch(/ended/);
    expect(salesClosedMessage('draft')).toMatch(/not currently available/);
  });

  it('hides draft and paused events from non-creators', () => {
    expect(isHiddenStatus('draft')).toBe(true);
    expect(isHiddenStatus('paused')).toBe(true);
    expect(isHiddenStatus('published')).toBe(false);
  });
});
