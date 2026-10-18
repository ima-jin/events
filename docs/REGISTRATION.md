# Registering events through the kernel claim flow

Events is a standalone registered app, not a privileged kernel process. This run prepares
the code/docs only: **Ryan performs provisioning and first boot**, separately for dev and
prod. See [DEPLOY.md](./DEPLOY.md) and [ENVIRONMENTS.md](./ENVIRONMENTS.md).

## Provision — operator only

On the target kernel's `/jin` approval surface, approve `apps.provision` for slug `events`.
Dev uses `dev-jin.imajin.ai`; prod uses `jin.imajin.ai`. The callback is that origin's
`/events/api/auth/callback`. Confirm the registry id, requested scopes and audience.
Do not use a legacy registration endpoint that returns a raw keypair and do not generate
an app key by hand.

Privately populate the standalone checkout's `0600` `.env.local`:

- `IMAJIN_KERNEL_URL`, `IMAJIN_AUTH_URL` and public/auth URLs for that environment.
- `IMAJIN_APP_DID`: the kernel-minted app DID.
- `NEXT_PUBLIC_IMAJIN_APP_ID`: the registry id (not the DID).
- `IMAJIN_APP_KEYSTORE`: the persistent, environment-specific bootstrap path in DEPLOY.md.
- `IMAJIN_APP_ATTESTATION_ID`: when using public app-auth service calls outside a user session.

Never print or paste approval-card credentials, key material or `.env.local` into logs,
issues or command history. **`IMAJIN_APP_PRIVATE_KEY` must never be set.**

<a id="4-fetch-this-apps-own-signing-key-at-boot-7"></a>

## Claim — browser only through the published SDK

`instrumentation.ts` refuses a missing DID or raw-key env, then calls
`bootstrapSigningIdentity()`. With a keystore, the published SDK fetches the signing key;
without one, only explicit claim-only startup is available and makes no claim exchange.

- **Operator browser path (only claim path):** run explicit `pnpm claim`.
  This isolated mode serves only `/claim`, `/api/claim` and Next static assets
  (all under `/events` on the host). Other routes, including health, return 503.
  Open `/events/claim` and paste the one-time code from the kernel operator's `/jin`
  approval card. The code is the operator-only bearer capability; an ordinary user
  session or app token cannot authorize a claim. The kernel enforces single use.
  The server checks the returned DID against `IMAJIN_APP_DID` and activates the
  identity in memory. Both claim routes 404 afterward. Stop the claim-only listener
  and restart normally after vault provisioning; it never transitions to ordinary traffic.
- **Successful claim:** the SDK spends the one-time claim code and binds a narrowly scoped
  bootstrap credential. It persists only the bootstrap keystore (`0600`), not the real
  app signing key. The signing key remains in process memory.
- **Later boots:** the SDK proves possession of the persisted bootstrap key to fetch
  the signing key again. Ordinary restart needs no new approval.
- **Lost keystore:** Ryan re-approves with `reissueClaim: true`; redeeming the fresh
  code revokes the lost bootstrap binding. Never manufacture replacement key material.

The one-command deploy starts pm2 only after install, build and safe baseline checks.
First-boot identity mint/claim is not executed by the coding agent or CI.

### Proxy trust for claim rate limiting

The claim endpoint trusts only the last `X-Forwarded-For` hop added by the app's
front-door proxy, never the spoofable leading hop or `x-real-ip`. Caddy must set
`X-Forwarded-For` (its default), and the app port must be reachable only through
that proxy: bind to loopback/private networking and firewall direct access.
Requests without a usable proxy address share a separately capped fallback bucket.
Claim codes, SDK errors and keystore contents are never logged or returned to the browser.

## Vault-only boot credentials
### Operator-supplied database credential (#61)
`imajin.app.json` declares only `{ "name": "DATABASE_URL", "kind": "operator-supplied" }`
for the existing external database. The role must remain confined to the app's `events`
schema. The manifest never contains a value, and syncing does not generate this credential.

