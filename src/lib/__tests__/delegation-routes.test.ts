import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { evaluateDelegationPolicy } from '@ima-jin/auth/delegation-policy';
import { DELEGATION_ROUTES } from '@/lib/delegation-policy';
import { authErrorBody, requireAuth, resolveActingDid } from '@/lib/auth';
import { runOrganizerAction } from '@/lib/organizer-action-route';
import { authenticateAppOrSession } from '@/lib/app-or-session';
import { createLogger } from '@ima-jin/logger';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  appAuth: vi.fn(),
  database: vi.fn(() => { throw new Error('No database access before countersign'); }),
  network: vi.fn(() => { throw new Error('No network side effect before countersign'); }),
  publish: vi.fn(),
  refund: vi.fn(),
}));

vi.mock('@ima-jin/auth', () => ({ requireSessionOrAppToken: mocks.auth, requireAppAuth: mocks.appAuth }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/db', async () => ({
  ...await import('@/db/schema'),
  db: { select: mocks.database, update: mocks.database, insert: mocks.database, delete: mocks.database, transaction: mocks.database },
  getClient: () => mocks.database,
}));
vi.mock('@/lib/domain-events', () => ({ publish: mocks.publish }));
vi.mock('@/services/orders-service', () => ({ refundOrder: mocks.refund }));
vi.mock('@ima-jin/config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@ima-jin/config')>(),
  rateLimit: () => ({ limited: false }),
  corsHeaders: () => ({ 'Access-Control-Allow-Origin': 'https://client.test' }),
}));

