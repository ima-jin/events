import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getEventOwnership: vi.fn(), isPodMember: vi.fn() }));

vi.mock('@/repositories/events-repository', () => ({ getEventOwnership: mocks.getEventOwnership }));
vi.mock('@/lib/kernel', () => ({ isPodMember: mocks.isPodMember }));

import { isEventOrganizer } from '@/services/authorization';

const CREATOR = 'did:imajin:creator';
const COHOST = 'did:imajin:cohost';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isPodMember.mockResolvedValue(false);
});

describe('isEventOrganizer', () => {
  it('is false for an unknown event', async () => {
    mocks.getEventOwnership.mockResolvedValue(null);

    expect(await isEventOrganizer('evt_x', CREATOR)).toEqual({ authorized: false });
    expect(mocks.isPodMember).not.toHaveBeenCalled();
  });

  it('recognises the creator without asking the kernel', async () => {
    mocks.getEventOwnership.mockResolvedValue({ creatorDid: CREATOR, podId: 'pod_1' });

    expect(await isEventOrganizer('evt_1', CREATOR)).toEqual({ authorized: true, role: 'creator' });
    expect(mocks.isPodMember).not.toHaveBeenCalled();
  });

  it('recognises a co-host through app-authorized membership without a cookie', async () => {
    mocks.getEventOwnership.mockResolvedValue({ creatorDid: CREATOR, podId: 'pod_1' });
    mocks.isPodMember.mockResolvedValue(true);

    expect(await isEventOrganizer('evt_1', COHOST)).toEqual({ authorized: true, role: 'cohost' });
    expect(mocks.isPodMember).toHaveBeenCalledWith('pod_1', COHOST, undefined, undefined);
  });

  it('retains legacy cookie compatibility for the membership helper', async () => {
    mocks.getEventOwnership.mockResolvedValue({ creatorDid: CREATOR, podId: 'pod_1' });
    mocks.isPodMember.mockResolvedValue(true);

    expect(await isEventOrganizer('evt_1', COHOST, 'session=abc')).toEqual({ authorized: true, role: 'cohost' });
    expect(mocks.isPodMember).toHaveBeenCalledWith('pod_1', COHOST, undefined, 'session=abc');
  });

  it('does not grant organizer access when the app-authorized helper fails closed', async () => {
    mocks.getEventOwnership.mockResolvedValue({ creatorDid: CREATOR, podId: 'pod_1' });
    mocks.isPodMember.mockResolvedValue(false);

    expect(await isEventOrganizer('evt_1', COHOST, 'session=creator')).toEqual({ authorized: false });
    expect(mocks.isPodMember).toHaveBeenCalledWith('pod_1', COHOST, undefined, 'session=creator');
  });

  it('fails closed for a non-member, and for an event with no pod', async () => {
    mocks.getEventOwnership.mockResolvedValue({ creatorDid: CREATOR, podId: 'pod_1' });
    expect(await isEventOrganizer('evt_1', COHOST)).toEqual({ authorized: false });

    mocks.getEventOwnership.mockResolvedValue({ creatorDid: CREATOR, podId: null });
    expect(await isEventOrganizer('evt_1', COHOST)).toEqual({ authorized: false });
  });
});
