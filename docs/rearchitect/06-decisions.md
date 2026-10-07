# 06 - Decisions

Open design questions, one card each, for Ryan to ratify or change. Each card follows the form `DECISION · subject · question · options a/b/c · rec: letter - why`. Where a card is not answered, `02-proposed-architecture.md` assumes the recommended option and says what changes otherwise.

Cards that block starting the build, in the order to resolve them: D01, D12, D02, D03, D05, D04, D06, D07, D08, D09. The rest can be settled while the first slices are built.

### D01

DECISION · events#2 disposition · Is the kernel-parity port the base of the rebuild? · options a) base: finish and merge it, re-architect afterwards; b) quarry: keep it as a read-only draft, re-home its logic and tests behind the ports, close it when drained; c) keep it as an indefinite draft reference with no plan to drain it · rec: b — a is red (18 of 28 test files failing, 49 SonarCloud issues), sends no buyer confirmations and has no UI, and c leaves 14.8k lines of stale review burden.

### D02

DECISION · confirmation delivery · Who renders and sends buyer confirmations now that events cannot publish into the kernel bus? · options a) the kernel exposes an app-authenticated publish for registered event types and keeps the reactors and templates; b) events renders the content from templates in its own repo and sends through a kernel notify-send under app auth, with the kernel applying preferences and delivery; c) events sends email itself through its own provider · rec: b — it keeps user opt-outs and delivery in the kernel and moves event wording to the app that owns the event, at the cost of one kernel gap (G03) instead of a generic bus door; c bypasses user preferences.

### D03

DECISION · domain-fact delivery · How does events tell the kernel that something happened (ticket issued, event created, attendee checked in)? · options a) a generic app-authenticated publish route into the bus with a per-app type allowlist; b) per-purpose public APIs only (attestations, notify send, pay) and no bus access for apps; c) the kernel pulls from an events feed and runs its own reactors · rec: b — it matches Dykil's precedent of using the public attestation API rather than the bus, adds no generic door, and leaves authority with the receiving service; c adds a new events endpoint to the kernel's dependency list.

### D04

DECISION · settlement authority · Who starts the .fair split for a ticket sale? · options a) events keeps publishing order.completed with the manifest, as today; b) events passes a reference to the signed .fair manifest when it creates the pay session and pay settles on completion, so events never publishes order.completed; c) events calls a pay settle endpoint after completion with an organizer-signed manifest · rec: b — pay already sees the money and the session, so the split is validated where the funds are and events stops speaking as the buyer (F08); a is the cutover fallback only; b needs G19.

### D05

DECISION · payment-completion delivery · How does events learn that a card payment finished? · options a) pay delivers a signed event to a callback URL stored on the app's registry entry, with a status read as the reconcile safety net; b) events only polls pay session status from the success page and a reconcile job; c) keep the hard-wired environment webhook with a shared bearer secret · rec: a — push gives latency and the reconcile read gives correctness, and the kernel stops carrying a per-app environment variable; c is the time-boxed cutover fallback; a needs G16.

### D06

DECISION · pay credential for refunds and pledge charges · How does events authorize refunds and pledge charges against pay? · options a) app-scoped pay rights granted at registration and limited to sessions the app created; b) keep the shared PAY_SERVICE_API_KEY in the events environment; c) refunds and charges only with the acting organizer's own user token · rec: a — it removes a kernel secret from an external app and bounds what a leak can do; b is the cutover fallback; c cannot run scheduled pledge settlement or e-Transfer refunds; a needs G05.

### D07

DECISION · organizer and co-host authority · Where does "is an organizer of this event" live? · options a) keep kernel pods and call them through app-callable pod routes; b) an events-owned event_organizers table, with the pod and chat membership mirrored best-effort; c) co-host grants as signed attestations checked at use · rec: b — check-in and door scans must not wait on a kernel round trip, the co-host list is event domain data, and pods stay a deferred mirror for trust and chat.

### D08

DECISION · attendee identity and answers · Where do per-ticket attendee name, email and answers live now that Dykil owns no tables? · options a) read Dykil on demand through its owner export for every guest list and door view; b) events keeps a minimal ticket_attendees projection (name, email, response reference) written with the registration while full answers stay in Dykil; c) events stores full answers itself and stops using Dykil for events · rec: b — the door and the confirmation email need name and email fast, Dykil has no batch-by-ticket read, and answers stay with the signed source; it reintroduces a small local copy of what #826 removed, so it needs a repair path from the owner export.

### D09