For each environment, the **operator** uses the approved kernel `/jin` surface:
1. Deploy the kernel contract from imajin-ai PR #2851, then **Sync manifest secrets**
   for the existing events app and obtain the owner's countersign.
2. Use **App secrets set** for `DATABASE_URL`, or **App secrets rotate** for a replacement,
   with owner countersign through the approved private credential-entry tool.
   Never paste a value into chat, a command, a shell session, an env file or this manifest.
3. Restart through the separately approved cutover procedure only after the declaration
   is supplied. Production coordination remains imajin-ai#2241 / #2516, not this code change.

The published `@ima-jin/auth-client@0.8.24` `createVaultBoot<ServerConfig>` calls the SDK's
keystore-authenticated, encrypted `loadFromVault` fetch with `onMissing: 'fail'`.
`scripts/start.ts` awaits that boundary before dynamically importing `scripts/server.ts`.
DB consumers read `getServerConfig()` from shared process memory; no env fallback or write
exists. Next build-time route discovery never constructs a client or needs a credential.
Direct `next start` / `next dev` is unsupported and fails the instrumentation config guard.

Missing keystore, refused or missing credentials, malformed envelopes and network failures
prevent the server import/listen. The launcher exits 1 with a fixed, value-free action line.
There is no retry into a partially configured server. Rotation is fetched on the next fresh
boot; never copy an existing server value through a shell or SSH.

`pnpm claim` is an explicit onboarding exception, not normal startup: it fetches no database
credential, cannot construct a database, and its outer HTTP gate keeps ordinary traffic closed
even after successful claim. All localhost or host config remains non-secret.

### Kernel-issued self-secrets

Root `imajin.app.json` declares the session and ticket QR recipes (names and kinds only).
The kernel issues and seals missing declarations during provision/claim. For an already
registered app, select **Sync manifest secrets** on `/jin` and countersign the proposal.
Never generate, see, paste or copy the resulting credentials.

After establishing the bootstrap keystore, events awaits the published
`@ima-jin/auth-client@0.8.24` app-keystore `loadFromVault` for each kernel-issued declaration.
Only after both load successfully does it activate the signing identity. Session and
ticket QR signing/verification read these values lazily from shared server memory;
imports and builds need no credentials. No value is persisted, logged or assigned to env,
and stale env entries are ignored with a names-only deletion warning. The explicit claim-only browser gate remains;
the claim exchange also waits for the vault before activating.

A refused, missing or unreachable secret aborts boot with a value-free line naming the
declaration, exit status 1, and instructions to use **Sync manifest secrets** on `/jin`,
countersign, and restart. No partial credentials or env fallback are accepted.
If claim succeeds but loading fails, the bootstrap keystore remains bound: resolve the
vault problem through `/jin` and restart rather than redeeming the spent code again.

To rotate, select **Rotate** on `/jin`, countersign, then restart events through the
operator's deployment tool. The next boot fetches the current generation with no file edit.
Session rotation signs users out; QR rotation invalidates previous tokens after restart
with no old-secret fallback. At cutover the kernel vault issues a new ticket QR secret;
existing QRs are invalidated with no reissue or carry-over. Never copy the old secret.
Ticket-v1 semantics are otherwise unchanged.

## Scoped authority

Events' user-token audience is the **registry slug `events`**, not the shared kernel
hostname. Read operations require `events:read`; writes require `events:write`.
`requireSessionOrAppToken` comes from the published auth SDK. The session-cookie fallback
is the existing transition path and cannot enforce token scopes.

Paid checkout, settlement, refunds and campaign charging use events' **own app-service token**.
The operator must approve `pay:settle`, `pay:refund` and `pay:charge-pledges` for events'
app DID via the `apps:service-scopes` card; an unapproved or unclaimed app fails closed.
The kernel also checks that the original payment/setup belongs to that app DID. Deploy
kernel PR imajin-ai#2786 before this events release. Other public-contract limitations are documented in
[KERNEL-GAPS.md](./KERNEL-GAPS.md).

