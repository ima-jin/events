import { randomBytes } from 'node:crypto';
import { createLogger } from '@ima-jin/logger';
import { getForestScopeConfig, getNodeSelf } from '@ima-jin/config';
import { buildFairManifest } from '@ima-jin/fair';
import { appAuthHeaders, serviceUrl } from '@/lib/kernel';
import { publish } from '@/lib/domain-events';
import { filterEventForApp, toPublicEvent } from '@/lib/event-public';
import { buildEventUpdates, syncNamePolicyToChat, type EventUpdateBody } from '@/lib/event-update-helpers';
import * as repo from '@/repositories/events-repository';
import type { EventRow, EventSummary, NewEventRow, NewTicketTypeRow, TicketTypeRow } from '@/repositories/events-repository';
import { isEventOrganizer } from '@/services/authorization';
import { ServiceError } from '@/services/errors';

const log = createLogger('events');

const SCOPE = 'events';
const NOT_FOUND = 'Event not found';
const DEFAULT_NAME_POLICY = 'attendee_choice';
const CAMPAIGN = 'campaign';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Who the response is for: anonymous/session callers, or a legacy registered app holding only `events:read`. */
export type EventAudience = 'public' | 'app';

export interface TicketTypeInput {
  name: string;
  description?: string;
  price: number;
  currency?: string;
  quantity?: number;
  perks?: string[];
}

/** Body of a create-event request, as the route parsed it (validated by {@link createEvent}). */
export interface CreateEventInput {
  title?: string;
  description?: string;
  startsAt?: string;
  endsAt?: string;
  timezone?: string;
  locationType?: string;
  isVirtual?: boolean;
  virtualUrl?: string;
  venue?: string;
  address?: string;
  city?: string;
  country?: string;
  imageUrl?: string;
  imageAssetId?: string;
  tags?: string[];
  tickets?: unknown;
  courseSlug?: string;
  emtEmail?: string;
  eventType?: string;
  targetAmount?: unknown;
  deadline?: string;
  nameDisplayPolicy?: string;
  chatEnabled?: boolean;
}

export interface EventKeypair {
  publicKey: string;
  privateKey: string;
}

export interface CreateEventResult {
  event: EventRow;
  ticketTypes: TicketTypeRow[];
  /** Handed to the creator exactly once so they can sign tickets. */
  eventKeypair: EventKeypair;
}

export interface ListEventsInput {
  status?: string | null;
  limit: number;
  courseSlug?: string | null;
  upcoming?: boolean;
  audience: EventAudience;
}

export type TicketTypeWithAvailability = TicketTypeRow & { available: number | null };

export type CreatorEvent = Omit<EventRow, 'privateKey'> & {
  ticketsSold: number;
  revenue: number;
  statusBadge: string | null;
  ticketTypes: TicketTypeRow[];
};

// ---------------------------------------------------------------------------
// Keys and kernel registration
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function loadEd25519() {
  const ed = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha2.js');
  ed.hashes.sha512 = sha512;
  return ed;
}

/** Generate the event's Ed25519 ticket-signing keypair (hex encoded). */
async function generateEventKeypair(): Promise<EventKeypair> {
  const ed = await loadEd25519();
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKey(privateKey);
  return { privateKey: bytesToHex(privateKey), publicKey: bytesToHex(publicKey) };
}

/** Register the event's DID with the auth service, signing the payload the same way /api/register verifies it. */
async function registerEventDid(title: string, keypair: EventKeypair): Promise<string> {
  const ed = await loadEd25519();
  const payload = JSON.stringify({ publicKey: keypair.publicKey, name: title, scope: 'actor', subtype: 'event' });
  const signature = bytesToHex(await ed.signAsync(new TextEncoder().encode(payload), hexToBytes(keypair.privateKey)));

  const authUrl = serviceUrl('auth') ?? '';
  const response = await fetch(`${authUrl}/api/register`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ publicKey: keypair.publicKey, scope: 'actor', subtype: 'event', name: title, signature }),
  });

  if (!response.ok) {
    const err = (await response.json()) as { error?: string };
    throw new ServiceError('unavailable', `Failed to register event DID: ${err.error}`, { status: 500 });
  }

  const data = (await response.json()) as { did: string };
  return data.did;
}

/** Look up the scope's fee-bps override (via the profile service's public forest route, #2001), or null when there is no scope or override. */
async function resolveScopeFeeBps(scopeDid: string | null): Promise<number | null> {
  if (!scopeDid) return null;
  const forestConfig = await getForestScopeConfig(scopeDid);
  return forestConfig?.scopeFeeBps ?? null;
}

