import { buildFairManifest, type FairManifest } from '@ima-jin/fair';

export function feeManifestFixture(withTaxes = false) {
  const manifest = buildFairManifest({
    creatorDid: 'did:imajin:creator', contentDid: 'did:imajin:event', contentType: 'event',
    scopeDid: 'did:imajin:scope', scopeFeeBps: 150, nodeOperatorDid: 'did:imajin:node',
    collaborators: [
      { did: 'did:imajin:creator', role: 'creator', share: 0.7 },
      { did: 'did:imajin:performer', role: 'performer', share: 0.3 },
    ],
    ...(withTaxes ? {
      basisAmountCents: 2000,
      taxes: [{
        jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300,
        registrationNumber: 'TEST-REGISTRATION', collectorDid: 'did:imajin:creator',
        remitTo: 'did:imajin:authority:ca-cra',
      }],
    } : {}),
  });
  return {
    ...manifest,
    attribution: [{
      ...manifest.attribution[0], name: 'Organizer', note: 'Original credit',
      chainProof: { verified: false }, extension: { retained: true },
    }],
    extension: { eventReference: 'evt_edit', nested: ['preserve', { value: 42 }] },
  };
}

export function documentManifestFixture(version: '1.0' | '1.1'): FairManifest {
  return {
    fair: version, version, id: 'fair_event', type: 'ticket', owner: 'did:imajin:creator',
    created: '2026-10-14T15:00:00Z', access: 'public',
    attribution: [{ did: 'did:imajin:creator', role: 'creator', share: 1, note: 'Original credit' }],
    transfer: { allowed: true, refundable: false, faceValueCap: true },
    terms: 'Keep the agreed terms', intent: { purpose: 'Event admission' },
    integrity: { hash: 'original-hash', size: 123 },
  };
}
