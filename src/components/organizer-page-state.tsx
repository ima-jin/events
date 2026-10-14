'use client';

export function OrganizerPageError({ reset }: Readonly<{ reset: () => void }>) {
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-8">
      <h1 className="text-2xl font-bold">Unable to load organizer tools</h1>
      <p role="alert">Please try again. Your event has not been changed.</p>
      <button type="button" onClick={reset} className="rounded-lg bg-orange-500 px-4 py-2 text-white">Try again</button>
    </div>
  );
}

export function OrganizerPageLoading() {
  return <output className="mx-auto block max-w-4xl p-8 text-gray-400">Loading organizer tools…</output>;
}