DECISION · ticket proof and event key custody · How are tickets signed and who holds event keys? · options a) keep a per-event Ed25519 key in the events row as today and verify nothing; b) stop creating per-event keys, sign tickets with the app's registered key, register event DIDs as delegates (needs G01), and verify advisorily at the door; c) keep per-event keys but with custody by the organizer and never stored by the app · rec: b — one custody boundary (the app keystore) and verification at the door becomes possible, while old rows keep their columns and verify as legacy; a is the fallback while G01 is open, with the key never returned to clients.

### D10

DECISION · soft-to-hard ticket claim · How do tickets bought as a guest move to the buyer's hard identity? · options a) the kernel pushes a signed identity.claimed to subscribed apps; b) events re-owns tickets by verified email lazily when the hard identity logs in (needs the verified email, G07); c) keep /migrate-tickets with today's contract through the cutover and add real authentication when the kernel caller can send it · rec: b — it ends the kernel's call into events and the open endpoint (F03) without a new push channel; c is the cutover interim and Ryan must accept that F03 stays open until then.

### D11

DECISION · guest buyer confirmation link · What does a guest buyer's confirmation email link to? · options a) a kernel-minted one-time claim link (needs G18); b) a per-ticket capability link to the ticket page plus an invitation to claim the identity, with no kernel token; c) require sign-in before checkout and have no guest buyers · rec: b — it needs no kernel token minting and the ticket stays usable with only the email, whereas c would lose sales; the ticket id is already the QR content.

### D12

DECISION · database topology · How is the events database isolated from the kernel's? · options a) the same Postgres server and database with a schema-scoped role that can use only the events schema; b) a separate database with a one-time data copy at cutover; c) the same database with no role isolation and the contract enforced by review only · rec: a — prod has live events, so there is no data move and rollback is a re-point, and the role makes leftover cross-schema SQL fail loudly in the soak; b adds a live data migration; c is how the coupling grew.

### D13

DECISION · "holds a ticket" and status vocabulary · What is the single rule for holding a ticket, and what happens to the status sold? · options a) holdsTicket is valid or used everywhere, sold is removed from code and comments, no data change; b) introduce sold by migrating valid tickets and keep the gate constants; c) keep per-surface definitions · rec: a — no code writes sold, so the Dykil gate and the attending list are wrong today (F01), and a fixes that without touching data; b rewrites live ticket status for no gain.

### D14

DECISION · background work · Where do the outbox dispatcher and the hold sweeper run? · options a) inside the app process, started from instrumentation, claiming rows with skip-locked locking; b) a second pm2 worker process; c) an external cron calling an authenticated internal route · rec: a — it keeps the template's one-pm2-entry-per-environment deploy shape and needs no extra secret, and the locking makes a second instance safe if b is adopted later.

### D15

DECISION · image storage · Where do event images live? · options a) the kernel media service through its public API, with legacy /api/media/events URLs still resolving; b) keep the host disk path /mnt/media/events written by the app; c) an object store owned by events · rec: a — it ends an unauthenticated upload to a host path (F04) and a hard-coded filesystem dependency; existing image URLs must keep resolving, so legacy files are served read-only until imported.

### D16

DECISION · page tree and shared links · Which of the two page trees is canonical? · options a) /e/[eventId] canonical with /[eventId] kept as redirect-only routes; b) /[eventId] canonical with /e/... redirecting; c) keep both as full trees · rec: a — one tree to maintain while every historical link in both shapes still resolves, which #2529 requires; which shape is shared more widely cannot be told from code, so confirm from link analytics before building.

### D17

DECISION · campaigns and pledges in the first cut · Do campaigns ship in the first build? · options a) port at parity inside the first build; b) build the four outcome verbs first and port campaigns behind a flag before the prod cutover; c) defer campaigns until after the cutover · rec: b — they are outside the four verbs and prod pledge counts are unknown until the operator captures them; c would break any live campaign at cutover, so if live pledges exist the flag must be on at cutover.

### D18

DECISION · event chat UI · How does the event page offer the lobby chat without the unpublished @imajin/chat package? · options a) wait for a published @ima-jin/chat; b) link out to the kernel chat conversation for the event while the app still creates the lobby; c) build a minimal chat inside events · rec: b — it adds no unpublished dependency and no duplicate chat, and the embed can return when a package is published; the lobby is outside the four verbs.

### D19

DECISION · ticket transfers · What happens to the unused ticket_transfers table? · options a) leave it dormant with no route and never drop it; b) implement transfers in the first build; c) drop it later · rec: a — no route writes it today (F16), transfers are outside the four verbs, and the baseline rule is never to drop; revisit with its own card.
