import { isValidManifest, type FairManifest } from '@ima-jin/fair';

export type FairAttributionManifest = FairManifest;

/** Published editor and PATCH endpoint accept the same schema; never invent a fee-manifest migration. */
export function editableManifest(value: unknown): FairAttributionManifest | null {
  try {
    return isValidManifest(value) ? value : null;
  } catch {
    // The SDK validator can throw on malformed nested entries.
    return null;
  }
}
