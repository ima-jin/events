# 01 - Current state

Part of the events re-architecture design (ima-jin/imajin-ai#2716, step 0 of #1988). Read `README.md` first.

Everything here is taken from code, migrations, CI logs and the public npm registry. No prod, dev or server access was used, and nothing here is a measured prod value (see section 8).

## 0. Sources pinned

- Kernel monorepo `ima-jin/imajin-ai` at `main` e878ce27: `apps/events`, `apps/kernel`, `packages/bus`, `packages/llm`, `migrations/`.
- `ima-jin/events` `rearchitect` at 2e1e019 (events#1, schema port) and the events#2 head branch `feat/2515-events-routes-port` (draft).
- `ima-jin/imajin-app-template` `main` at 0c583ca (the registered-app contract).
- `ima-jin/dykil` `main` at 2967539, read only for the cross-app contract with events.
- `registry.npmjs.org`, public, for which `@ima-jin/*` packages exist.

Convention used below: route ids are `R01`-`R66`, table ids `T1`-`T8`, kernel calls out of events `K01`-`K16`, kernel and cross-app calls into events `I01`-`I10`, findings `F01`-`F16`. `03-mapping.md` maps every id to its new home.

## 1. At a glance

- `apps/events` is about 27.3k lines of TypeScript and TSX: 54 `route.ts` files holding 66 method-and-path handlers, 13 pages, 31 non-page components, 17 files in `src/lib`, 30 test files.
- 8 tables in one schema (`events`), 126 columns, 26 non-primary-key indexes, 10 foreign-key constraints (counted from `migrations/0000_events_schema.sql` on `rearchitect`).
- 17 distinct bus event types published from 26 call sites. Buyer confirmation emails depend on kernel reactors reacting to them (section 7.3).
- 9 tables owned by the kernel or by another app are read or written by raw SQL from events code, across 6 schemas, in 28 non-test files (section 6.1, K15).
- 13 `@imajin/*` workspace packages are declared and 9 are actually imported. Three of the imported ones (`bus`, `chat`, `email`) have no published `@ima-jin/*` equivalent (section 6.4).
- The kernel calls back into events from 5 places and reads events tables directly in 2 files (section 6.2).
- Dykil has already been rebuilt without a database: attendee answers are now attestations, so events' joins against `dykil.survey_responses` point at a table that is being retired (section 6.3).
- 37 environment variables are documented in `apps/events/.env.example`, including six secrets or keys that are shared with or issued by the kernel.

## 2. Routes (R01-R66)

Guard column legend, from identifiers found in each route file (a helper could add a check this scan cannot see, so "none" means "no guard identifier in the file", not "proven open"):

- `auth` = `requireAuth` (session). `appAuth` = `requireAppAuth` (scoped app token). `admin` = `requireAdmin`. `hardDid` = `requireHardDID`. `policy` = `enforceRoutePolicy` (delegation policy). `secret` = shared-secret header or bearer. `none` = no guard identifier.
- Where a file exports several methods, the guard set is for the whole file.

| Id | Method | Path under `/api` | Guard | What it does | Kernel touch | Bus types published |
|----|--------|-------------------|-------|--------------|--------------|---------------------|
| R01 | GET | `/access/[did]` | session cookie only | Same-origin proxy to the kernel's `/api/access/{did}` | kernel auth | - |
| R02 | GET | `/admin/events/export.csv` | admin | CSV of all events with sold counts | kernel auth lookup | - |
| R03 | GET | `/attending/[did]` | none | Events a DID attends (tickets `sold`/`used`, plus pod-member events) | SQL `connections.pod_members` | - |
| R04 | GET | `/balance` | auth | Proxies the caller's balance from pay | pay | - |
| R05 | POST | `/campaign/[eventId]/cancel` | policy+auth | Organizer cancels a campaign and its pledges | - | - |
| R06 | GET | `/campaign/[eventId]/my-pledge` | auth | The caller's pledge | - | - |
| R07 | GET | `/campaign/[eventId]/pledges` | auth | Organizer's pledge list | - | - |
| R08 | POST | `/campaign/[eventId]/settle` | policy+auth | Charges saved pledges once the target is met | pay `charge-pledges` | - |
| R09 | GET | `/campaign/[eventId]/status` | none | Public campaign progress | - | - |
| R10 | POST | `/campaign/pledge/confirm` | auth | Confirms the SetupIntent for a pledge | pay | - |
| R11 | POST | `/campaign/pledge` | auth | Creates a pledge and a SetupIntent | pay `setup-intent` | - |
| R12 | POST | `/checkout/balance` | policy+auth | Buy with Imajin balance | pay balance transfer; helper SQL `auth.identities` | - |
| R13 | POST | `/checkout/etransfer` | none | Interac e-Transfer purchase, 72 hour hold | helper SQL `auth.identities` | via helper: `ticket.reserved` |
| R14 | POST | `/checkout/free` | none | Free RSVP ticket | helper SQL `auth.onboard_tokens` | `ticket.purchased` (+ helper `ticket.confirmed`) |
| R15 | POST | `/checkout` | none | Stripe checkout through pay, guest allowed | pay `checkout` | `ticket.purchase` |
| R16 | GET | `/events/[id]/access` | appAuth (`events:read`) | Boolean ticket-holder gate used by Dykil | - | - |
| R17 | GET | `/events/[id]/cohosts` | policy+auth | List co-hosts | kernel auth lookup, connections pods, chat members; SQL `connections.pod_members` | - |
| R18 | POST | `/events/[id]/cohosts` | policy+auth | Add or remove co-host | same as R17 | - |
| R19 | PATCH | `/events/[id]/fair` | policy+auth | Edit the event's `.fair` manifest (stored in `events.metadata`) | - | - |
| R20 | GET | `/events/[id]/guests/export.csv` | auth | Guest list CSV | kernel auth lookup; SQL `dykil.survey_responses` | - |
| R21 | GET | `/events/[id]/guests` | appAuth+auth | Guest list with registration answers | kernel auth lookup; SQL `dykil.survey_responses` | - |
| R22 | DELETE | `/events/[id]/hold` | auth | Release a seat hold | - | - |
| R23 | POST | `/events/[id]/hold` | auth | Hold tickets for a buyer | - | - |
| R24 | DELETE | `/events/[id]/invites/[inviteId]` | auth | Delete an invite link | - | - |
| R25 | GET | `/events/[id]/invites` | auth | List invite links | - | - |
| R26 | POST | `/events/[id]/invites` | auth | Create an invite link | - | - |
| R27 | GET | `/events/[id]/message` | auth + secret | Preview audience for an organizer message | kernel auth lookup, notify | - |
| R28 | POST | `/events/[id]/message` | auth + secret | Organizer broadcast to attendees | kernel auth lookup, notify `broadcast` | - |
| R29 | GET | `/events/[id]/my-ticket` | auth | The caller's ticket and role | SQL `connections.pod_members` | - |
| R30 | DELETE | `/events/[id]/queue` | auth | Leave the waiting list | - | - |
| R31 | GET | `/events/[id]/queue` | auth | Queue position | - | - |
| R32 | POST | `/events/[id]/queue` | auth | Join the waiting list | - | - |
| R33 | GET | `/events/[id]` | appAuth+auth | Read an event | chat | `event.update` (file level) |
| R34 | PATCH | `/events/[id]` | appAuth+auth | Edit an event | chat context | `event.update` |
| R35 | PUT | `/events/[id]` | appAuth+auth | Replace an event | chat context | `event.update` |
| R36 | GET | `/events/[id]/sales/export` | auth | Sales CSV | kernel auth lookup | - |
| R37 | GET | `/events/[id]/sales` | auth | Organizer sales dashboard data | SQL `pay.transactions`, `dykil.survey_responses` | - |
| R38 | POST | `/events/[id]/tickets/[ticketId]/cancel` | policy+auth | Cancel a ticket | - | - |
| R39 | POST | `/events/[id]/tickets/[ticketId]/check-in` | auth | Check a ticket in (organizer or co-host) | kernel eligibility; optional `CHECKIN_WEBHOOK_URL` | `checkin.create`, `event.attendance` |
| R40 | POST | `/events/[id]/tickets/[ticketId]/mark-refund-sent` | policy+auth | Mark an e-Transfer refund as sent | - | - |
| R41 | POST | `/events/[id]/tickets/[ticketId]/refund` | policy+auth | Refund a ticket | pay `refund`; SQL `dykil.survey_responses` | `ticket.refunded` |
| R42 | GET | `/events/[id]/tickets/[ticketId]/registration-status` | auth | Registration status | - | - |
| R43 | GET | `/events/[id]/tickets/[ticketId]/registration` | auth | Attendee answers | SQL `dykil.survey_responses`, `dykil.surveys` | - |
| R44 | POST | `/events/[id]/tickets/[ticketId]/resend-email` | auth | Resend confirmation or registration reminder | kernel auth; SQL `auth.onboard_tokens`, `dykil.survey_responses` | `ticket.confirmed`, `ticket.registration.reminder` |
| R45 | GET | `/events/[id]/tiers` | appAuth+auth | List ticket tiers | - | - |
| R46 | POST | `/events/[id]/tiers` | appAuth+auth | Create a tier | - | - |
| R47 | PUT | `/events/[id]/tiers` | appAuth+auth | Update tiers | - | - |
| R48 | GET | `/events/[id]/tiers/unlock` | none | Unlock a tier by access code | - | - |
| R49 | GET | `/events/by-did/[did]` | none | Public event lookup by event DID (called by kernel chat) | - | - |
| R50 | GET | `/events/mine` | auth | Events the caller organizes | - | - |
| R51 | GET | `/events` | internal key + appAuth + hardDid (file level) | List events | kernel auth | `event.create`, `event.created` (file level) |
| R52 | POST | `/events` | same | Create an event, mint its keypair, register its DID, open its chat lobby | kernel auth `register`, chat `members`+`context`; SQL `chat.conversations_v2` | `event.create`, `event.created` |
| R53 | GET | `/health` | none | Health | - | - |
| R54 | GET | `/media/[...path]` | none | Serves event images from local disk | - | - |
| R55 | POST | `/migrate-tickets` | optional secret | Re-owns tickets bought with an email from soft DID to hard DID | chat `participants/migrate`; SQL `auth.identities` | - |
| R56 | POST | `/orders/[id]/confirm-payment` | policy+auth | Organizer confirms an e-Transfer order | helper `confirm-payment` | via helper |
| R57 | POST | `/orders/[id]/refund` | policy+auth | Refund a whole order | pay `refund` | `order.refunded` |
| R58 | GET | `/proxy/connections` | none | Proxies the kernel connection list | connections | - |
| R59 | GET | `/register/[ticketId]` | none | Read registration form state | SQL `dykil.survey_responses` | - |
| R60 | POST | `/register/[ticketId]` | none | Submit attendee registration | SQL `dykil.survey_responses` | `event.registration`, `event.rsvp`, `ticket.registration.completed` |
| R61 | GET | `/spec` | none | Serves the OpenAPI document | - | - |
| R62 | POST | `/tickets/[id]/confirm-payment` | policy+auth | Organizer confirms one e-Transfer ticket | helper `confirm-payment` | via helper |
| R63 | GET | `/tickets/[id]/qr` | none | QR image for a ticket id | - | - |
| R64 | POST | `/upload` | none | Image upload to `/mnt/media/events` | local disk | - |
| R65 | POST | `/webhook/payment` | shared bearer | Pay's payment-completed callback: creates tickets and order | kernel auth `session/soft`, chat; SQL `profile.profiles` | `order.completed`, `ticket.purchased` (+ helpers `ticket.confirmed`, `ticket.receipt`) |
| R66 | POST | `/webhook/settlement` | shared header | Stores the `.fair` settlement snapshot on the order | - | - |

Bus types published from library helpers rather than route files (all counted in the 26 call sites): `ticket.confirmed` (5 sites), `ticket.receipt` (2), `ticket.purchased` (3 helper sites), `ticket.reserved` (1).

## 3. UI surface

- 13 `page.tsx` files. Two parallel trees exist for the same pages: `app/[eventId]/...` (3 pages) and `app/e/[eventId]/...` (3 pages plus its components), plus `app/admin` (2), `app/create`, `app/dashboard`, `app/checkout/success`, `app/page.tsx`, and `app/api/page.tsx`.
- The `app/[eventId]` tree and the `app/e/[eventId]` tree duplicate the event page, the edit page and the register page. Which one is canonical was not determined from code (see DECISION cards in `06-decisions.md`).
- Pages read the database directly with raw SQL for kernel data (`connections.pod_members` in four pages, `profile.profiles` in the dashboard, `auth.onboard_tokens` in checkout success), so the UI is entangled with the kernel as well as the routes.
- Kernel UI packages used: `@imajin/ui` (14 imports), `@imajin/chat` (`Chat`, `ChatProvider`, `useChatWebSocket`, `NameDisplayPolicy`), `@imajin/fair/react` (`FairEditor`, `FairAccordion`).

## 4. Tables (T1-T8)

Source of truth for shape: `src/db/schema.ts` (kernel) equals `migrations/0000_events_schema.sql` (events#1). Counts are columns per table.

| Id | Table | Cols | Role | Notes from code |
|----|-------|------|------|-----------------|
| T1 | `events.events` | 36 | An event or a funding campaign | `did` unique (the event's own DID); `public_key` and nullable `private_key` (Ed25519 hex) stored in the row; `event_type` is `event` or `campaign`; `access_mode` is `public` or `invite_only`; `registration_config`, `tags`, `metadata` are jsonb; the `.fair` revenue manifest lives at `metadata.fair`; `pod_id` and `lobby_conversation_id` and `course_slug` are plain text pointers into kernel or other-app data |
| T2 | `events.ticket_types` | 16 | A tier | `price` integer cents; `quantity` null means unlimited; `sold` is a denormalized counter; `registration_form_id` points at a Dykil survey; `access_code` hides a tier |
| T3 | `events.orders` | 16 | Tickets bought together | `ticket_type_id` null for multi-type orders; `payment_method` is `stripe`, `etransfer`, `free` or balance; `fair_settlement` jsonb written by the settlement webhook; `buyer_email` |
| T4 | `events.tickets` | 22 | One ticket | `owner_did` can be a soft DID; `order_id` null for legacy tickets; `signature` text; `hold_expires_at` for e-Transfer; `registration_status` is `not_required`, `pending` or `complete`; `metadata.purchaseEmail` links a ticket to a buyer email |
| T5 | `events.ticket_transfers` | 6 | Transfer log | Table exists; no route in `apps/events` writes to it (grep found none) |
| T6 | `events.ticket_queue` | 8 | Waiting list | Backs R30-R32 |
| T7 | `events.event_invites` | 8 | Invite links | `token` unique; `max_uses`, `used_count`, `expires_at` |
| T8 | `events.pledges` | 14 | Campaign pledges | Stripe SetupIntent, payment method and customer ids; `mjnx_escrow_id` reserved for a future escrow |

Dropped earlier: `events.ticket_registrations` was dropped by kernel migration 0027 (#826). Attendee identity moved to `dykil.survey_responses`, joined by `ticket_id`.

Vocabularies actually written by code (the schema comments are stale in places):

- Ticket status written: `available`, `held`, `valid`, `used`, `cancelled`, `refunded`. The schema comment lists `sold`, but no code writes `sold` (F01).
- Order status: `pending`, `completed`, `cancelled` per the schema comment. Not audited further. The kernel's drizzle file defaulted `orders.status` to `completed` while the real database default is `pending`; events#1 fixed the baseline to match the database.
- Pledge status: `pending`, `confirmed`, `charged`, `failed`, `cancelled`.

## 5. Flows today (what the outcome actually runs through)

1. Create an event (R52): generates an Ed25519 keypair in the request, signs a registration payload, calls the kernel to register the event DID, inserts the event row including the private key, opens a chat lobby, then publishes `event.create` and `event.created`.
2. Sell a ticket by card (R15, R65): R15 validates the cart and calls pay to open a Stripe session; pay's own webhook handler later calls events R65; R65 creates the order and tickets, resolves or creates a soft DID for a guest buyer, adds the buyer to the lobby, publishes `ticket.purchased`, `ticket.confirmed`, `ticket.receipt`, then publishes `order.completed` to start `.fair` settlement. Pay then publishes `settlement.completed`, and a kernel webhook reactor calls R66 to store the snapshot on the order.
3. Confirmations: events only publishes. The kernel bus config attaches notify reactors to `ticket.purchased`, `ticket.receipt`, `ticket.confirmed`, `ticket.reserved`, `ticket.refunded`, `ticket.registration.reminder` and `event.registration`, and kernel notify holds the 7 templates (scopes `event:ticket`, `event:registration`, `event:ticket-receipt`, `event:ticket-confirmed`, `event:ticket-reserved`, `event:ticket-refunded`, `event:ticket-registration-reminder`). Users also manage opt-out per scope on kernel settings pages. `ticket.purchased` additionally attaches an attestation and an emission reactor.
4. Check in (R39): organizer or co-host posts the ticket id; the ticket must be `valid` and unused; it is set to `used`; `checkin.create` and `event.attendance` are published; the kernel is asked to evaluate tier eligibility; an optional webhook URL is called. The QR image encodes only the ticket id (R63 is unauthenticated); nothing in `apps/events` verifies the stored `signature`.

## 6. Kernel entanglements

### 6.1 Events to kernel (K01-K16)

| Id | Entanglement | Detail | Guard on the kernel side |
|----|--------------|--------|--------------------------|
| K01 | Event DID registration | `POST auth /api/register`, payload signed with the event key (R52) | session check (`getSession`) in the route file |
| K02 | Identity lookup | `GET auth /api/lookup/{did}` from at least 4 server-side call sites (cohosts route, cohost helper, admin export) plus the event page and the chat wrapper | no guard identifier in the route file |
| K03 | Soft identity | `POST auth /api/session/soft` to turn a guest email into a DID (R65, checkout-common) | no guard identifier |
| K04 | Eligibility | `evaluateEligibility()` from `@imajin/auth`, hits kernel eligibility route | kernel internal API key |
| K05 | Contact backfill | `backfillContactEmail()` from `@imajin/auth` | kernel internal API key |
| K06 | Identity helpers | `resolveActingDid` (38 uses), `resolveIdentitiesForDids` (5), `resolveEmailForDid` (2) from `@imajin/auth`; transport not audited | n/a |
| K07 | Pay checkout | `POST pay /api/checkout` (R15 and balance helper) | no guard identifier |
| K08 | Pay refund | `POST pay /api/refund` (R41, R57) using `PAY_SERVICE_API_KEY` | shared service bearer key |
| K09 | Pledges | `POST pay /api/setup-intent` (R11), `POST pay /api/charge-pledges` (R08) | `setup-intent`: session; `charge-pledges`: shared service key |
| K10 | Balance | `GET pay /api/balance/{did}` (R04), `POST pay /api/balance/transfer` (R12) | `balance/{did}`: appAuth or session; `transfer`: no guard identifier |
| K11 | Pods (co-hosts) | `connections /api/pods/{id}` (two calls in R17 and R18) and `GET /api/connections` (R58) | session only |
| K12 | Chat | `POST chat /api/d/{eventDid}/members` and `/context`, `POST chat /api/participants/migrate` | `members`: session; `context`: internal key or session; `migrate`: no guard identifier |
| K13 | Notify | `POST notify /api/broadcast` (R27, R28) | shared `x-webhook-secret` |
| K14 | Bus | `publish()` from `@imajin/bus`, in-process, 17 types, 26 sites | n/a (in-process import) |
| K15 | Direct SQL into kernel-owned or other-app schemas | Files per table, non-test: `connections.pod_members` 8, `dykil.survey_responses` 8, `dykil.surveys` 2, `auth.onboard_tokens` 5, `auth.identities` 5, `profile.profiles` 3, `pay.transactions` 1, `auth.credentials` 1, `chat.conversations_v2` 1 (a write); 28 distinct files in total | none; bypasses every API |
| K16 | Boot-time kernel credential | `instrumentation.ts` registers the DB log sink `@imajin/logger/db` (writes `registry.logs`) and calls `bootstrapInternalApiKey('events')` to fetch a vault-sourced kernel internal key | n/a |

Also kernel-adjacent: R54 and R64 read and write `/mnt/media/events` on the host disk instead of the kernel media service; `src/lib/email.ts` re-exports `generateQRCode` from `@imajin/email`.

### 6.2 Kernel (and others) to events (I01-I10)

| Id | Caller | What it calls in events | Mechanism |
|----|--------|-------------------------|-----------|
| I01 | Kernel pay webhook handler `notifyEventsService` | `POST /api/webhook/payment` | env `EVENTS_SERVICE_URL`, bearer `EVENTS_WEBHOOK_SECRET`; events reads the bearer from `WEBHOOK_SECRET`, so two env names must hold one value |
| I02 | Kernel bus `settlement.completed` chain, webhook reactor | `POST /api/webhook/settlement` | env `EVENTS_SERVICE_URL`, header `x-webhook-secret` from `WEBHOOK_SECRET`; reactor disabled when `EVENTS_SERVICE_URL` is unset |
| I03 | Kernel `auth/onboard/verify` | `POST /events/api/migrate-tickets` (R55), fire and forget, no auth header, default port 7006 | env `EVENTS_SERVICE_URL` |
| I04 | Kernel chat `resolveConversationName` | `GET /api/events/by-did/{did}` (R49), default port 3006 | env `EVENTS_SERVICE_URL` |
| I05 | Kernel LLM presence tools (`packages/llm/src/tools/events.ts`, wired by profile `query` and `stream` routes) | `GET /api/events`, `/api/events/{id}`, `/api/events/mine` with the internal API key | env `EVENTS_SERVICE_URL` |
| I06 | Kernel auth `access/[did]` route and `src/lib/kernel/access.ts` | Not an HTTP call: reads `events.tickets` and `events.events` directly to decide chat access for event DIDs | shared database |
| I07 | Kernel nav and profile community tabs | Link only | env `NEXT_PUBLIC_EVENTS_URL` and `EVENTS_SERVICE_URL` |
| I08 | Kernel bus chain config (`packages/bus/src/config.ts`) | Reactors for the 17 types; `order.refunded` has no default chain in code (DB overrides in `kernel.bus_chain_configs` cannot be audited from code) | in-process |
| I09 | Kernel notify | 7 `event:*` templates and 2 settings pages that list event scopes | kernel code and migrations 0158 |
| I10 | Dykil ticket gate | `GET /api/events/{id}/access?did=` (R16) with an `events:read` app token | public app contract (#2395, closed) |

Kernel migrations that mention the `events` schema: 13 files (`0001_seed`, `0012`, `0015`, `0016`, `0017`, `0019`, `0021`, `0025`, `0026`, `0027`, `0031`, `0032`, `0033`). Two of them run data statements on events rows (`0025` updates `events.tickets.registration_status`; `0031` rewrites `ticket_types.currency` from USD to CAD), and `0026` writes only to `dykil`.

### 6.3 Dykil and events depend on each other

- Today events reads attendee names, emails and answers from `dykil.survey_responses` in 8 files (the routes behind R20, R21, R37, R41, R43, R44, R59 and R60, plus `src/lib/guest-export-helpers.ts`) and ties a ticket to a form through `ticket_types.registration_form_id`.
- Dykil (ima-jin/dykil) now owns no tables. A survey is a signed media asset; a response is an attestation whose indexed `ref` is the ticket id; Dykil's own docs record that events "still reads it cross-schema (imajin-ai#2542) until it is moved off". Dykil lists the legacy tables as retained read-only until retired.
- In the other direction Dykil calls events through R16 and treats it as the only way to learn ticket ownership. R16 must keep working through the move.
- Dykil's public API gives an owner export of all responses for a survey (cursor-paged, owner only) and a per-ticket existence check (`responses/check?ticketId=`). It has no "answers for these N ticket ids" call, which is what the guest list needs (see the `gap(dykil)` note in `05-kernel-gaps.md`).

### 6.4 Package and SDK availability

Events' package.json (kernel) declares 13 `@imajin/*` workspace packages (`auth`, `bus`, `chat`, `config`, `db`, `email`, `emit`, `fair`, `input`, `logger`, `notify`, `onboard`, `ui`); source imports 9 of them (`auth`, `bus`, `chat`, `config`, `db`, `email`, `fair`, `logger`, `ui`). Published `@ima-jin/*` status on the public registry at the time of writing:

- Published: `auth` 0.8.13, `auth-client` 0.8.8, `config` 0.8.13, `logger` 0.8.13, `fair` 0.8.0, `ui` 0.8.0, `db` 0.8.0, `onboard` 0.8.15, `tokens` 0.8.0, `media` 0.8.15.
- Not published: `bus`, `chat`, `email`, `emit`, `input`, `notify`, `money`.
- `@ima-jin/db` is published but the registered-app contract forbids using it (it reaches kernel data); `@ima-jin/auth` is published and is what events#2 uses.

### 6.5 Environment and secrets

`apps/events/.env.example` documents 37 variables. Six of them are secrets or keys shared with or issued by the kernel: `PAY_SERVICE_API_KEY`, `AUTH_INTERNAL_API_KEY`, `PROFILE_INTERNAL_API_KEY`, `NOTIFY_WEBHOOK_SECRET`, `WEBHOOK_SECRET` and `EVENTS_VAULT_BOOTSTRAP_PRIVATE_KEY`. Code also reads `INTERNAL_SECRET` (R55), which `.env.example` does not list. The registered-app contract allows none of these beyond the app's own registration credentials.

## 7. Cross-cutting facts that shape the design

### 7.1 Authority inversion on money

In R65 events publishes `order.completed` with `issuer` set to the buyer's DID, `subject` set to the organizer, and the event's `.fair` manifest in the payload; a kernel reactor then runs the split. The app is telling the kernel who should be paid, in the buyer's name.

### 7.2 Ticket proof

The ticket `signature` is created at purchase (an Ed25519 signature over `ticketId:eventDid:email:timestamp`, a base64 string when the event has no private key, or the literal pattern `free:{ticketId}:{ownerDid}` for free tickets) and never verified anywhere in `apps/events`. A QR code carries the ticket id only. Validity today means "a row with that id exists, status `valid`, unused". That is also the migration requirement in #2529: old QR codes keep validating if ticket ids survive.

### 7.3 Confirmations are a kernel side effect

Because events only publishes, a port that cannot publish (see events#2, section 10) sends no confirmation, receipt or reservation email at all.

### 7.4 Holds expire lazily

Seat and e-Transfer holds are released only when the next hold or checkout request for the event runs. No scheduled sweeper was found in `apps/events` or in kernel `scripts/`.

## 8. Prod data shape at count level (from code only)

No row counts exist in code for current prod, so none are stated. What code does give:

- Structure: 8 tables, 126 columns, 26 indexes, 10 foreign keys. Money is integer cents; default currency CAD (migration 0031 converted `USD` ticket types to `CAD`).
- Historical counts left in migration comments: before `events.ticket_registrations` was dropped (2026-05-11) it held 69 rows in prod and 11 in dev; the earlier backfill in `0025` linked about 14 survey responses and seeded about 24 partial responses in prod.
- Shapes to expect in prod, inferred from code paths: legacy tickets with null `order_id`; tickets owned by soft DIDs (matched to a buyer by `metadata.purchaseEmail`); events with a null `private_key` (the base64 signature fallback exists for them); tickets whose signature is a `free:` pattern; e-Transfer tickets in `held` status past `hold_expires_at`; `ticket_types.sold` counters that can drift from real ticket counts; tickets whose attendee answers exist only as Dykil attestations after the Dykil import.
- Counts the operator must capture during the #2529 sanitization step (not derivable here): rows per table; tickets by status and by payment method; events by status and by `event_type`; tickets with null `order_id`; tickets owned by soft DIDs; events with a null `private_key`; held tickets past expiry; tickets with a registration form and how many registrations are `pending`; pledges by status; orders with a non-null `fair_settlement`.

## 9. Findings (F01-F16)

These are defects or hazards found while reading. They are described, not fixed.

- F01 Status vocabulary drift: R16 and R03 count only `sold` and `used` as "holds a ticket", but no code writes `sold`; paid tickets are `valid`. A paid, unused ticket therefore fails the gate that Dykil depends on. Meanwhile the kernel chat access check (`src/lib/kernel/access.ts`) counts anything not `cancelled` or `available` (so `held` and `refunded` pass), and R28 counts `valid` and `used`. Three definitions of "holds a ticket" exist.
- F02 Event private keys are stored in the events table and the creation response carries a warning comment ("Creator must secure this"). They are used only to sign tickets that nothing verifies (section 7.2).
- F03 R55 checks its secret only when `INTERNAL_SECRET` is set, and the kernel caller (I03) sends no `Authorization` header. If the secret is set, the kernel call is refused; if it is unset, any caller who knows an email and a DID can re-own matching soft-DID tickets.
- F04 R64 accepts uploads with no guard, takes the file extension from the client file name, and writes to a fixed host path outside the repository.
- F05 R59 and R60 carry no guard identifier; the ticket id in the path is the only credential.
- F06 Webhook secrets: I01 sends `EVENTS_WEBHOOK_SECRET` and R65 reads `WEBHOOK_SECRET`; R66 and the kernel bus reactor share `WEBHOOK_SECRET`. Two names for one value invites silent mismatch.
- F07 Confirmation, receipt and attestation side effects exist only as kernel reactors (section 7.3); there is no public route for an app to publish into the bus.
- F08 Authority inversion on settlement (section 7.1).
- F09 Event DIDs are registered in kernel `auth.identities` while the event row lives in events; deleting or restoring one side leaves the other.
- F10 Two parallel page trees for the same event pages (`app/[eventId]` and `app/e/[eventId]`).
- F11 `src/lib/email.ts` depends on unpublished `@imajin/email` for QR generation, which events#2 replaced with the `qrcode` package.
- F12 `apps/events/MIGRATIONS.md` describes columns that do not exist in the schema (slug, tagline, visibility, contact email); it is stale.
- F13 Holds expire only lazily (section 7.4).
- F14 Ports of the kernel code inherit the check-in status check `status !== 'valid'` and the `sold` constants unchanged (events#2 did).
- F15 Kernel chat access for event DIDs reads events tables directly (I06), a hard reverse dependency that blocks the prune (#2517).
- F16 `ticket_transfers` has no writer in `apps/events` (T5), so transfers are modelled but not implemented.

## 10. What events#1 ported and what events#2 holds

events#1 (merged to `rearchitect`, 2e1e019): the template scaffold (auth callback, logout, session, me, health and spec routes), `src/db/schema.ts` and `migrations/0000_events_schema.sql` reproducing the kernel's final `events` schema (8 tables), a schema test, and `scripts/verify-migrations.sh`. The template files that were added to the template after the fork are missing from events: `/claim` route and page, `middleware.ts`, `docs/DEPLOY.md`, `scripts/check-migrations.mjs`, `scripts/check-registry-deps.mjs`, `scripts/audit-gate.mjs`, the security-audit, check-migrations and sonar-trust-check workflows.

events#2 (draft, head `feat/2515-events-routes-port`, PR base `main`): 100 changed files, 14,779 added lines, 0 deleted.

- 58 route files (the 54 kernel files plus 4 template auth/me routes), 17 library files, 30 test files, no UI beyond the template's single `app/page.tsx`.
- The kernel seam is two files: `src/lib/kernel.ts` (a generic fetch helper plus `resolveProfiles`, `getContactEmail`, `getIdentityTier`, `isPodMember`, `listMemberPodIds`, `evaluateEligibility`, `backfillContactEmail`, `createOnboardToken`) and `src/lib/domain-events.ts` (`publish()`).
- Every helper in the seam is non-throwing and degrades to a fallback. `createOnboardToken()` always returns null. `publish()` is a logged no-op unless `IMAJIN_EVENTS_PUBLISH_PATH` is set, and the kernel exposes no such route. `isPodMember` and `listMemberPodIds` only work when a caller's session cookie can be forwarded. `docs/KERNEL-GAPS.md` is cited in the code but does not exist on the branch.
- Raw SQL against kernel schemas was removed from the source (one remaining hit is a comment). 18 files still use raw SQL, against the events schema.
- Dependencies: `@ima-jin/auth`, `auth-client`, `config`, `fair`, `logger` plus `@noble/ed25519`, `@noble/hashes`, `qrcode`. No `@imajin/*` imports remain in source (one code comment still names `@imajin/bus`), but 12 test files still mock `@imajin/*` module names.
- CI at the last run (run 37503866411, 2026-10-06): `Test + build` fails with 18 of 28 test files failing (module resolution of `@ima-jin/logger` and `@ima-jin/auth` in tests, a logger mock missing `createLogger`, and a test that opens `../kernel/api-spec/pay.yaml` from a sibling monorepo checkout). SonarCloud on that PR reports 49 open issues and a failing gate (new reliability rating 3 against a threshold of 1; new duplicated lines 7.0 percent against 3).
- The PR base is `main`, which conflicts with the ruling that PRs target `rearchitect`; retargeting needs the owner and was not touched here.