type Handler = (request: NextRequest, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
const modules: Record<string, () => Promise<unknown>> = {
  '/app/api/campaign/[eventId]/cancel/route.ts': () => import('../../../app/api/campaign/[eventId]/cancel/route'),
  '/app/api/campaign/[eventId]/settle/route.ts': () => import('../../../app/api/campaign/[eventId]/settle/route'),
  '/app/api/checkout/balance/route.ts': () => import('../../../app/api/checkout/balance/route'),
  '/app/api/events/route.ts': () => import('../../../app/api/events/route'),
  '/app/api/events/[id]/route.ts': () => import('../../../app/api/events/[id]/route'),
  '/app/api/events/[id]/fair/route.ts': () => import('../../../app/api/events/[id]/fair/route'),
  '/app/api/events/[id]/cohosts/route.ts': () => import('../../../app/api/events/[id]/cohosts/route'),
  '/app/api/events/[id]/message/route.ts': () => import('../../../app/api/events/[id]/message/route'),
  '/app/api/events/[id]/invites/route.ts': () => import('../../../app/api/events/[id]/invites/route'),
  '/app/api/events/[id]/invites/[inviteId]/route.ts': () => import('../../../app/api/events/[id]/invites/[inviteId]/route'),
  '/app/api/events/[id]/tiers/route.ts': () => import('../../../app/api/events/[id]/tiers/route'),
  '/app/api/events/[id]/tickets/[ticketId]/cancel/route.ts': () => import('../../../app/api/events/[id]/tickets/[ticketId]/cancel/route'),
  '/app/api/events/[id]/tickets/[ticketId]/refund/route.ts': () => import('../../../app/api/events/[id]/tickets/[ticketId]/refund/route'),
  '/app/api/events/[id]/tickets/[ticketId]/mark-refund-sent/route.ts': () => import('../../../app/api/events/[id]/tickets/[ticketId]/mark-refund-sent/route'),
  '/app/api/events/[id]/tickets/[ticketId]/check-in/route.ts': () => import('../../../app/api/events/[id]/tickets/[ticketId]/check-in/route'),
  '/app/api/events/[id]/tickets/[ticketId]/resend-email/route.ts': () => import('../../../app/api/events/[id]/tickets/[ticketId]/resend-email/route'),
  '/app/api/orders/[id]/refund/route.ts': () => import('../../../app/api/orders/[id]/refund/route'),
  '/app/api/orders/[id]/confirm-payment/route.ts': () => import('../../../app/api/orders/[id]/confirm-payment/route'),
  '/app/api/tickets/[id]/confirm-payment/route.ts': () => import('../../../app/api/tickets/[id]/confirm-payment/route'),
};
const OWNER = 'did:imajin:owner';
const AGENT = 'did:imajin:agent';
const protectedRoutes = Object.entries(DELEGATION_ROUTES).filter(([, entry]) => entry.class !== 'reversible');
const context = { params: Promise.resolve({ id: 'resource', eventId: 'resource', ticketId: 'resource', inviteId: 'resource' }) };
const log = createLogger('delegation-test');

function session(actingFor: string | undefined = OWNER, via = 'token') {
  mocks.auth.mockResolvedValue({ auth: { did: AGENT, actingFor, via, scopes: ['events:write'] } });
}

function request(path: string, method = 'POST', body: unknown = {}) {
  return new NextRequest(`https://events.test${path}`, {
    method, headers: { cookie: 'caller-cookie', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  session();
  vi.stubGlobal('fetch', mocks.network);
});
afterEach(() => vi.unstubAllGlobals());

describe('real mutation handlers using the published policy', () => {
  it.each(protectedRoutes)('%s refuses the delegate before database, payment or notifications', async (_key, entry) => {
    const load = modules[`/app${entry.path}/route.ts`];
    expect(load).toBeDefined();
    const route = await load() as Record<string, Handler>;
    const path = entry.path.replaceAll(/\[[^\]]+\]/g, 'resource');
    const response = await route[entry.method](request(path, entry.method), context);
    expect(response.status).toBe(403);
    const resourceId = entry.path.includes('[') ? 'resource' : undefined;
    const expected = evaluateDelegationPolicy({ id: AGENT, actingFor: OWNER }, {
      action: entry.action, class: entry.class, resourceId,
    });
    expect(expected.allowed).toBe(false);
    if (!expected.allowed) expect(await response.json()).toEqual(expected.body);
    expect(mocks.database).not.toHaveBeenCalled();
    expect(mocks.network).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it.each(['token', 'cookie'])('guards verified %s delegation without trusting a raw header', async (via) => {
    session(OWNER, via);
    const action = vi.fn();
    const response = await runOrganizerAction(request('/api/orders/ord/refund'), { action, fallback: 'failed', log });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED', ownerDid: OWNER, delegateDid: AGENT, resourceId: 'ord' });
    expect(action).not.toHaveBeenCalled();
  });

  it('executes the actual refund handler from the owner session', async () => {
    mocks.auth.mockResolvedValue({ auth: { did: OWNER, via: 'cookie', scopes: [] } });
    mocks.refund.mockResolvedValue({ refunded: true });
    const route = await modules['/app/api/orders/[id]/refund/route.ts']() as Record<string, Handler>;
    const response = await route.POST(request('/api/orders/resource/refund'), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ refunded: true });
    expect(mocks.refund).toHaveBeenCalledWith({ orderId: 'resource', actorDid: OWNER, callerCookie: 'caller-cookie' });
  });

  it('lets reversible delegate actions reach the service with the owner DID', async () => {
    const action = vi.fn().mockResolvedValue({ updated: true });
    const response = await runOrganizerAction(request('/api/events/resource/hold'), { action, fallback: 'failed', log });
    expect(response.status).toBe(200);
    expect(action).toHaveBeenCalledWith({ actorDid: OWNER, callerCookie: 'caller-cookie' });
  });

  it.each([{ metadata: {} }, { emtEmail: 'other@example.test' }, { status: 'cancelled' }, { accessMode: 'public' }])(
    'blocks alternate sensitive PUT mutation %j before service execution', async (body) => {
      const route = await modules['/app/api/events/[id]/route.ts']() as Record<string, Handler>;
      const response = await route.PUT(request('/api/events/resource', 'PUT', body), context);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED', resourceId: 'resource' });
      expect(mocks.database).not.toHaveBeenCalled();
      expect(mocks.network).not.toHaveBeenCalled();
    },
  );

  it('does not allow legacy app headers to bypass verified delegation', async () => {
    const req = request('/api/events/resource', 'PUT', { metadata: {} });
    req.headers.set('x-app-did', 'did:imajin:app');
    req.headers.set('x-acting-for', OWNER);
    const result = await authenticateAppOrSession(req, {}, { appScope: 'events:write' });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    expect(mocks.appAuth).not.toHaveBeenCalled();
  });

  it('retains legacy app authority without a delegation header', async () => {
    mocks.appAuth.mockResolvedValue({ appAuth: { userDid: OWNER, scopes: ['events:write'] } });
    const req = request('/api/events/resource', 'PUT', { metadata: {} });
    req.headers.set('x-app-did', 'did:imajin:app');
    expect(await authenticateAppOrSession(req, {}, { appScope: 'events:write' })).toMatchObject({ did: OWNER });
    expect(mocks.auth).not.toHaveBeenCalled();
  });

  it('keeps SDK authentication failures intact and never calls the service', async () => {
    mocks.auth.mockResolvedValue({ error: 'Invalid delegation grant', status: 403 });
    const action = vi.fn();
    const response = await runOrganizerAction(request('/api/orders/ord/refund'), { action, fallback: 'failed', log });
    expect(await response.json()).toEqual({ error: 'Invalid delegation grant' });
    expect(action).not.toHaveBeenCalled();
    expect(authErrorBody({ error: 'Unauthorized', status: 401 })).toEqual({ error: 'Unauthorized' });
  });

  it('preserves group and self-delegation identity resolution', async () => {
    session(AGENT);
    expect(await requireAuth(request('/api/orders/ord/refund'))).toMatchObject({ identity: { id: AGENT, actingFor: AGENT } });
    expect(resolveActingDid({ id: AGENT, scopes: [], via: 'token', actingAs: OWNER })).toBe(OWNER);
  });
});