Organizer broadcasts use events' own app-service token from the published
`@ima-jin/auth-client` **0.8.18** `createAppServiceTokenProvider`.
Approve `notify:broadcast` for events' app DID through `apps:service-scopes` on `/jin`.
The app never uses a kernel-internal contact credential: optional reply-to email comes from
the public profile resolver and is omitted when not visible.

## Scoped kernel reads and private onboarding

Before deploying the events#70 consumers, the **operator**, not the coding agent, must:

- Deploy the public contracts from kernel PRs #2910, #2911, #2913 and #2914.
  Pod reads remain unavailable until #2911 has merged and deployed.
- Approve `pay:read`, `connections:read`, `profile:email:read`,
  `profile:contact:backfill` and `onboard:send` for the existing events app DID
  through the existing countersigned `apps:service-scopes` proposal/card.
  Preserve the app's existing payment/notification approvals.
- Refresh the existing cached app-service token after approval (or restart through
  the normal operator deploy path). No new key, shared secret or environment credential.
- Include `profile:email:read` and `profile:contact:backfill` in the registered
  requested scopes for the existing per-user OAuth authorization flow.
- Obtain each **pod owner's** active `connections:read` OAuth grant for this exact
  events app. A member's consent, same registry owner or session cookie is insufficient.
  Group/business pods without a supported owner-consent path remain closed.
- Obtain `onboard:send` owner OAuth consent when the checkout seller differs from the
  app's registry owner. The kernel must independently recognize the completed app-bound checkout.
- For profile email/backfill, obtain the target person's actual exact-scope OAuth consent
  unless a qualifying completed payment is bound to both this app and that payer DID.
  Ordinary events login does not create that grant; anonymous checkouts commonly have
  `fromDid=NULL`, and ticket metadata/email matches must not bypass the person gate.

Unapproved scopes, revoked grants and unsupported resources fail closed/best-effort.
Do not silently enroll anonymous/free-RSVP users, forward cookies to bypass refusal, or
make these scopes globally service-eligible. Onboarding never returns a token to events.
Do not automatically retry 403/404/5xx or 429 private delivery attempts; `Retry-After`
must elapse before any later operator-directed attempt. The app records an attempt before
delivery and does not automatically retry it, including unknown 5xx outcomes.

## Kernel callback registration

The kernel signs; events verifies with the published `@ima-jin/auth/kernel-webhook` **0.8.18**.
The recipient audience is this deployment's `IMAJIN_APP_DID`, not the scoped-token slug.
No shared callback credential is generated, exchanged or copied. The kernel operator uses
the approved vault/tool flow and `/jin` re-sync to register the signer, callbacks and app scopes.
Preserve the public pin and durable replay directories on shared persistent local storage;
trusted util-linux `flock` and a multi-host shared-store adapter before scaling are required.
See [DEPLOY.md](./DEPLOY.md#kernel-signed-callbacks) for discovery, rollout and failure handling.

## Campaign payment setup

Campaign creation and confirmation require the separate operator-approved `pay:setup-intent`
service scope. Events calls `POST /pay/api/setup-intent` and `/pay/api/setup-intent/verify`
with its own app-service token; neither client Stripe results nor a session cookie grant
verification authority. The seller must have an active `stripe:events` BYO connector with
Customers and SetupIntents write/read permissions and PaymentMethods read permission.

Deploy the kernel verification contract before enabling pledges. Missing routes, revoked
approval, unavailable Stripe or malformed verification responses return 503 without confirming.
Legacy pledges without the seller/account binding return `setup_intent_legacy` (409) and need
a new setup; no platform-account fallback exists. The browser must confirm using that seller
account's publishable key, not the platform key.

Kernel imajin-ai#2796 supplies the seller's sealed publishable key with each payment setup.
Events uses that key for Stripe.js and sends the server-recorded seller DID for each pledge
when collecting through `pay:charge-pledges`. Each pledge's own charge outcome is recorded
independently; confirmation alone is a verified saved method, not collected funds.
