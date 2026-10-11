import { describe, expect, it } from 'vitest';
import { toPublicEvent } from '@/lib/event-public';

describe('toPublicEvent', () => {
  it('removes the ticket-signing private key and keeps every other field', () => {
    const row = { id: 'evt_1', did: 'did:imajin:evt_1', title: 'Meetup', privateKey: 'deadbeef' };

    const result = toPublicEvent(row);

    expect(result).toEqual({ id: 'evt_1', did: 'did:imajin:evt_1', title: 'Meetup' });
    expect('privateKey' in result).toBe(false);
  });

  it('does not mutate the input row', () => {
    const row = { id: 'evt_1', privateKey: 'deadbeef' };

    toPublicEvent(row);

    expect(row.privateKey).toBe('deadbeef');
  });

  it('is a no-op for rows that never carried a key', () => {
    const row: { id: string; privateKey?: string } = { id: 'evt_2' };

    expect(toPublicEvent(row)).toEqual({ id: 'evt_2' });
  });
});
