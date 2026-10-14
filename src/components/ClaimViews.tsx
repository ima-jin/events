import type { FormEvent } from 'react';

export interface ClaimResult {
  appDid: string;
  publicKey: string | null;
}

export type ClaimFormState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string }
  | { status: 'success'; result: ClaimResult };

interface ClaimFormViewProps {
  claimCode: string;
  formState: ClaimFormState;
  onClaimCodeChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

/**
 * Presentational views for the `/claim` page. Kept separate from
 * `app/claim/page.tsx` so a DOM test can render each state (form, error,
 * claimed result) without a browser. These views use an explicit dark
 * background so their foreground colours stay readable in either browser theme.
 */
export function ClaimFormView({
  claimCode,
  formState,
  onClaimCodeChange,
  onSubmit,
}: Readonly<ClaimFormViewProps>) {
  return (
    <div className="mx-auto max-w-md bg-gray-950 px-4 py-12">
      <h1 className="text-2xl font-semibold text-white">Claim this app</h1>
      <p className="mt-2 text-sm text-gray-400">
        Paste the one-time claim code from the kernel operator&apos;s <code>/jin</code> approval card to finish
        provisioning this app&apos;s signing identity.
      </p>
      <form className="mt-6 space-y-4" onSubmit={onSubmit}>
        <div>
          <label htmlFor="claimCode" className="block text-sm font-medium text-white">
            Claim code
          </label>
          <input
            id="claimCode"
            name="claimCode"
            type="text"
            autoComplete="off"
            required
            value={claimCode}
            onChange={(event) => onClaimCodeChange(event.target.value)}
            className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-white"
          />
        </div>
        {formState.status === 'error' && (
          <p role="alert" className="text-sm text-red-400">
            {formState.message}
          </p>
        )}
        <button
          type="submit"
          disabled={formState.status === 'submitting'}
          className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-gray-950 disabled:opacity-50"
        >
          {formState.status === 'submitting' ? 'Claiming…' : 'Claim app'}
        </button>
      </form>
    </div>
  );
}

export function ClaimSuccessView({ result }: Readonly<{ result: ClaimResult }>) {
  return (
    <div className="mx-auto max-w-md bg-gray-950 px-4 py-12">
      <h1 className="text-2xl font-semibold text-white">App claimed</h1>
      <p className="mt-2 text-sm text-gray-400">
        This app&apos;s signing identity is now active. The claim code has been spent and cannot be reused.
      </p>
      <dl className="mt-6 space-y-2 text-sm">
        <div>
          <dt className="text-gray-400">App DID</dt>
          <dd className="break-all text-white">{result.appDid}</dd>
        </div>
        {result.publicKey !== null && (
          <div>
            <dt className="text-gray-400">Public key</dt>
            <dd className="break-all text-white">{result.publicKey}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
