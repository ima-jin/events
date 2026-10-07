# 03 - Old to new mapping

Maps every route, table, kernel call, inbound call, package and kernel-shared secret from `01-current-state.md` to its place in `02-proposed-architecture.md`.

Disposition words:

- KEEP - same public path and method, re-implemented as a thin handler over a use case. Behaviour is in the parity set unless a note says otherwise.
- CHANGE - same path, intentional behaviour change (listed in `02` section 9).
- REPLACE - the capability stays, the mechanism and possibly the path change.
- REMOVE - the capability is deleted; the note says what covers the need.
- Dnn - decision card in `06-decisions.md`. Gnn - gap in `05-kernel-gaps.md`.

## 1. Routes (R01-R66)

| Old | Method and path | Disposition | New home and notes |
|-----|-----------------|-------------|--------------------|
| R01 | GET `/api/access/[did]` | REMOVE | Browser asks kernel chat directly. Depends on G12 (kernel chat access stops reading events tables). |
| R02 | GET `/api/admin/events/export.csv` | KEEP | Platform-admin only; names resolved in one batch through the Identity port. Admin check becomes a kernel-granted scope (G13). |
| R03 | GET `/api/attending/[did]` | CHANGE | Uses `holdsTicket()` (D13) and the local organizers table (D07) instead of `connections.pod_members`. Confirm in the soak what pod roles used to appear in this list. |
| R04 | GET `/api/balance` | REPLACE | Checkout page reads the balance through the Payments port on the server; no public proxy route. |
| R05 | POST `/api/campaign/[eventId]/cancel` | KEEP | Deferred from the first cut (D17); same logic afterwards. |
| R06 | GET `/api/campaign/[eventId]/my-pledge` | KEEP | D17. |
| R07 | GET `/api/campaign/[eventId]/pledges` | KEEP | D17. |
| R08 | POST `/api/campaign/[eventId]/settle` | CHANGE | Payments port `chargePledges` under an app-scoped right (D06, G05). D17. |
| R09 | GET `/api/campaign/[eventId]/status` | KEEP | D17. Public. |
| R10 | POST `/api/campaign/pledge/confirm` | KEEP | Payments port. D17. |
| R11 | POST `/api/campaign/pledge` | KEEP | Payments port `setupIntent`. D17. |
| R12 | POST `/api/checkout/balance` | KEEP | `startCheckout` balance branch; Payments port debit; guest-identity lookup through the Identity port, not `auth.identities`. |
| R13 | POST `/api/checkout/etransfer` | KEEP | `startCheckout` e-Transfer branch; hold released by the sweeper (D14). |
| R14 | POST `/api/checkout/free` | KEEP | `startCheckout` free branch; no `auth.onboard_tokens` write (D11). |
| R15 | POST `/api/checkout` | KEEP | `startCheckout` card branch; Payments port `createSession`. No `ticket.purchase` bus publish. |
| R16 | GET `/api/events/[id]/access` | CHANGE | Same path, scope and `{ hasAccess }` answer; computed with `holdsTicket()` (D13). Dykil depends on it. |
| R17 | GET `/api/events/[id]/cohosts` | KEEP | Reads `event_organizers` (D07); names via Identity port. |
| R18 | POST `/api/events/[id]/cohosts` | CHANGE | Writes `event_organizers`; pod and chat mirror are deferred outbox effects, not on the request path. |
| R19 | PATCH `/api/events/[id]/fair` | KEEP | Domain validation through published `@ima-jin/fair`. |
| R20 | GET `/api/events/[id]/guests/export.csv` | CHANGE | Reads `ticket_attendees` (D08); no `dykil.*` SQL. Same columns. |
| R21 | GET `/api/events/[id]/guests` | CHANGE | Same, plus Forms port for full answers on demand. |
| R22 | DELETE `/api/events/[id]/hold` | KEEP | Domain hold rules. |
| R23 | POST `/api/events/[id]/hold` | KEEP | Domain hold rules. |
| R24 | DELETE `/api/events/[id]/invites/[inviteId]` | KEEP | - |
| R25 | GET `/api/events/[id]/invites` | KEEP | - |
| R26 | POST `/api/events/[id]/invites` | KEEP | - |
| R27 | GET `/api/events/[id]/message` | CHANGE | Audience from `holdsTicket()`; no shared-secret header. |
| R28 | POST `/api/events/[id]/message` | CHANGE | Notifications port broadcast through the outbox (D02, G03). |
| R29 | GET `/api/events/[id]/my-ticket` | CHANGE | Organizer role from `event_organizers`, not `connections.pod_members`. |
| R30 | DELETE `/api/events/[id]/queue` | KEEP | - |
| R31 | GET `/api/events/[id]/queue` | KEEP | - |
| R32 | POST `/api/events/[id]/queue` | KEEP | - |
| R33 | GET `/api/events/[id]` | KEEP | Public read stays for kernel presence tools until re-pointed (G10). |
| R34 | PATCH `/api/events/[id]` | CHANGE | Chat context update and attestation are deferred outbox effects; no `event.update` bus publish. |
| R35 | PUT `/api/events/[id]` | CHANGE | Same as R34. |
| R36 | GET `/api/events/[id]/sales/export` | CHANGE | Names via Identity port; payment fee and net from the Payments port read cached on the order (G06). |
| R37 | GET `/api/events/[id]/sales` | CHANGE | No `pay.transactions` or `dykil.*` joins; Payments port read plus `ticket_attendees`. |
| R38 | POST `/api/events/[id]/tickets/[ticketId]/cancel` | KEEP | Domain lifecycle rule. |
| R39 | POST `/api/events/[id]/tickets/[ticketId]/check-in` | CHANGE | `02` section 6.4: one transaction, local organizer check, `409` on repeat, attestation and eligibility deferred. |
| R40 | POST `/api/events/[id]/tickets/[ticketId]/mark-refund-sent` | KEEP | - |
| R41 | POST `/api/events/[id]/tickets/[ticketId]/refund` | CHANGE | Payments port refund under an app-scoped right (D06, G05); `ticket_attendees` replaces the `dykil.survey_responses` read; `ticket.refunded` is an outbox notification. |
| R42 | GET `/api/events/[id]/tickets/[ticketId]/registration-status` | KEEP | - |
| R43 | GET `/api/events/[id]/tickets/[ticketId]/registration` | CHANGE | `ticket_attendees` for the identity, Forms port for answers. |
| R44 | POST `/api/events/[id]/tickets/[ticketId]/resend-email` | CHANGE | Enqueues a confirmation or reminder outbox row; no `auth.onboard_tokens` write (D11). |
| R45 | GET `/api/events/[id]/tiers` | KEEP | - |
| R46 | POST `/api/events/[id]/tiers` | KEEP | - |
| R47 | PUT `/api/events/[id]/tiers` | KEEP | - |
| R48 | GET `/api/events/[id]/tiers/unlock` | KEEP | Public. |
| R49 | GET `/api/events/by-did/[did]` | KEEP | Public read; kernel chat can drop its call once the lobby context carries the title (G11). |
| R50 | GET `/api/events/mine` | KEEP | Reads `event_organizers`. |
| R51 | GET `/api/events` | KEEP | Public list; the internal API key requirement goes (G10 for kernel LLM tools). |
| R52 | POST `/api/events` | CHANGE | `02` section 6.1: owner row, outbox for chat and attestation, key handling per D09. |
| R53 | GET `/api/health` | KEEP | Template health route. |
| R54 | GET `/api/media/[...path]` | REPLACE | Legacy `/api/media/events/...` image URLs already stored in `events.image_url` must keep resolving; new images go through the Media port (D15). |
| R55 | POST `/api/migrate-tickets` | REMOVE | Claim-time re-owning by verified email at login (D10, G07). |
| R56 | POST `/api/orders/[id]/confirm-payment` | KEEP | Calls `issueTickets` for e-Transfer orders. |
| R57 | POST `/api/orders/[id]/refund` | CHANGE | Same as R41, order level. |
| R58 | GET `/api/proxy/connections` | REMOVE | Co-host picker calls the kernel connections public API with the user's session (G14). |
| R59 | GET `/api/register/[ticketId]` | CHANGE | Requires the per-ticket registration token (with the legacy compatibility window). |
| R60 | POST `/api/register/[ticketId]` | CHANGE | Token required; writes `ticket_attendees` and submits through the Forms port in one use case; notifications through the outbox. |
| R61 | GET `/api/spec` | KEEP | Template spec route; document regenerated. |
| R62 | POST `/api/tickets/[id]/confirm-payment` | KEEP | Calls `issueTickets`. |
| R63 | GET `/api/tickets/[id]/qr` | KEEP | Local `qrcode` package replaces unpublished `@imajin/email`. |
| R64 | POST `/api/upload` | REPLACE | Authenticated organizer, Media port, server-derived extension and type (D15). |
| R65 | POST `/api/webhook/payment` | REPLACE | Receiver for the payment-completion delivery chosen in D05 (G16), signature-verified, idempotent through `inbound_receipts`; reconcile job runs the same use case. |
| R66 | POST `/api/webhook/settlement` | REMOVE | Settlement read from pay and cached on the order (D04, G06, G19). |

