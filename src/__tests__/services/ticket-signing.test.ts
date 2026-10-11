import * as ed from '@noble/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@ima-jin/logger';
import { resolveTicketSignature, signTicketPayload } from '@/services/ticket-signing';

const NOW = new Date('2026-06-01T12:00:00Z');
const PRIVATE_KEY_HEX = bytesToHex(new Uint8Array(32).fill(7));
const EMAIL = 'buyer@test.com';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('signTicketPayload', () => {
  it('signs ticket:eventDid:email:timestamp with the event key (hex Ed25519)', async () => {
    const signature = await signTicketPayload('tkt_1', EMAIL, {
      eventId: 'evt_1',
      eventDid: 'did:imajin:event',
      eventPrivateKey: PRIVATE_KEY_HEX,
    });

    const message = new TextEncoder().encode(`tkt_1:did:imajin:event:${EMAIL}:${NOW.getTime()}`);
    const publicKey = await ed.getPublicKeyAsync(hexToBytes(PRIVATE_KEY_HEX));
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(await ed.verifyAsync(hexToBytes(signature), message, publicKey)).toBe(true);
  });

  it('falls back to the base64 payload (and warns) when the event has no private key', async () => {
    const log = { warn: vi.fn() } as unknown as Logger;

    const signature = await signTicketPayload('tkt_1', EMAIL, {
      eventId: 'evt_1',
      eventDid: 'did:imajin:event',
      eventPrivateKey: null,
      log,
    });

    expect(Buffer.from(signature, 'base64').toString()).toBe(
      `tkt_1:did:imajin:event:${EMAIL}:${NOW.getTime()}`,
    );
    expect(log.warn).toHaveBeenCalledWith(
      { eventId: 'evt_1' },
      'Event has no privateKey — using base64 fallback signature',
    );
  });

  it('does not require a logger for the fallback', async () => {
    const signature = await signTicketPayload('tkt_1', EMAIL, { eventId: 'evt_1' });

    expect(Buffer.from(signature, 'base64').toString()).toBe(
      `tkt_1:undefined:${EMAIL}:${NOW.getTime()}`,
    );
  });
});

describe('resolveTicketSignature', () => {
  const context = { eventId: 'evt_1', eventDid: 'did:imajin:event' };

  it('is null for held tickets', async () => {
    expect(await resolveTicketSignature('tkt_1', 'held', EMAIL, context)).toBeNull();
  });

  it('is null for valid tickets without a customer email', async () => {
    expect(await resolveTicketSignature('tkt_1', 'valid', undefined, context)).toBeNull();
  });

  it('signs valid tickets that have a customer email', async () => {
    const signature = await resolveTicketSignature('tkt_1', 'valid', EMAIL, context);

    expect(Buffer.from(signature ?? '', 'base64').toString()).toContain(`tkt_1:did:imajin:event:${EMAIL}`);
  });
});
