# imajin-events
Operator-supplied credential adoption is tracked in [#61](https://github.com/ima-jin/events/issues/61).

> Forked from [`ima-jin/imajin-app-template`](https://github.com/ima-jin/imajin-app-template). **Read
> [`AGENTS.md`](./AGENTS.md) first** — it defines the boundary this app must not cross.

**Platform:** [Imajin](https://imajin.ai) (sovereign-tech kernel) · **Reference app:** `ima-jin/imajin-scorecard`

This repository **is the app** — a real, arms-length third-party application that composes the Imajin platform
**only through its public app surface** (`requireAppAuth` + the documented kernel API). It holds **no `workspace:*`
deps, no monorepo internals, no DB access, no in-process bus** — it talks to Imajin as an external client. Published
`@ima-jin/*` SDK packages (from npmjs.org, no auth needed) are fine to depend on; they're the same versioned
artifact every app — first-party or third-party — consumes.

## Sonar analysis

Analysis mode, administrator setup, and exact-head PR verification are
documented in [`docs/SONAR.md`](./docs/SONAR.md).

## Source of truth is the user's

This app holds nothing authoritative. The signed records are **the user's own**, on their per-DID path. The kernel is
the authoritative **index/projection** of those records — not their owner. The user can walk with their records and
everything still verifies. (See `AGENTS.md` §3.)

## How it composes Imajin

| Header | Meaning |
|--------|---------|
| `X-App-DID` | this app's DID (from registration) |
| `X-App-Authorization` | the attestation ID from the user's consent flow |

The kernel verifies both and returns `{ appDid, userDid, scopes }` — that triple is the app's entire authority.

## Getting started

For host deployment, use [`docs/DEPLOY.md`](./docs/DEPLOY.md)'s one-command dev/prod
runbook and [`docs/ENVIRONMENTS.md`](./docs/ENVIRONMENTS.md)'s blank-valued env contracts.
Identity minting and cutover remain operator steps (ima-jin/imajin-ai#2518, #2529, #2516).

1. **Clone this repo** (`git clone https://github.com/ima-jin/events`).
2. **Register this app with the kernel** — see [`docs/REGISTRATION.md`](./docs/REGISTRATION.md).
   You'll get back this app's `appDid` and registry `id`.
3. **Set env**: `cp .env.example .env.local`, then fill in `IMAJIN_APP_DID`,
   `NEXT_PUBLIC_IMAJIN_APP_ID`, `APP_DB_SCHEMA`, `IMAJIN_KERNEL_URL` (non-secret config only).
   Use `pnpm claim` for isolated onboarding and paste the operator's one-time code only at `/events/claim`.
   Stop that listener and restart normally after vault provisioning. This app refuses to start without `IMAJIN_APP_DID`
   set, or if a raw `IMAJIN_APP_PRIVATE_KEY` is present (see `instrumentation.ts`) — it fetches its
   own signing key at boot via `@ima-jin/auth-client`'s `loadAppSigningKey()` instead; see
   [`docs/REGISTRATION.md`](./docs/REGISTRATION.md).
4. **Prepare this app's own database** through the separately approved cutover procedure
   (its own Postgres schema only — see [`docs/MIGRATIONS.md`](./docs/MIGRATIONS.md)).
   Baseline and migration runners use the same app-keystore vault fetch, never database env.
   ```bash
   pnpm install
   pnpm db:migrate
   ```
5. **Run it**:
   ```bash
   pnpm dev
   ```
   Normal startup loads `DATABASE_URL` from the vault before importing the server.
   No credential belongs in `.env.local`; see the `/jin` operator steps in the registration runbook.
   After claiming and restarting normally,
   `/api/spec` responds and `/api/me` returns your DID once
   you sign in through the header's "Sign in with Imajin" link.

## Organizer workflows

- `/dashboard` lists your created events, ticket counts and currency-separated revenue.
- `/create` requires a full identity. It creates a draft event and saves ticket tiers through the existing tier routes.
- `/admin/:eventId` is restricted to the creator or an authorized co-host. Its Overview, Guests, Sales and Managers tabs provide guest search/filtering, check-in, ticket actions and CSV downloads.
- `/e/:eventId/edit` (also `/:eventId/edit`) edits event details and tiers. Existing buyer protections apply to sold tiers; unrelated metadata stays unchanged.
- `/admin` uses the existing `EVENTS_ADMIN_DIDS` / `NODE_DID` allowlist and provides the network event export.

Only creators add/remove co-hosts or change lifecycle status. Manager selection uses the same-origin connections proxy, with a DID/handle fallback. The first manager addition creates a private event pod through the public connections API; the kernel's graph-membership gate still applies.

Dates use the selected IANA timezone. A confirmed partial form save can be retried without re-creating its event or saved tiers. An ambiguous POST result disables automatic retry: check `/dashboard` before trying again.

Registration form IDs remain editable on tiers; survey discovery widgets are not part of this organizer port. Fee-shaped and document-shaped attribution manifests use the published `@ima-jin/fair` 0.8.22 editor and save in their original shape without conversion. Missing, invalid or unsupported manifests remain unchanged.

## Delegated organizer actions (#60)

Agent delegation (`actingFor`) follows the published `@ima-jin/auth/delegation-policy`
contract: reversible actions may execute; irreversible and value-moving actions return
403 `AGENT_APPROVAL_REQUIRED` with the SDK's proposal payload, before side effects.
The organizer countersigns by re-issuing the action from their own authenticated session;
there is no delegate-supplied approval flag. Group act-as and registered-app authority
remain separate. Every mutating route must appear in the app-local policy inventory,
including documented protocol exceptions; coverage tests enforce this boundary.

## Settlement (registered-app contract)

Events settles a paid ticket order itself. At checkout it authenticates to the pay service with its
**own app-service token** (minted from its signing key) and declares the payee manifest (the resolved `.fair`
chain). When the pay webhook reports the payment, events calls `POST /pay/api/settle` with the same token, the
checkout's `transaction_id` and the `fair_manifest`; `alreadySettled: true` is success.
Refunds and campaign charge-pledges also use events' own app-service token; no shared pay key is used.

Operator prerequisites before ticket checkout works: (1) register events and provision its signing key
(`IMAJIN_KERNEL_URL`, `IMAJIN_APP_DID`, one-time operator code at `/events/claim`); (2) the operator must approve
`pay:settle`, `pay:refund` and `pay:charge-pledges` for events' app DID via the
`apps:service-scopes` card; (3) deploy the kernel contract (imajin-ai#2695) and the kernel build that adds `transactionId` to the pay
`checkout.completed` webhook (imajin-ai#2741; it looks the `pay.transactions` row up by the Stripe session and sends
its id — the key `/pay/api/settle` needs). If a webhook arrives without it, events logs
`Pay webhook carried no transactionId — order NOT settled` and skips settlement. Every seller checkout, including
an event without a `.fair` chain, requires events' app-service token. Mint failures return a retryable 503 before
calling pay; no unauthenticated fallback is allowed. Only events with a chain declare `payeeManifest`.
See also [`docs/KERNEL-GAPS.md`](./docs/KERNEL-GAPS.md).

**Checkout authentication deploy order (events#68):** merge and deploy this caller fix before kernel
PR #2873 reaches the node in the v0.8.19 drain release. The Bearer header works with both the existing
kernel and the token-required seller checkout contract.

**Deploy order:** deploy [kernel PR #2786](https://github.com/ima-jin/imajin-ai/pull/2786)
first, then this events release. Remove the retired shared pay credential from the deployment
environment. Refunds require an original payment bound to events' app DID. Campaign charging
sends only `pledgeId` and `setupIntentId`; the kernel derives charge details from its app-owned,
confirmed setup record. Legacy unbound setups must be recreated and confirmed, never backfilled
from caller-supplied customer/card IDs. Setup/confirm wiring is tracked separately in events#27.
Refund and charge calls invalidate the cached token and re-mint once on 401. A 403 is never
retried: the error identifies operator scope approval and app ownership as prerequisites.
Network/5xx failures are not automatically retried because the payment outcome may be ambiguous.

## Kernel-signed callbacks and organizer broadcasts (#38)

The kernel signs payment and settlement callbacks; events verifies the exact bytes with
published `@ima-jin/auth` **0.8.18** before parsing or business side effects. Verification uses
the configured `IMAJIN_APP_DID` as audience and `serviceUrl('auth')` for public signing-key discovery.
No shared callback credential is provisioned, generated or copied.
Preserve `data/kernel-webhook-pins/` and `data/kernel-webhook-nonces/` on persistent writable
local filesystem storage shared by every worker; util-linux `/usr/bin/flock` is required.
Multi-host replicas require a shared-store adapter before scaling.
Unauthorized signatures/replays return 401, correctly signed invalid JSON returns 400,
and unavailable verification returns 503.

Organizer messages require creator/co-host authorization and send events' own app-service
token to notify with approved `notify:broadcast`. The published `@ima-jin/auth-client`
**0.8.24** token provider is shared with pay calls. Optional reply-to email uses the public
profile resolver, never an internal contact credential. Token mint failures fail closed (503);
notify rejection fails closed (502), without a legacy credential retry.
The kernel operator completes signer provisioning through the approved vault/tool step and
`/jin` re-sync before receiver rollout. See [DEPLOY.md](./docs/DEPLOY.md#kernel-signed-callbacks).
App self-secrets are vault-loaded at boot as implemented in events#39 / PR #44; see the registration runbook.

## Domain events (notify and audit only)

`src/lib/domain-events.ts` publishes by default to **`${IMAJIN_KERNEL_URL}/api/events`**.
It uses the existing kernel base URL resolver (`IMAJIN_AUTH_URL` is the fallback),
including its trailing-slash normalization. No additional publish env is required.
Optional **`IMAJIN_EVENTS_PUBLISH_PATH`** overrides only the kernel-relative route
path (default **`/api/events`**, also used when empty). Set it only when a compatible
kernel mounts the event endpoint at another path; it is not an enable switch or an
absolute/external URL.

The published `@ima-jin/auth-client` 0.8.18 service-token provider signs with the app's
bootstrapped, memory-only identity and mints/caches a token via
`POST /auth/api/apps/token/service`. Its default `imajin:apps` audience is accepted by
the kernel event endpoint. Only `type`, `subject`, `payload`, and optional
`correlationId` are sent. The kernel stamps issuer/scope/origin itself.
Caller-side issuer, scope and timestamp remain accepted by the local helper for
request/response compatibility but are never forwarded as authority.

Delivery is best-effort and non-throwing. Missing kernel URL, `IMAJIN_APP_DID`,
or provisioned signing credentials (`IMAJIN_APP_KEYSTORE`, claimed at `/events/claim`)
produce **error-level** diagnostics naming the settings, never a silent no-op.
HTTP 401/403/429 and network failures are error-logged without changing the user's
response. A 401 invalidates the cached token for the next publish. No event is
automatically replayed; a 429 log includes `Retry-After`. Keys, tokens, payloads and
untrusted error bodies are not logged.

`imajin.app.json` declares concrete `event.*`, `ticket.*` and `checkin.*` types
(no wildcards) for the `/jin` provision/declarations preview. **Operator step after
deploy:** review and approve these `emittable_events` for events on **both prod and
dev** `/jin`, then trigger an event and confirm its app DID/type in the kernel audit
log and its notification reactor result. A declaration does not approve itself.
App-origin events run **notify and audit only** — never money or attestations.

**Contract blocker (events#58):** the current kernel reserves the entire `order.*`
namespace, including this app's existing `order.refunded`. The emitter submits that
type unchanged and logs the kernel's 403, non-fatally. It is intentionally absent
from the declaration because the kernel rejects a manifest containing it, preventing
all declarations from previewing. A kernel-policy or event-name decision is required
before order notifications can be approved. `settlement.completed` is kernel-owned
too: the app-domain helper refuses it locally and does not claim to deliver settlement
callbacks or attestations through this notification channel.

## Consuming `@ima-jin/*`

Published `@ima-jin/*` packages (e.g. `@ima-jin/auth-client`, `@ima-jin/config`, `@ima-jin/ui`) are served from
npmjs.org, the default registry — no `.npmrc` scoping and no auth token needed to install them:

```bash
pnpm add --save-exact @ima-jin/auth@0.8.18 @ima-jin/auth-client@0.8.24
```

## Layout

```
AGENTS.md          ← boundary + scope for coding agents (read first)
README.md          ← this file
docs/
  ARCHITECTURE.md  ← design notes
  REGISTRATION.md  ← how to register this app with the kernel
  MIGRATIONS.md    ← this app's schema-ownership rule
app/               ← Next.js App Router: pages + API routes
src/
  components/      ← client components
  lib/             ← auth config, signing-identity (loadAppSigningKey boot path), base-path, other helpers
  db/              ← this app's own drizzle schema (never a kernel schema)
migrations/        ← generated by `pnpm db:generate`, applied by `pnpm db:migrate`
api-spec/          ← this app's own OpenAPI document, served at /api/spec
instrumentation.ts ← boot-env guards + loadAppSigningKey() bootstrap (see docs/REGISTRATION.md)
```

## This app's own signing key

This app never reads a raw private key from env. `instrumentation.ts` fails loud at boot if
`IMAJIN_APP_PRIVATE_KEY` is set, and instead calls `@ima-jin/auth-client`'s `loadAppSigningKey()`:
a one-time operator code, pasted only at `/events/claim`, bootstraps the local `0600`
keystore (`IMAJIN_APP_KEYSTORE`).
Without a keystore, normal startup fails closed. Explicit `pnpm claim` starts only the
browser onboarding surface; stop it and restart normally once provisioning is complete.
Every later boot re-authenticates with the keystore, with no new approval needed.
See [`docs/REGISTRATION.md`](./docs/REGISTRATION.md#4-fetch-this-apps-own-signing-key-at-boot-7).

## Mounting under a path prefix

Set `NEXT_PUBLIC_BASE_PATH` (e.g. `/coffee`) when this fork is served behind a reverse-proxy path
prefix instead of at `/`. `next.config.js` reads it for Next's own `basePath` (covers `<Link>` and
`router.push` automatically); route any raw `fetch()`, `<a href>`, or `redirect()` through
`src/lib/base-path.ts`'s `withBasePath()` helper, since Next.js doesn't rewrite those.

## The honest test

Every Imajin app before the external integrators was first-party (same repo, same server, privileged access). Apps
built from this template are the **external-integrator** test: if this app can do everything it needs through app-auth
and the public API alone, the federated-app boundary is real.

Self-secrets are declared in `imajin.app.json` and loaded from the vault at boot
with the app's own keystore identity. Never populate them in env. For existing registrations,
use **Sync manifest secrets** on `/jin` and countersign before restart.
See [REGISTRATION.md](./docs/REGISTRATION.md) for provisioning and rotation.
