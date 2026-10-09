/**
 * Tests for src/lib/ticket-holding.ts (kernel #2734): which ticket statuses mean "this DID holds a ticket".
 */
import { describe, it, expect } from 'vitest';
import { HOLDING_TICKET_STATUSES, holdingTicketStatuses, isHoldingTicketStatus } from '@/lib/ticket-holding';

const NON_HOLDING_STATUSES = ['available', 'held', 'cancelled', 'refunded', 'refund_pending'];

describe('ticket-holding', () => {
  it('counts valid, sold (legacy) and used as held', () => {
    expect(HOLDING_TICKET_STATUSES.toSorted()).toEqual(['sold', 'used', 'valid']);
  });

  it.each(['valid', 'sold', 'used'])('isHoldingTicketStatus(%s) is true', (status) => {
    expect(isHoldingTicketStatus(status)).toBe(true);
  });

  it.each([...NON_HOLDING_STATUSES, '', null, undefined])('isHoldingTicketStatus(%s) is false', (status) => {
    expect(isHoldingTicketStatus(status)).toBe(false);
  });

  it('holdingTicketStatuses() returns a fresh mutable copy', () => {
    const copy = holdingTicketStatuses();
    copy.push('valid');

    expect(holdingTicketStatuses()).toEqual([...HOLDING_TICKET_STATUSES]);
  });
});