/** Build the event's .fair attribution manifest from the node config (via the registry, #2000). */
async function buildEventFairManifest(creatorDid: string, eventDid: string) {
  const nodeSelf = await getNodeSelf();
  // gap(kernel): act-as (forest scope) is not part of the app-token contract,
  // so events are never created on behalf of a scope DID here.
  const scopeDid: string | null = null;
  const scopeFeeBps = await resolveScopeFeeBps(scopeDid);

  return buildFairManifest({
    creatorDid,
    contentDid: eventDid,
    contentType: 'event',
    scopeDid,
    scopeFeeBps,
    nodeFeeBps: nodeSelf?.nodeFeeBps ?? undefined,
    buyerCreditBps: nodeSelf?.buyerCreditBps ?? undefined,
    nodeOperatorDid: nodeSelf?.nodeOperatorDid ?? undefined,
  });
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** Validate the required fields of a create-event request body. */
function validateCreateEventInput(input: CreateEventInput): void {
  if (!input.title) throw new ServiceError('invalid', 'title is required');
  if (!input.startsAt) throw new ServiceError('invalid', 'startsAt is required');
  if (input.eventType === CAMPAIGN) {
    const { targetAmount } = input;
    if (typeof targetAmount !== 'number' || targetAmount <= 0 || !Number.isInteger(targetAmount)) {
      throw new ServiceError('invalid', 'targetAmount must be a positive integer (cents)');
    }
  }
}

function resolveLocation(input: CreateEventInput): { locationType: string; isVirtual: boolean } {
  const { locationType, isVirtual } = input;
  if (locationType) return { locationType, isVirtual: locationType !== 'physical' };
  return { locationType: isVirtual ? 'virtual' : 'physical', isVirtual: isVirtual || false };
}

function resolveCampaignFields(input: CreateEventInput): Pick<NewEventRow, 'eventType' | 'targetAmount' | 'deadline'> {
  const eventType = input.eventType || 'event';
  if (eventType !== CAMPAIGN) return { eventType, targetAmount: null, deadline: null };
  return {
    eventType,
    targetAmount: input.targetAmount as number,
    deadline: input.deadline ? new Date(input.deadline) : null,
  };
}

interface EventRowParams {
  eventId: string;
  eventDid: string;
  keypair: EventKeypair;
  creatorDid: string;
  input: CreateEventInput;
  fairManifest: unknown;
}

function buildEventRow({ eventId, eventDid, keypair, creatorDid, input, fairManifest }: EventRowParams): NewEventRow {
  return {
    id: eventId,
    did: eventDid,
    publicKey: keypair.publicKey,
    privateKey: keypair.privateKey,
    creatorDid,
    title: input.title as string,
    description: input.description,
    startsAt: new Date(input.startsAt as string),
    endsAt: input.endsAt ? new Date(input.endsAt) : null,
    timezone: input.timezone || null,
    ...resolveLocation(input),
    virtualUrl: input.virtualUrl,
    venue: input.venue,
    address: input.address,
    city: input.city,
    country: input.country,
    imageUrl: input.imageUrl,
    imageAssetId: input.imageAssetId || null,
    tags: input.tags || [],
    courseSlug: input.courseSlug || null,
    emtEmail: input.emtEmail || null,
    nameDisplayPolicy: input.nameDisplayPolicy || DEFAULT_NAME_POLICY,
    chatEnabled: input.chatEnabled ?? true,
    ...resolveCampaignFields(input),
    status: 'draft',
    metadata: { fair: fairManifest },
  };
}

/** Insert the ticket types provided at event-creation time, returning the created rows. */
function createTicketTypesForEvent(eventId: string, ticketTypesInput: unknown): Promise<TicketTypeRow[]> {
  if (!Array.isArray(ticketTypesInput) || ticketTypesInput.length === 0) return Promise.resolve([]);

  const rows: NewTicketTypeRow[] = (ticketTypesInput as TicketTypeInput[]).map((tt) => ({
    id: `tkt_type_${randomBytes(8).toString('hex')}`,
    eventId,
    name: tt.name,
    description: tt.description,
    price: tt.price,
    currency: tt.currency || 'USD',
    quantity: tt.quantity,
    perks: tt.perks || [],
  }));
  return repo.insertTicketTypes(rows);
}

/** Fire-and-forget domain event: publishing must never block or fail the request. */
function publishBestEffort(type: string, event: Parameters<typeof publish>[1]): void {
  publish(type, event).catch((err) => log.error({ err: String(err) }, 'Publish error'));
}

interface EventChatParams {
  chatUrl: string;
  eventDid: string;
  creatorDid: string;
  creatorId: string;
  nameDisplayPolicy: string | undefined;
}

/** Best-effort: create the event's chat conversation, add the creator as admin, and sync its name-display policy. */
async function createEventChat(params: EventChatParams): Promise<void> {
  const { chatUrl, eventDid, creatorDid, creatorId, nameDisplayPolicy } = params;
  const base = `${chatUrl}/api/d/${encodeURIComponent(eventDid)}`;

  try {
    await fetch(`${base}/members`, {
      method: 'POST',
      headers: JSON_HEADERS,
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
    await fetch(`${base}/context`, {
      method: 'PATCH',
      headers: { ...JSON_HEADERS, ...appAuthHeaders() },
      body: JSON.stringify({ context: { nameDisplayPolicy: nameDisplayPolicy || DEFAULT_NAME_POLICY } }),
    });
  } catch {
    // Best-effort — chat conversation may not exist yet
  }
}

export interface CreateEventParams {
  /** Acting DID that owns the new event. */
  creatorDid: string;
  /** The authenticated identity's id (issuer of the `event.created` domain event). */
  identityId: string;
  input: CreateEventInput;
  correlationId?: string;
}

/**
 * Create a draft event: validate, mint its Ed25519 keypair, register its DID with
 * the kernel, attach the .fair manifest, persist it with its ticket types and open
 * its chat. Requires a hard DID (enforced by the caller).
 */
export async function createEvent(params: CreateEventParams): Promise<CreateEventResult> {
  const { creatorDid, identityId, input, correlationId } = params;
  validateCreateEventInput(input);

  const eventId = `evt_${randomBytes(12).toString('hex')}`;
  const keypair = await generateEventKeypair();
  const eventDid = await registerEventDid(input.title as string, keypair);
  const fairManifest = await buildEventFairManifest(creatorDid, eventDid);

  const event = await repo.insertEvent(
    buildEventRow({ eventId, eventDid, keypair, creatorDid, input, fairManifest }),
  );

  publishBestEffort('event.create', {
    issuer: creatorDid,
    subject: creatorDid,
    scope: SCOPE,
    payload: { eventId: event.id, eventDid: event.did, title: input.title },
    correlationId,
  });
  publishBestEffort('event.created', {
    issuer: identityId,
    subject: identityId,
    scope: SCOPE,
    payload: { eventDid: event.did, title: input.title, context_id: event.id, context_type: 'event' },
  });

  const ticketTypes = await createTicketTypesForEvent(event.id, input.tickets);

  const chatUrl = serviceUrl('chat');
  if (chatUrl) {
    await createEventChat({ chatUrl, eventDid, creatorDid, creatorId: identityId, nameDisplayPolicy: input.nameDisplayPolicy });
  }

  return { event, ticketTypes, eventKeypair: { publicKey: keypair.publicKey, privateKey: keypair.privateKey } };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function serializeEvent(event: EventRow, audience: EventAudience): Record<string, unknown> {
  return audience === 'app' ? filterEventForApp(event) : toPublicEvent(event);
}

/** List events (default status `published`), serialised for the audience. The private key never leaves. */
export async function listEvents(input: ListEventsInput): Promise<Array<Record<string, unknown>>> {
  const rows = await repo.listEvents({
    status: input.status || 'published',
    courseSlug: input.courseSlug,
    upcoming: input.upcoming,
    limit: input.limit,
  });
  return rows.map((event) => serializeEvent(event, input.audience));
}

/** One event with its ticket types and remaining availability (`null` = unlimited). */
export async function getEventWithTicketTypes(
  eventId: string,
  audience: EventAudience,
): Promise<{ event: Record<string, unknown>; ticketTypes: TicketTypeWithAvailability[] }> {
  const event = await repo.getEventById(eventId);
  if (!event) throw new ServiceError('not_found', NOT_FOUND);

  const types = await repo.listTicketTypesForEvent(eventId);
  return {
    event: serializeEvent(event, audience),
    ticketTypes: types.map((t) => ({ ...t, available: t.quantity ? t.quantity - (t.sold || 0) : null })),
  };
}

/** Badge shown on the creator dashboard: published events are `live` until they start, then `past`. */
function resolveStatusBadge(event: EventRow, now: Date): string | null {
  if (event.status !== 'published') return event.status;
  return new Date(event.startsAt) < now ? 'past' : 'live';
}

async function withSalesStats(event: EventRow): Promise<CreatorEvent> {
  const types = await repo.listTicketTypesForEvent(event.id);
  return {
    ...toPublicEvent(event),
    ticketsSold: types.reduce((sum, t) => sum + (t.sold || 0), 0),
    revenue: types.reduce((sum, t) => sum + (t.sold || 0) * t.price, 0),
    statusBadge: resolveStatusBadge(event, new Date()),
    ticketTypes: types,
  };
}

/** Every event the actor created, newest first, with ticket types, sold count, revenue and status badge. */
export async function listCreatorEvents(creatorDid: string): Promise<CreatorEvent[]> {
  const rows = await repo.listEventsByCreator(creatorDid);
  return Promise.all(rows.map((event) => withSalesStats(event)));
}

/** id / title / did of an event by its DID (used by the chat service to resolve event names). */
export async function findEventByDid(did: string): Promise<EventSummary> {
  const event = await repo.getEventSummaryByDid(did);
  if (!event) throw new ServiceError('not_found', NOT_FOUND);
  return event;
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

const VALID_STATUSES = ['draft', 'published', 'paused', 'cancelled', 'completed'] as const;
type EventStatus = (typeof VALID_STATUSES)[number];

const STATUS_TRANSITIONS: Record<EventStatus, EventStatus[]> = {
  draft: ['published'],
  published: ['paused', 'cancelled', 'completed'],
  paused: ['published', 'cancelled'],
  cancelled: [],
  completed: [],
};

function isEventStatus(value: unknown): value is EventStatus {
  return VALID_STATUSES.includes(value as EventStatus);
}

export interface UpdateEventStatusParams {
  eventId: string;
  actorDid: string;
  status: unknown;
}

/** Move an event through its lifecycle (creator only). Only the transitions in the state machine are allowed. */
export async function updateEventStatus(params: UpdateEventStatusParams): Promise<Omit<EventRow, 'privateKey'>> {
  const { eventId, actorDid, status } = params;
  const event = await repo.getEventById(eventId);
  if (!event) throw new ServiceError('not_found', NOT_FOUND);
  if (event.creatorDid !== actorDid) {
    throw new ServiceError('forbidden', 'Only the event creator can change status');
  }
  if (!status || !isEventStatus(status)) throw new ServiceError('invalid', 'Invalid status');

  const currentStatus = (event.status || 'draft') as EventStatus;
  const allowed = STATUS_TRANSITIONS[currentStatus] || [];
  if (!allowed.includes(status)) {
    throw new ServiceError('invalid', `Cannot transition from "${currentStatus}" to "${status}"`);
  }

  const updated = await repo.updateEventById(eventId, { status, updatedAt: new Date() });

  publishBestEffort('event.update', {
    issuer: actorDid,
    subject: actorDid,
    scope: SCOPE,
    payload: { eventId, status },
  });

  return toPublicEvent(updated as EventRow);
}

export interface UpdateEventParams {
  eventId: string;
  actorDid: string;
  body: EventUpdateBody;
  /** The caller's session cookie, forwarded to the kernel's co-host (pod membership) check. */
  callerCookie?: string | null;
}

/** Update an event's details (creator or co-host); a changed name policy is synced to the event chat. */
export async function updateEvent(params: UpdateEventParams): Promise<Omit<EventRow, 'privateKey'>> {
  const { eventId, actorDid, body, callerCookie } = params;
  const event = await repo.getEventById(eventId);
  if (!event) throw new ServiceError('not_found', NOT_FOUND);

  const organizer = await isEventOrganizer(eventId, actorDid, callerCookie);
  if (!organizer.authorized) throw new ServiceError('forbidden', 'Not authorized to update this event');

  // Validates nameDisplayPolicy when present
  const updates = buildEventUpdates(body);
  if ('error' in updates) {
    const { error, status } = updates as { error: string; status: number };
    throw new ServiceError('invalid', error, { status });
  }

  const updated = await repo.updateEventById(eventId, updates as Partial<NewEventRow>);

  const chatUrl = serviceUrl('chat');
  if (body.nameDisplayPolicy !== undefined && updated && chatUrl) {
    await syncNamePolicyToChat(chatUrl, updated.did, body.nameDisplayPolicy);
  }

  publishBestEffort('event.update', {
    issuer: actorDid,
    subject: actorDid,
    scope: SCOPE,
    payload: { eventId },
  });

  return toPublicEvent(updated as EventRow);
}