Count check: 66 rows, matching the 66 method-and-path handlers in 54 route files.

## 2. Tables (T1-T8) and additions

| Old | Table | Disposition | Notes |
|-----|-------|-------------|-------|
| T1 | `events.events` | KEEP | Ids, `did`, `public_key` unchanged. `private_key` stays in the table, no longer returned to clients, and is not written for new events if D09 option b is taken. `pod_id`, `lobby_conversation_id`, `course_slug` stay as plain text pointers. |
| T2 | `events.ticket_types` | KEEP | `sold` stays; a consistency check against real ticket counts is part of the dev soak. `registration_form_id` unchanged (Dykil survey id). |
| T3 | `events.orders` | KEEP | `fair_settlement` becomes a cache filled from pay (D04). |
| T4 | `events.tickets` | KEEP | `signature` written per D09; registration token added in `metadata` for new tickets; status vocabulary per D13. |
| T5 | `events.ticket_transfers` | KEEP | Dormant; no route writes it today (D19). Never dropped. |
| T6 | `events.ticket_queue` | KEEP | - |
| T7 | `events.event_invites` | KEEP | - |
| T8 | `events.pledges` | KEEP | Used when campaigns ship (D17). |
| new | `events.outbox` | ADD | Deferred effects, written in the domain transaction. |
| new | `events.inbound_receipts` | ADD | Idempotency for external deliveries. |
| new | `events.event_organizers` | ADD (D07) | Seeded from existing owners (`events.creator_did`) and the co-hosts currently held as kernel pod members; the one-time import of pod members is a cutover step that needs the kernel pod read (G08) or an operator export. |
| new | `events.ticket_attendees` | ADD (D08) | Seeded from Dykil responses (owner export) plus the legacy table while it is readable. |

