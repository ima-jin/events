import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELEGATION_ROUTES as SDK_ROUTES, evaluateDelegationPolicy } from '@ima-jin/auth/delegation-policy';
import { DELEGATION_ROUTES, evaluateEventsDelegationPolicy } from '@/lib/delegation-policy';

const owner = { id: 'did:imajin:owner' };
const delegate = { id: 'did:imajin:agent', actingFor: owner.id };

function request(path: string, method = 'POST', body?: unknown) {
  return new Request(`https://events.test${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('standalone delegation policy', () => {
  it.each(Object.entries(SDK_ROUTES).filter(([, entry]) => entry.app === 'events'))(
    'preserves the kernel classification and proposal for %s', async (key, entry) => {
      expect(DELEGATION_ROUTES[key as keyof typeof DELEGATION_ROUTES]).toMatchObject({
        method: entry.method, path: entry.path, class: entry.class, action: entry.action,
      });
      const path = entry.path.replaceAll(/\[[^\]]+\]/g, 'resource');
      const resourceId = entry.path.includes('[') ? 'resource' : undefined;
      expect(await evaluateEventsDelegationPolicy(request(path, entry.method), delegate)).toEqual(
        evaluateDelegationPolicy(delegate, { action: entry.action, class: entry.class, resourceId }),
      );
    },
  );

  it.each(Object.entries(DELEGATION_ROUTES))('%s preserves owner and delegate rules', async (_key, entry) => {
    const path = entry.path.replaceAll(/\[[^\]]+\]/g, 'resource');
    expect(await evaluateEventsDelegationPolicy(request(path, entry.method), owner)).toEqual({ allowed: true });
    const result = await evaluateEventsDelegationPolicy(request(path, entry.method), delegate);
    expect(result.allowed).toBe(entry.class === 'reversible');
  });

  it.each([
    [{ metadata: { fair: { splits: [] } } }, 'value-moving', 'fair-update'],
    [{ metadata: {} }, 'value-moving', 'fair-update'],
    [{ metadata: null }, 'value-moving', 'fair-update'],
    [{ emtEmail: 'other@example.test' }, 'value-moving', 'fair-update'],
    [{ status: 'cancelled' }, 'irreversible', 'status'],
    [{ accessMode: 'public' }, 'irreversible', 'status'],
  ])('blocks sensitive PUT fields %j without consuming the body', async (body, mutationClass, action) => {
    const req = request('/api/events/evt', 'PUT', body);
    expect(await evaluateEventsDelegationPolicy(req, delegate)).toEqual(
      evaluateDelegationPolicy(delegate, { class: mutationClass as 'value-moving' | 'irreversible', action: String(action), resourceId: 'evt' }),
    );
    expect(await req.json()).toEqual(body);
    expect(await evaluateEventsDelegationPolicy(request('/api/events/evt', 'PUT', body), owner)).toEqual({ allowed: true });
  });

  it('allows reversible details, malformed bodies, and non-object bodies to reach existing validation', async () => {
    for (const body of [{ title: 'Edited' }, null, 1]) {
      expect(await evaluateEventsDelegationPolicy(request('/api/events/evt', 'PUT', body), delegate)).toEqual({ allowed: true });
    }
    expect(await evaluateEventsDelegationPolicy(request('/api/events/evt', 'PUT'), delegate)).toEqual({ allowed: true });
  });

  it('handles the configured mount prefix and query strings', async () => {
    vi.stubEnv('NEXT_PUBLIC_BASE_PATH', '/events');
    const decision = await evaluateEventsDelegationPolicy(request('/events/api/orders/ord/refund?approved=true'), delegate);
    expect(decision).toMatchObject({ allowed: false, body: { action: 'refund', resourceId: 'ord' } });
  });

  it('does not trust approval flags or raw headers over the verified identity', async () => {
    const req = request('/api/orders/ord/refund', 'POST', { approved: true, countersigned: true, actingFor: null });
    req.headers.set('x-acting-for', owner.id);
    expect(await evaluateEventsDelegationPolicy(req, delegate)).toMatchObject({ allowed: false, status: 403 });
    expect(await evaluateEventsDelegationPolicy(req, owner)).toEqual({ allowed: true });
  });

  it('keeps self-delegation, group authority, and read methods unchanged', async () => {
    for (const source of [owner, { ...owner, actingFor: owner.id }, null, { id: owner.id, actingAs: 'did:imajin:group' }]) {
      expect(await evaluateEventsDelegationPolicy(request('/api/orders/ord/refund'), source)).toEqual({ allowed: true });
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(await evaluateEventsDelegationPolicy(request('/api/orders/ord/refund', method), delegate)).toEqual({ allowed: true });
    }
  });

  it('fails closed for unknown mutation paths or methods', async () => {
    for (const [path, method] of [['/api/new-route', 'POST'], ['/api/orders/ord/refund', 'DELETE'], ['/api/orders//refund', 'POST']]) {
      expect(await evaluateEventsDelegationPolicy(request(path, method), delegate)).toMatchObject({
        allowed: false, body: { action: 'unclassified-mutation', class: 'irreversible' },
      });
    }
  });
});
