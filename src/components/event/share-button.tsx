'use client';

import { useEffect, useState } from 'react';

const COPIED_MS = 2000;

/** Copies the current page URL to the clipboard and briefly confirms. */
export function ShareButton() {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await globalThis.navigator.clipboard.writeText(globalThis.location.href);
      setCopied(true);
    } catch {
      // Clipboard unavailable (insecure context / permission denied): nothing to confirm.
    }
  };

  return (
    <button type="button" onClick={copy} title="Copy link" aria-label="Copy link" className="relative flex-shrink-0 rounded-lg p-2.5 transition hover:bg-gray-700">
      <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
        />
      </svg>
      {copied && (
        <span role="status" className="absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-gray-900 px-2 py-1 text-xs text-white shadow-lg">
          Copied!
        </span>
      )}
    </button>
  );
}
