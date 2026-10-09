import { filterEventForApp, toPublicEvent } from '@/lib/event-public';
import { appAuthHeaders, serviceUrl } from '@/lib/kernel';
import { NextResponse } from 'next/server';
import { withLogger, type Logger } from '@ima-jin/logger';
import { publish } from '@/lib/domain-events';
import { db, events, ticketTypes } from '@/db';
import { requireAppAuth } from '@ima-jin/auth';
import { authenticateAppOrSession } from '@/lib/app-or-session';
import { corsHeaders, getNodeSelf, getForestScopeConfig } from '@ima-jin/config';
import { buildFairManifest } from '@ima-jin/fair';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

const AUTH_URL = (serviceUrl('auth') ?? '');

interface CreateEventValidationFields {
  title?: unknown;
  startsAt?: unknown;
  eventType?: unknown;
  targetAmount?: unknown;
}

/** Validate the required fields of a create-event request body, returning the error response when invalid. */
function validateCreateEventBody(body: CreateEventValidationFields): NextResponse | null {
  if (!body.title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }
  if (!body.startsAt) {
    return NextResponse.json({ error: 'startsAt is required' }, { status: 400 });
  }
  if (body.eventType === 'campaign') {
    const { targetAmount } = body;
    if (typeof targetAmount !== 'number' || targetAmount <= 0 || !Number.isInteger(targetAmount)) {
      return NextResponse.json({ error: 'targetAmount must be a positive integer (cents)' }, { status: 400 });
    }
  }
  return null;
}

/** Register the event's DID with the auth service, signing the payload the same way /api/register verifies it. */
async function registerEventDid(title: string, eventKeypair: { publicKey: string; privateKey: string }): Promise<{ did: string } | NextResponse> {
  // Sign the registration payload — must match what /api/register verifies
  const ed = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha2.js');
  ed.hashes.sha512 = sha512;
  const regPayload = JSON.stringify({ publicKey: eventKeypair.publicKey, name: title, scope: 'actor', subtype: 'event' });
  const msgBytes = new TextEncoder().encode(regPayload);
  const privBytes = hexToBytes(eventKeypair.privateKey);
  const sigBytes = await ed.signAsync(msgBytes, privBytes);
  const signature = bytesToHex(sigBytes);

  const regRes = await fetch(`${AUTH_URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: eventKeypair.publicKey,
      scope: 'actor',
      subtype: 'event',
      name: title,
      signature,
    }),
  });

  if (!regRes.ok) {
    const err = await regRes.json();
    return NextResponse.json({ error: `Failed to register event DID: ${err.error}` }, { status: 500 });
  }

  const regData = await regRes.json();
  return { did: regData.did };
}

/** Look up the scope's fee-bps override (via the profile service's public forest route, #2001), or null when there is no scope or override. */
async function resolveScopeFeeBps(scopeDid: string | null): Promise<number | null> {
  if (!scopeDid) return null;
  const forestConfig = await getForestScopeConfig(scopeDid);
  return forestConfig?.scopeFeeBps ?? null;
}

/** Insert the ticket types provided at event-creation time, returning the created rows. */
function createTicketTypesForEvent(eventId: string, ticketTypesInput: unknown): Promise<Array<typeof ticketTypes.$inferSelect>> {
  if (!Array.isArray(ticketTypesInput) || ticketTypesInput.length === 0) return Promise.resolve([]);

  return db.insert(ticketTypes).values(
    ticketTypesInput.map((tt) => ({
      id: `tkt_type_${randomBytes(8).toString('hex')}`,
      eventId,
      name: tt.name,
      description: tt.description,
      price: tt.price,
      currency: tt.currency || 'USD',
      quantity: tt.quantity,
      perks: tt.perks || [],
    }))
  ).returning();
}

/** Best-effort: create the event's chat conversation, add the creator as admin, and sync its name-display policy. */
async function createEventChat(params: {
  chatUrl: string;
  eventDid: string;
  creatorDid: string;
  creatorId: string;
  title: string;
  nameDisplayPolicy: string | undefined;
  log: Logger;
}): Promise<void> {
  const { chatUrl, eventDid, creatorDid, creatorId, nameDisplayPolicy, log } = params;

  try {
    await fetch(`${chatUrl}/api/d/${encodeURIComponent(eventDid)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberDid: creatorDid, role: 'admin' }),
    });
    // gap(kernel): the kernel version also set the conversation's name and
    // creator with a direct UPDATE on chat.conversations_v2. There is no
    // public chat route for that, so the conversation keeps the name the
    // chat service assigns — see docs/KERNEL-GAPS.md.
    log.info({ eventDid, creatorId }, 'Created event chat with creator as admin');
  } catch (chatError) {
    log.warn({ err: String(chatError) }, 'Event chat creation failed (non-fatal)');
  }

  // Sync name display policy to chat conversation context
  try {
    await fetch(`${chatUrl}/api/d/${encodeURIComponent(eventDid)}/context`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...appAuthHeaders(),
      },
      body: JSON.stringify({ context: { nameDisplayPolicy: nameDisplayPolicy || 'attendee_choice' } }),
    });
  } catch {
    // Best-effort — chat conversation may not exist yet
  }
}

