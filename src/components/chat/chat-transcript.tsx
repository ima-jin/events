export interface ChatMessage {
  id: string;
  /** Policy-resolved display label; raw DIDs/profiles must not be passed through. */
  senderLabel: string;
  text: string;
}

export type ChatTranscriptState =
  | { status: 'ready'; messages: readonly ChatMessage[] }
  | { status: 'error' }
  | { status: 'unavailable' };

/** Presentation only: access and sender-name policy belong to the public chat contract. */
export function ChatTranscript({ state }: Readonly<{ state: ChatTranscriptState }>) {
  if (state.status === 'unavailable') {
    return (
      <p role="status" className="text-sm text-gray-400">
        Event chat is not available in this app yet. Attendee access through the public chat API is pending.
      </p>
    );
  }
  if (state.status === 'error') {
    return <p role="alert" className="text-sm text-red-400">Chat could not be loaded. Please try again later.</p>;
  }
  if (state.messages.length === 0) {
    return <p role="status" className="text-sm text-gray-400">No messages yet.</p>;
  }
  return (
    <ol aria-label="Event messages" className="space-y-4">
      {state.messages.map((message) => (
        <li key={message.id} className="rounded-lg bg-gray-900/50 p-3">
          <p className="text-sm font-semibold">{message.senderLabel}</p>
          <p className="whitespace-pre-wrap break-words text-sm text-gray-300">{message.text}</p>
        </li>
      ))}
    </ol>
  );
}
