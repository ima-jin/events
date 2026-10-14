import { vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { PodMemberRow } from '@/lib/cohost-helpers';

export const OWNER = 'did:imajin:owner';
export const COHOST = 'did:imajin:cohost';
export const OTHER = 'did:imajin:other';
export const EVENT_ID = 'evt_cohosts';
export const COOKIE = 'imajin_session=caller';
export const POD_ID = 'pod/cohosts';
export const PARAMS = { params: Promise.resolve({ id: EVENT_ID }) };
export const MEMBER = { did: COHOST, role: 'cohost', joinedAt: '2026-10-14T12:00:00Z', removedAt: null };
export const EVENT = { id: EVENT_ID, title: 'Cohost event', creatorDid: OWNER, podId: POD_ID, did: 'did:imajin:event' };
export const PROFILE = { name: 'Co Host', handle: 'cohost', avatarUrl: '/avatar.png' };

const hoisted = vi.hoisted(() => ({
  event: vi.fn(),
  attach: vi.fn(),
  organizer: vi.fn(),
  actor: vi.fn(),
  fetch: vi.fn(),
  serviceUrl: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
export const mocks = hoisted;

vi.mock('@/repositories/events-repository', () => ({ getEventById: hoisted.event, attachEventPodIfMissing: hoisted.attach }));
vi.mock('@/services/authorization', () => ({ isEventOrganizer: hoisted.organizer }));
vi.mock('@/lib/route-guards', () => ({ requireActor: hoisted.actor }));
vi.mock('@/lib/kernel', () => ({ serviceUrl: hoisted.serviceUrl }));
vi.mock('@ima-jin/logger', () => ({ createLogger: () => hoisted.log }));

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export function memberResponse(members: PodMemberRow[] = [MEMBER]) {
  return jsonResponse({ pod: { id: POD_ID }, members });
}

export function request(method = 'GET', body?: unknown) {
  return new NextRequest(`https://events.test/api/events/${EVENT_ID}/cohosts`, {
    method,
    headers: { cookie: COOKIE, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function resetCohostMocks() {
  vi.resetAllMocks();
  mocks.event.mockResolvedValue(EVENT);
  mocks.attach.mockResolvedValue(EVENT);
  mocks.organizer.mockResolvedValue({ authorized: true, role: 'creator' });
  mocks.actor.mockResolvedValue({ did: OWNER, identity: { id: OWNER } });
  mocks.serviceUrl.mockImplementation((service: string) => `https://${service}.test`);
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.includes('/api/lookup/')) return jsonResponse({ identity: PROFILE });
    if (url.includes('/api/profile/by-handle/')) return jsonResponse({ ...PROFILE, did: COHOST });
    if (url.includes('/api/d/')) return jsonResponse({ ok: true });
    if (url.endsWith('/api/pods')) return jsonResponse({ pod: { id: POD_ID } }, 201);
    if (url.endsWith('/members')) return jsonResponse({ member: MEMBER, removed: true });
    return memberResponse();
  });
  vi.stubGlobal('fetch', mocks.fetch);
}