/**
 * POST /api/events - Create a new event
 * Requires hard DID (keypair-based identity)
 */
export const POST = withLogger('events', async (request, { log, correlationId }) => {
  const cors = corsHeaders(request);
  const auth = await authenticateAppOrSession(request, cors, { appScope: 'events:write', requireHardIdentity: true });
  if (auth instanceof NextResponse) return auth;
  const { did, identity } = auth;

  try {
    const body = await request.json();
    const {
      title,
      description,
      startsAt,
      endsAt,
      locationType,
      isVirtual,
      virtualUrl,
      venue,
      address,
      city,
      country,
      imageUrl,
      imageAssetId,
      tags,
      tickets: ticketTypesInput,
      courseSlug,
      emtEmail,
      eventType,
      targetAmount,
      deadline,
      nameDisplayPolicy,
      chatEnabled,
    } = body;

    const validationError = validateCreateEventBody(body);
    if (validationError) return validationError;

    // Generate event ID and DID
    const eventId = `evt_${randomBytes(12).toString('hex')}`;

    // Register event DID with auth service
    const eventKeypair = await generateEventKeypair();
    const registration = await registerEventDid(title, eventKeypair);
    if (registration instanceof NextResponse) return registration;
    const { did: eventDid } = registration;

    // Load node config (via the registry, #2000) and optional scope config for fair manifest
    const nodeSelf = await getNodeSelf();
    // gap(kernel): act-as (forest scope) is not part of the app-token contract,
    // so events are never created on behalf of a scope DID here.
    const scopeDid: string | null = null;
    const scopeFeeBps = await resolveScopeFeeBps(scopeDid);

    // Auto-generate .fair attribution manifest
    const fairManifest = buildFairManifest({
      creatorDid: did,
      contentDid: eventDid,
      contentType: 'event',
      scopeDid,
      scopeFeeBps,
      nodeFeeBps: nodeSelf?.nodeFeeBps ?? undefined,
      buyerCreditBps: nodeSelf?.buyerCreditBps ?? undefined,
      nodeOperatorDid: nodeSelf?.nodeOperatorDid ?? undefined,
    });

    // Create event
    const [event] = await db.insert(events).values({
      id: eventId,
      did: eventDid,
      publicKey: eventKeypair.publicKey,
      privateKey: eventKeypair.privateKey,
      creatorDid: did,
      title,
      description,
      startsAt: new Date(startsAt),
      endsAt: endsAt ? new Date(endsAt) : null,
      timezone: body.timezone || null,
      locationType: locationType || (isVirtual ? 'virtual' : 'physical'),
      isVirtual: locationType ? locationType !== 'physical' : (isVirtual || false),
      virtualUrl,
      venue,
      address,
      city,
      country,
      imageUrl,
      imageAssetId: imageAssetId || null,
      tags: tags || [],
      courseSlug: courseSlug || null,
      emtEmail: emtEmail || null,
      nameDisplayPolicy: nameDisplayPolicy || 'attendee_choice',
      chatEnabled: chatEnabled === undefined  ? true : chatEnabled,
      eventType: eventType || 'event',
      targetAmount: eventType === 'campaign' ? targetAmount : null,
      deadline: eventType === 'campaign' && deadline ? new Date(deadline) : null,
      status: 'draft',
      metadata: { fair: fairManifest },
    }).returning();

    publish('event.create', {
      issuer: did,
      subject: did,
      scope: 'events',
      payload: { eventId: event.id, eventDid: event.did, title },
      correlationId,
    }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

    // Fire and forget — never block the response
    publish('event.created', {
      issuer: identity.id,
      subject: identity.id,
      scope: 'events',
      payload: {
        eventDid: event.did,
        title,
        context_id: event.id,
        context_type: 'event',
      },
    }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

    // Create ticket types if provided
    const createdTicketTypes = await createTicketTypesForEvent(event.id, ticketTypesInput);

    // Create event chat conversation and add creator as admin
    const CHAT_URL = serviceUrl('chat');
    if (CHAT_URL) {
      await createEventChat({
        chatUrl: CHAT_URL,
        eventDid,
        creatorDid: did,
        creatorId: identity.id,
        title,
        nameDisplayPolicy,
        log,
      });
    }

    // Store event keypair (in real system, this would be encrypted/secured)
    // For now, we return it so creator can sign tickets
    return NextResponse.json({
      event,
      ticketTypes: createdTicketTypes,
      // Include keypair for ticket signing (creator responsibility to secure)
      eventKeypair: {
        publicKey: eventKeypair.publicKey,
        privateKey: eventKeypair.privateKey, // ⚠️ Creator must secure this
      },
    }, { status: 201 });

  } catch (error) {
    log.error({ err: String(error) }, 'Failed to create event');
    return NextResponse.json({ error: 'Failed to create event' }, { status: 500 });
  }
});

/**
 * GET /api/events - List events
 * Supports: ?courseSlug=intro-to-ai&upcoming=true&status=published&limit=20
 */
export const GET = withLogger('events', async (request, { log }) => {
  const cors = corsHeaders(request);
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'published';
  const limit = Number.parseInt(searchParams.get('limit') || '20');
  const courseSlug = searchParams.get('courseSlug');
  const upcoming = searchParams.get('upcoming') === 'true';

  const isAppCall = Boolean(request.headers.get('x-app-did'));
  // CORS headers are only sent on the legacy registered-app path (kernel behaviour).
  const headers = isAppCall ? cors : undefined;

  if (isAppCall) {
    const appResult = await requireAppAuth(request, { scope: 'events:read' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
  }

  try {
    const conditions = [eq(events.status, status)];
    if (courseSlug) conditions.push(eq(events.courseSlug, courseSlug));
    if (upcoming) conditions.push(gt(events.startsAt, new Date()));

    const eventList = await db
      .select()
      .from(events)
      .where(and(...conditions))
      .orderBy(upcoming ? asc(events.startsAt) : desc(events.startsAt))
      .limit(limit);

    const serialize = isAppCall ? filterEventForApp : toPublicEvent;
    return NextResponse.json({ events: eventList.map((event) => serialize(event)) }, { headers });
  } catch (error) {
    log.error({ err: String(error), appAuth: isAppCall }, 'Failed to list events');
    return NextResponse.json({ error: 'Failed to list events' }, { status: 500, headers });
  }
});

// Helper to generate keypair for event
async function generateEventKeypair() {
  const ed = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha2.js');
  ed.hashes.sha512 = sha512;
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKey(privateKey);
  return {
    privateKey: bytesToHex(privateKey),
    publicKey: bytesToHex(publicKey),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
