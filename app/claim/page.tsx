'use client';

import { useState, type FormEvent } from 'react';
import { ClaimFormView, ClaimSuccessView, type ClaimFormState, type ClaimResult } from '@/components/ClaimViews';
import { withBasePath } from '@/lib/base-path';

/**
 * Operator-facing claim page (#2427) — closes the loop the kernel's `/jin`
 * approval card opens: paste the one-time claim code here instead of
 * ssh-ing in to edit an env file. Only reachable while this app is
 * unclaimed; `middleware.ts` 404s this route once the claim succeeds.
 *
 * No client-side "which app is this" confirmation field: `/api/claim`
 * itself verifies the kernel-returned `appDid` against this app's own
 * `IMAJIN_APP_DID` and refuses (409) a code issued for a different app
 * before ever adopting it — see `src/lib/signing-identity.ts`'s
 * `claimWithCode()`. A browser-only check couldn't run until after the
 * (single-use) code was already spent, so it added no real protection.
 */

interface ClaimResponseBody {
  appDid?: unknown;
  publicKey?: unknown;
  error?: unknown;
}

function parseClaimResult(body: ClaimResponseBody): ClaimResult | null {
  if (typeof body.appDid !== 'string') {
    return null;
  }
  return { appDid: body.appDid, publicKey: typeof body.publicKey === 'string' ? body.publicKey : null };
}

function errorMessageFrom(body: ClaimResponseBody): string {
  return typeof body.error === 'string' ? body.error : 'Unable to claim this app';
}

export default function ClaimPage() {
  const [claimCode, setClaimCode] = useState('');
  const [formState, setFormState] = useState<ClaimFormState>({ status: 'idle' });

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setFormState({ status: 'submitting' });

    let response: Response;
    try {
      response = await fetch(withBasePath('/api/claim'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claimCode }),
      });
    } catch {
      setFormState({ status: 'error', message: 'Could not reach this app — try again' });
      return;
    }

    const body = (await response.json().catch(() => ({}))) as ClaimResponseBody;
    const result = response.ok ? parseClaimResult(body) : null;

    if (!result) {
      setFormState({ status: 'error', message: errorMessageFrom(body) });
      return;
    }

    setClaimCode('');
    setFormState({ status: 'success', result });
  }

  if (formState.status === 'success') {
    return <ClaimSuccessView result={formState.result} />;
  }

  return (
    <ClaimFormView
      claimCode={claimCode}
      formState={formState}
      onClaimCodeChange={setClaimCode}
      onSubmit={handleSubmit}
    />
  );
}
