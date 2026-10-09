/**
 * Shared fixtures/assertions for the `.fair` manifest built by
 * `POST /api/events` (#2000 registry-sourced node config, #2001 forest-scope
 * fee). Ported from the kernel's `packages/fair/src/test-helpers.ts`, trimmed
 * to what this app's route test needs — the kernel file is not part of the
 * published `@ima-jin/fair` surface.
 */
import { expect, it, type Mock } from 'vitest';

export interface FairChainEntry {
  did: string;
  role: string;
  share: number;
}

type MockLike = Mock<(...args: never[]) => unknown>;

/** A representative "node self" response as returned by a configured registry. */
export const REGISTRY_NODE_SELF = {
  did: 'did:imajin:jin',
  nodeOperatorDid: 'did:imajin:operator',
  nodeFeeBps: 80,
  buyerCreditBps: 30,
} as const;

/** A representative forest-group DID used by the scope-fee assertions (#2001). */
export const FOREST_SCOPE_DID = 'did:imajin:forest-group';

function findChainRole(chain: FairChainEntry[], role: string): FairChainEntry | undefined {
  return chain.find((entry) => entry.role === role);
}

/** Asserts a `.fair` chain reflects REGISTRY_NODE_SELF's fee config. */
export function expectRegistrySourcedShares(chain: FairChainEntry[]): void {
  expect(findChainRole(chain, 'node')).toMatchObject({ did: REGISTRY_NODE_SELF.nodeOperatorDid, share: 0.008 });
  expect(findChainRole(chain, 'buyer_credit')).toMatchObject({ share: 0.003 });
}

/** Asserts a `.fair` chain reflects buildFairManifest's built-in defaults (getNodeSelf() → null). */
export function expectDefaultShares(chain: FairChainEntry[]): void {
  expect(findChainRole(chain, 'node')).toMatchObject({ did: 'NODE_PLACEHOLDER', share: 0.005 });
}

/** Asserts a `.fair` chain's `scope` entry reflects the given forest group's fee. */
export function expectForestScopeShare(chain: FairChainEntry[], scopeDid: string, scopeFeeBps: number): void {
  expect(findChainRole(chain, 'scope')).toMatchObject({ did: scopeDid, share: scopeFeeBps / 10000 });
}

/**
 * Declares the `it()` asserting that acting as a forest scope (the verified
 * act-as claim on the caller's app token) applies that group's scope fee to
 * the persisted `.fair` manifest.
 */
export function itAppliesForestScopeFee(config: {
  getForestScopeConfigMock: MockLike;
  getNodeSelfMock: MockLike;
  authMock: MockLike;
  callerId: string;
  callRoute: () => Promise<Response>;
  getChain: (body: Record<string, unknown>) => FairChainEntry[];
  scopeFeeBps?: number;
}): void {
  const scopeFeeBps = config.scopeFeeBps ?? 40;

  it('applies the forest group scope fee to the .fair manifest when acting as a scope (#2001)', async () => {
    config.getNodeSelfMock.mockResolvedValue(null as never);
    config.authMock.mockResolvedValue({ identity: { id: config.callerId, actingAs: FOREST_SCOPE_DID } } as never);
    config.getForestScopeConfigMock.mockResolvedValue({ scopeFeeBps } as never);

    const res = await config.callRoute();
    expect(res.status).toBe(201);
    expect(config.getForestScopeConfigMock).toHaveBeenCalledWith(FOREST_SCOPE_DID);

    expectForestScopeShare(config.getChain(await res.json()), FOREST_SCOPE_DID, scopeFeeBps);
  });
}