## 3. Kernel calls out of events (K01-K16)

| Old | Call | New | Notes |
|-----|------|-----|-------|
| K01 | Event DID registration (`auth /api/register`) | Identity port, delegated registration (D09 option b) | Fallback if the kernel gap is not closed: signed registration as today, key never returned or logged (G01). |
| K02 | Identity lookup | Identity port `resolve` (batched) | Replaces per-DID calls in lists with one batched call. |
| K03 | Soft identity (`session/soft`) | Identity port `ensureGuest` (`required`) | - |
| K04 | Eligibility evaluation | Deferred outbox effect through the Identity port | Needs an app-callable route (G04). Attendance and purchase attestations need G17. |
| K05 | Contact email backfill | REMOVE | Events no longer writes profile data. The kernel learns the email at claim time (G07). |
| K06 | `@imajin/auth` helpers | `authenticate()` seam on published `@ima-jin/auth` and `auth-client`; Identity port for DID resolution | `resolveActingDid` behaviour is kept inside `authenticate()`. |
| K07 | Pay checkout | Payments port `createSession` | - |
| K08 | Pay refund | Payments port `refund` | App-scoped right (D06, G05). |
| K09 | Pledge setup and charge | Payments port `setupIntent` and `chargePledges` | App-scoped right (D06, G05); D17 timing. |
| K10 | Balance read and transfer | Payments port | Transfer guard status in pay to be confirmed (G05). |
| K11 | Pods for co-hosts | `event_organizers` plus deferred pod mirror (D07) | Authorization no longer depends on pods. |
| K12 | Chat lobby, members, context, participant migration | Chat port, deferred | App-callable membership and context (G09). Participant migration folds into the D10 claim flow. |
| K13 | Notify broadcast | Notifications port | App-auth send (G03). |
| K14 | In-process bus `publish()` | Outbox dispatching to Records, Notifications and Payments ports | No bus import anywhere in the app (D03, G03, G17). |
| K15 | Cross-schema SQL | Per table below | Zero cross-schema SQL; enforced by the database role (D12). |
| K16 | DB log sink and internal-key bootstrap | REMOVE | Stdout logging; no kernel internal key; app signing key via `loadAppSigningKey()` from the template. |

K15 per table:

