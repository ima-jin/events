# Environments — events

All example assignments are **blank**. Populate only non-secret configuration in the host's untracked `.env.local` and
remove unused blank optional entries (some SDK fallbacks distinguish unset from empty).
`chmod 600 .env.local`. Never commit credentials or signing keys.

## Targets

| Setting | dev | prod |
|---|---|---|
| Host/operator | ProLiant, user `jin` | ProLiant, user `jin` |
| Checkout / env file | `~/dev/events/.env.local` | `~/prod/events/.env.local` |
| Example | `.env.dev.example` | `.env.prod.example` |
| pm2 / port | `dev-events` / 3006 | `prod-events` / 7006 |
| Kernel base | `https://dev-jin.imajin.ai` | `https://jin.imajin.ai` |
| App public URL | `https://dev-jin.imajin.ai/events` | `https://jin.imajin.ai/events` |
| Persistent keystore | `/home/jin/.imajin/events.dev.keystore.json` | `/home/jin/.imajin/events.prod.keystore.json` |

The port comes from pm2, **not** the env file. Both deployed instances run
`NODE_ENV=production`; `IMAJIN_ENV` distinguishes dev cookies. Separate DID, claim,
keystore and database credentials per environment. App self-secrets are issued and sealed
by the kernel, then loaded into memory; see [REGISTRATION.md](./REGISTRATION.md).
Validate privately with `node scripts/check-env.mjs dev` (or `prod`).

## Required on every deployment

| Variable | When | Contract |
|---|---|---|
| `APP_DB_SCHEMA` | build + runtime + migration | Exactly `events`; immutable. |
| `IMAJIN_KERNEL_URL` | runtime | Target kernel base above, no path. Claim/bootstrap and app-service tokens. |
| `IMAJIN_AUTH_URL` | runtime | Same kernel base; SDK sign-in redirect. |
| `AUTH_SERVICE_URL` | runtime | Kernel base plus `/auth`; published auth SDK token/session verification and public webhook signing-key discovery. |
| `NEXT_PUBLIC_IMAJIN_AUTH_URL` | build | Same kernel base; browser sign-in and public service links. |
| `NEXT_PUBLIC_AUTH_URL` | build | Kernel base plus `/auth`; browser session calls. |
| `NEXT_PUBLIC_APP_URL` | build + runtime | App public URL above; redirects/checkouts. |
| `NEXT_PUBLIC_EVENTS_URL` | build + runtime | Same app public URL; checkout return URLs. |
| `NEXT_PUBLIC_BASE_PATH` | build + boot | Exactly `/events`; Caddy preserves it. |
| `IMAJIN_APP_DID` | boot + runtime | Kernel-minted DID, distinct for dev/prod; no placeholder. |
| `IMAJIN_APP_KEYSTORE` | boot | Absolute target path above, persistent `0600` bootstrap file, parent `0700`. Not an app signing-key file. |

`NEXT_PUBLIC_*` values and Next basePath are baked into the build; changing them requires
rebuilding. Server variables are read at boot/per request. The deploy script clears inherited
contract variables before loading `.env.local` for build/migration/pm2.

## Identity and conditional integrations

Without a keystore, `check-env` warns. Normal `pnpm start` / `pnpm dev` fails closed.
Use explicit `pnpm claim` for browser-only onboarding, then stop that isolated listener
and restart normally after vault provisioning. Claim-only mode returns 503 for ordinary
routes and health, even after the claim; it never opens the app database.

| Variable | When | Contract |
|---|---|---|
| `NEXT_PUBLIC_IMAJIN_APP_ID` | build | Kernel registry `app_…` id used by header sign-in; provision for interactive sign-in. |
| `IMAJIN_APP_ATTESTATION_ID` | runtime | Service-level attestation for app-auth public kernel calls; provision for those integrations. Not an internal key. |
| `NEXT_PUBLIC_SERVICE_PREFIX` | build | **`dev-` on dev**, unset on prod; SDK URL construction. |
| `NEXT_PUBLIC_DOMAIN` | build | `imajin.ai` (default); paired with prefix. |
| `IMAJIN_ENV` | runtime | **`dev` on dev**, unset on prod; selects `imajin_session_dev` versus `imajin_session`. |
| `CHECKIN_WEBHOOK_URL` | runtime | Optional external check-in callback URL; unset disables callback. Do not embed credentials in URLs. |
| `DYKIL_URL` | runtime | Target kernel base plus `/dykil` for public survey API reads; unset yields no survey response. |
| `IMAJIN_EVENTS_PUBLISH_PATH` | runtime | Optional approved public kernel app-auth publish route path; unset is a logged no-op. See KERNEL-GAPS.md. |
| `ENABLE_TICKET_MIGRATION` | runtime | Unset or `false` until #2529 soak sign-off; only literal `true` enables the live-ticket rewrite. Prepared deploy refuses enabled gate. |

