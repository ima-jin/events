import { ChatTranscript } from './chat-transcript';

/**
 * gap(kernel): ima-jin/imajin-ai#2785 (refs #1988).
 * Kernel chat access is session-only, not a registered-app attendee grant.
 * Do not forward an events-audience token, impersonate an attendee with an
 * app-service token, or import the monorepo's unpublished chat package.
 */
export function EventChat({ eventId }: Readonly<{ eventId: string }>) {
  const descriptionId = `chat-unavailable-${eventId}`;
  return (
    <details className="mt-6 overflow-hidden rounded-2xl bg-gray-800/50 shadow-lg">
      <summary className="cursor-pointer px-6 py-4 text-lg font-semibold">Event Chat</summary>
      <div className="space-y-4 border-t border-gray-700 px-6 py-4">
        <div id={descriptionId}>
          <ChatTranscript state={{ status: 'unavailable' }} />
        </div>
        <label className="block text-sm text-gray-400" htmlFor={`chat-message-${eventId}`}>Message</label>
        <textarea
          id={`chat-message-${eventId}`}
          aria-describedby={descriptionId}
          disabled
          placeholder="Chat is unavailable"
          className="w-full rounded-lg bg-gray-900 p-3 text-gray-400"
        />
        <button type="button" disabled className="rounded-lg bg-gray-700 px-4 py-2 text-gray-400">Send message</button>
      </div>
    </details>
  );
}