| Table | New |
|-------|-----|
| `connections.pod_members` | `event_organizers` (authorization) and a deferred pod mirror |
| `dykil.survey_responses`, `dykil.surveys` | Forms port and `ticket_attendees` (D08) |
| `pay.transactions` | Payments port read, cached on the order (G06) |
| `auth.onboard_tokens` | REMOVE; email carries a ticket capability link (D11); G18 only if D11 option a is chosen |
| `auth.identities` | Identity port tier read; soft-to-hard re-owning moves to D10 |
| `auth.credentials` | Purpose in `src/lib/confirm-payment.ts` to be confirmed during the build; expected to be replaced by the Identity port |
| `profile.profiles` | REMOVE as a write; display data through the Identity port |
| `chat.conversations_v2` | Chat port context update (G09) |

## 4. Calls into events (I01-I10)

| Old | Caller | New |
|-----|--------|-----|
| I01 | Kernel pay `notifyEventsService` to `/api/webhook/payment` | D05 delivery to the R65 receiver (G16); kernel hard-wired env webhook removed (G02) |
| I02 | Kernel bus `settlement.completed` webhook to `/api/webhook/settlement` | Removed (D04, G19); kernel reactor and `EVENTS_SERVICE_URL` webhook retired (G02) |
| I03 | Kernel `onboard/verify` to `/events/api/migrate-tickets` | Removed (D10); kernel call deleted (G07) |
| I04 | Kernel chat `resolveConversationName` to `/api/events/by-did/{did}` | Lobby context carries the title; kernel call deleted (G11). R49 stays available |
| I05 | Kernel LLM presence tools | Re-pointed to the public read with a scoped token, or the tool is dropped until registry discovery exists (G10) |
| I06 | Kernel chat access reads `events.tickets` and `events.events` | Kernel decides by chat membership alone, which events maintains through the Chat port (G12). Blocks the prune |
| I07 | Kernel nav and profile tabs via `EVENTS_SERVICE_URL` | Registry-driven app links (G15) |
| I08 | Kernel bus chains for 17 events types | Retired after cutover (G02); events no longer publishes into the bus |
| I09 | Kernel notify templates and settings pages for 7 `event:*` scopes | Templates move to this repo (D02); the scopes stay registered so users can still opt out per scope (G03) |
| I10 | Dykil ticket gate | Unchanged contract (R16) |

## 5. Packages and imports

| Old import | New |
|------------|-----|
| `@imajin/auth` (`requireAuth`, `requireAppAuth`, `resolveActingDid`, `getSession`, ...) | `@ima-jin/auth` and `@ima-jin/auth-client` behind `authenticate()` |
| `@imajin/auth/delegation-policy` | Confirm the published package exports it, else re-implement in the domain layer (open item in `02` section 5) |
| `@imajin/bus` | Removed; outbox and ports |
| `@imajin/chat` UI | Link-out to kernel chat until a package is published (D18) |
| `@imajin/config` | `@ima-jin/config` |
| `@imajin/db` (`getClient`, `createDb`) | App's own `postgres` and `drizzle-orm` against the `events` schema only |
| `@imajin/email` (`generateQRCode`) | `qrcode` |
| `@imajin/fair` and `fair/react` | `@ima-jin/fair` |
| `@imajin/logger` and `logger/db` | `@ima-jin/logger`, stdout only |
| `@imajin/ui` | `@ima-jin/ui` |
| declared but unused: `emit`, `input`, `notify`, `onboard` | Dropped |

## 6. Kernel-shared secrets and environment

| Old variable | New |
|--------------|-----|
| `PAY_SERVICE_API_KEY` | Gone; app-scoped pay rights (D06) |
| `AUTH_INTERNAL_API_KEY`, `PROFILE_INTERNAL_API_KEY` | Gone; public routes or scopes (G04) |
| `NOTIFY_WEBHOOK_SECRET` | Gone; app-auth notify send (G03) |
| `WEBHOOK_SECRET`, `INTERNAL_SECRET` | Gone; signature verification for inbound deliveries (D05) |
| `EVENTS_VAULT_BOOTSTRAP_PRIVATE_KEY` | Gone; app signing key via `loadAppSigningKey()` |
| `CHECKIN_WEBHOOK_URL` | Kept as an optional outbound webhook, delivered through the outbox |
| `PLATFORM_DID`, `PLATFORM_FEE_PERCENT` and `PLATFORM_FEE` | Kept as business settings; the duplicate fee variable is collapsed to one during the build |
| `NEXT_PUBLIC_*` service URLs | Reduced to the kernel base URL and base path plus the registry id from the template |