## Optional overrides and attribution
Campaign Stripe.js uses the seller's publishable key from the kernel `/api/setup-intent`
response, not an app environment variable. A missing seller key fails closed.

Pay checkout, settlement, refund and campaign charging use events' own app-service token.
The operator must approve `pay:settle`, `pay:refund` and `pay:charge-pledges` for that
environment's events app DID on `apps:service-scopes`. Deploy kernel PR imajin-ai#2786 before
this events release and remove the retired shared pay credential from the environment.
Organizer messages use that same app-service token with operator-approved `notify:broadcast`.
Reply-to email is optional via the public profile resolver; an unavailable or hidden email does
not block delivery and never requires an internal contact credential.

The kernel signs payment and settlement callbacks; events verifies through published SDK
`@ima-jin/auth` **0.8.18**, using this environment's `IMAJIN_APP_DID` as recipient audience
and `serviceUrl('auth')` for public discovery. No shared callback credential is generated,
copied or configured. Keep both `data/kernel-webhook-pins/` (public keys) and
`data/kernel-webhook-nonces/` (durable replay evidence) on persistent, writable local storage
shared by every worker in the deployment. Trusted util-linux `/usr/bin/flock` is required.
Multi-host replicas require a shared-store adapter with atomic nonce consumption and coordinated
public-key pinning before scaling; separate host-local directories are not sufficient.
See [DEPLOY.md](./DEPLOY.md#kernel-signed-callbacks) for rollout and trust requirements.

| Variable | When | Contract |
|---|---|---|
| `AUTH_URL` | runtime | Access-check route override; otherwise `AUTH_SERVICE_URL`/kernel `/auth`. |
| `PAY_SERVICE_URL` | runtime | Kernel `/pay`; otherwise derived from `IMAJIN_KERNEL_URL`. |
| `CONNECTIONS_SERVICE_URL` | runtime | Kernel `/connections`; otherwise derived. |
| `PROFILE_SERVICE_URL` | runtime | Kernel `/profile`; otherwise derived by app; SDK also reads it. |
| `CHAT_SERVICE_URL` | runtime | Kernel `/chat`; otherwise derived. |
| `NOTIFY_SERVICE_URL` | runtime | Kernel `/notify`; otherwise derived. |
| `REGISTRY_SERVICE_URL` | runtime | SDK registry URL override, kernel `/registry`; normally unset. |
| `REGISTRY_URL` | runtime | Deprecated SDK registry alias; normally unset. |
| `APP_URL` | runtime | Auth SDK fallback origin; unused with explicit public URL, leave unset. |
| `NEXT_PUBLIC_BASE_URL` | build + runtime | Secondary SDK fallback origin; leave unset. |
| `IMAJIN_APP_AUD` | runtime | Optional override, must be registry slug `events`, never hostname. |
| `EVENTS_ADMIN_DIDS` | runtime | Comma-separated admin DIDs; `NODE_DID` always included. |
| `NODE_DID` | runtime | Existing node DID for attribution/admin, not this app's DID. |
| `RELAY_IMAJIN_DID` | runtime | Optional relay attribution DID; unset uses node DID fallback. |
| `SESSION_COOKIE_SCOPE` | runtime | SDK cookie scope (`host` means host-only); normally unset for shared-cookie migration fallback. |
| `LOG_LEVEL` | runtime | stdout level, e.g. `debug` dev / `info` prod. Never add a DB transport. |
| `APP_LOG_LEVEL` | runtime | Persisted logger threshold; inert because persistence must be off. |

## Forbidden / framework-managed names (documented, never populated)
- `DATABASE_URL`: vault-only operator-supplied credential, never a server env entry.
  The database role must be confined to `events`; see [REGISTRATION.md](./REGISTRATION.md).

- `IMAJIN_APP_PRIVATE_KEY`: forbidden by instrumentation. The claim SDK fetches the signing
  key into memory; no raw key env, homemade keys or log output.
- `AUTH_INTERNAL_API_KEY`, `PROFILE_INTERNAL_API_KEY`: legacy SDK paths not used by events;
  leave unset. Kernel internals are not an app-auth substitute.
- `ENABLE_REQUEST_LOG`, `ENABLE_APP_LOG`, `LOG_DB_TRANSPORT`: leave unset. Logging is stdout
  only; these must not enable persisted database logging.
- `PORT`: pm2 sets 3006 dev / 7006 prod; optional local `pnpm dev` shell override only.
- `NODE_ENV`: Next/pm2 set production on both host deployments.
- `NEXT_RUNTIME`: injected by Next; bootstrap only runs in `nodejs`.

`.env.example` lists supported app and published SDK configuration, including dynamic
service overrides and forbidden/managed names. Tests check that the inventory stays complete
and every template assignment stays blank. Vault-loaded self-secrets stay only in process memory.
