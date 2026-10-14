import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { requireActor } from '@/lib/route-guards';
import { addEventCohost, listEventCohosts, removeEventCohost } from '@/services/cohosts-service';
import { isServiceError, ServiceError } from '@/services/errors';

const log = createLogger('events');
type RouteProps = { params: Promise<{ id: string }> };
type Operation = 'list' | 'add' | 'remove';

async function readBody(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ServiceError('invalid', 'Invalid JSON body');
  }
}

async function handleCohosts(request: NextRequest, props: RouteProps, operation: Operation) {
  try {
    const actor = await requireActor(request);
    if (actor instanceof NextResponse) return actor;
    const { id } = await props.params;
    const cookie = request.headers.get('cookie') ?? '';
    if (operation === 'list') {
      return NextResponse.json(await listEventCohosts(id, actor.did, cookie));
    }
    const body = await readBody(request);
    if (operation === 'add') {
      return NextResponse.json(await addEventCohost(id, actor.did, body, cookie), { status: 201 });
    }
    return NextResponse.json(await removeEventCohost(id, actor.did, body, cookie));
  } catch (error) {
    if (isServiceError(error)) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = operation === 'list' ? 'Failed to list cohosts' : `Failed to ${operation} cohost`;
    log.error({ err: String(error) }, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** List cohosts for an authenticated event organizer. */
export function GET(request: NextRequest, props: RouteProps) {
  return handleCohosts(request, props, 'list');
}

/** Add a cohost by DID or handle; event creator only. */
export function POST(request: NextRequest, props: RouteProps) {
  return handleCohosts(request, props, 'add');
}

/** Remove a cohost by DID; event creator only. */
export function DELETE(request: NextRequest, props: RouteProps) {
  return handleCohosts(request, props, 'remove');
}
