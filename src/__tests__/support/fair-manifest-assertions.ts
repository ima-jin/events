/**
 * Shared fixtures/assertions for the `.fair` manifest a create route persists.
 *
 * `buildFairManifest` (published `@ima-jin/fair`) is NOT mocked by the suites
 * that use this module — they assert that node config sourced from
 * `getNodeSelf()` (`@ima-jin/config`, the kernel registry) really flows into
 * the manifest's `node` / `buyer_credit` chain entries.
 */
import { expect } from 'vitest';

export interface FairChainEntry {
  did: string;
  role: string;
  share: number;
}

/** A representative "node self" response as returned by a configured registry. */
export const REGISTRY_NODE_SELF = {
  did: 'did:imajin:jin',
  nodeOperatorDid: 'did:imajin:operator',
  nodeFeeBps: 80,
  buyerCreditBps: 30,
} as const;

export function findChainRole(chain: FairChainEntry[], role: string): FairChainEntry | undefined {
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

/** Pull the persisted `.fair` chain out of a create-route JSON body. */
export function fairChainOf(body: { event: { metadata: { fair: { chain: FairChainEntry[] } } } }): FairChainEntry[] {
  return body.event.metadata.fair.chain;
}
