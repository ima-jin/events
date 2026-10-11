import { NextResponse } from 'next/server';
import type { Logger } from '@ima-jin/logger';
import { isServiceError } from '@/services/errors';

export interface FailureOptions {
  /** Body message for an unexpected (non-ServiceError) failure — always a 500. */
  fallback: string;
  log: Pick<Logger, 'error'>;
  /** Extra structured fields for the error log line of an unexpected failure. */
  logFields?: Record<string, unknown>;
  headers?: HeadersInit;
}

/**
 * Map a failure raised under a route handler to its response: a `ServiceError`
 * keeps its pinned `status` / `message` (and spreads `details`); anything else is
 * logged and answered with a generic 500.
 */
export function failureResponse(error: unknown, { fallback, log, logFields, headers }: FailureOptions): NextResponse {
  if (isServiceError(error)) {
    return NextResponse.json({ error: error.message, ...error.details }, { status: error.status, headers });
  }
  log.error({ err: String(error), ...logFields }, fallback);
  return NextResponse.json({ error: fallback }, { status: 500, headers });
}
