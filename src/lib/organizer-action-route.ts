import { NextRequest, NextResponse } from 'next/server';
import type { Logger } from '@ima-jin/logger';
import { requireAuth, resolveActingDid } from '@/lib/auth';
import { failureResponse } from '@/lib/events-route-response';
import { isServiceError } from '@/services/errors';

export interface OrganizerActionContext {
  /** The DID the request acts as (after delegation / act-as resolution). */
  actorDid: string;
  /** The caller's own session cookie, forwarded for the kernel's co-host (pod) check. */
  callerCookie: string | null;
}

export interface OrganizerActionOptions<T> {
  /** Body message for an unexpected failure (always a 500). */
  fallback: string;
  log: Logger;
  /** The service call; any `ServiceError` it throws keeps its pinned status and message. */
  action: (context: OrganizerActionContext) => Promise<T>;
  /** Rethrow unexpected failures instead of answering 500 (kernel parity for the cancel route). */
  rethrowUnexpected?: boolean;
}

/**
 * The shared shape of the organizer money routes: authenticate, resolve the acting DID, run one
 * service call, answer its JSON result, and map failures (`ServiceError` → its status, else a
 * logged 500). Keeps each route a few lines of wiring.
 */
export async function runOrganizerAction<T>(request: NextRequest, options: OrganizerActionOptions<T>): Promise<NextResponse> {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  try {
    const result = await options.action({
      actorDid: resolveActingDid(authResult.identity),
      callerCookie: request.headers.get('cookie'),
    });
    return NextResponse.json(result);
  } catch (error) {
    if (options.rethrowUnexpected && !isServiceError(error)) throw error;
    return failureResponse(error, { fallback: options.fallback, log: options.log });
  }
}
