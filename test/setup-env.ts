/**
 * Baseline environment for the vitest run. Modules such as `src/db/schema.ts`
 * and `src/lib/auth.ts` read these at import / call time and throw when they are
 * missing, so every suite starts from the same safe, non-secret defaults.
 * Individual tests override with `vi.stubEnv` / `process.env` as needed.
 */
process.env.APP_DB_SCHEMA ??= 'events';
process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/events_test';
process.env.NEXT_PUBLIC_APP_URL ??= 'https://events.test';
