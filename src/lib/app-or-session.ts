import { NextResponse } from 'next/server';
import { requireAppAuth } from '@ima-jin/auth';
import { requireAuth, requireHardDID, resolveActingDid, type EventsIdentity } from '@/lib/auth';

export interface AppOrSessionCaller {
  did: string;
  identity: EventsIdentity;
}

export interface AppOrSessionOptions {
  /** Scope the legacy `X-App-DID` caller must hold. */
  appScope: string;
  /** Require a full ("hard") identity on the token/session path. */
  requireHardIdentity?: boolean;
}

/**
 * Authenticate a caller on a route that still accepts the legacy registered-app header flow
 * (`X-App-DID` + `X-App-Authorization`, verified by the SDK's `requireAppAuth`) next to the
 * scoped app token / session cookie. Resolves to the caller's DID and identity, or to the error
 * response the route should return as-is.
 */
export async function authenticateAppOrSession(
  request: Request,
  cors: HeadersInit,
  options: AppOrSessionOptions,
): Promise<AppOrSessionCaller | NextResponse> {
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: options.appScope });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
    const did = appResult.appAuth.userDid;
    return { did, identity: { id: did, scopes: appResult.appAuth.scopes, via: 'token' } };
  }

  const authResult = options.requireHardIdentity ? await requireHardDID(request) : await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  return { did: resolveActingDid(authResult.identity), identity: authResult.identity };
}
