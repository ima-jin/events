import { NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { isServiceError } from '@/services/errors';

const log = createLogger('events');

interface TiersErrorOptions {
  /** Extra response headers (e.g. CORS on the app-token path). */
  headers?: HeadersInit;
  /** Log line for unexpected failures; defaults to the response message. */
  logMessage?: string;
}

/**
 * Map a failure from the ticket-types service onto the tiers routes' JSON
 * contract: a `ServiceError` keeps its status, message and extra fields
 * (e.g. `violations`); anything else is logged and answered with a 500.
 */
export function tiersErrorResponse(error: unknown, failureMessage: string, options: TiersErrorOptions = {}) {
  const { headers, logMessage = failureMessage } = options;
  if (isServiceError(error)) {
    return NextResponse.json({ error: error.message, ...error.details }, { status: error.status, headers });
  }
  log.error({ err: String(error) }, logMessage);
  return NextResponse.json({ error: failureMessage }, { status: 500, headers });
}
