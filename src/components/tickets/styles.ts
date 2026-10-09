/** Tailwind class names shared by the ticket purchase components. */
const BUTTON_BASE = 'w-full rounded-lg px-4 py-2.5 text-center font-semibold transition disabled:cursor-not-allowed disabled:opacity-50';

export const BUTTON_PRIMARY = `${BUTTON_BASE} bg-orange-500 text-white hover:bg-orange-600`;
/** Primary button that sizes to its label instead of filling the row. */
export const BUTTON_PRIMARY_INLINE = `${BUTTON_PRIMARY} !w-auto`;
export const BUTTON_SECONDARY = `${BUTTON_BASE} border border-orange-500/40 bg-orange-500/20 text-orange-500 hover:bg-orange-500/30`;
export const BUTTON_GHOST = 'rounded-lg px-3 py-2.5 text-sm text-gray-500 transition hover:text-gray-300 disabled:opacity-50';
export const INPUT = 'w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50 disabled:opacity-50';
export const PANEL = 'w-full max-w-md space-y-4 rounded-xl border border-orange-500/30 bg-orange-500/5 p-5';
export const MUTED = 'text-sm text-gray-400';
export const ERROR_TEXT = 'text-xs text-red-500';
