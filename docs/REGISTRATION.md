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
without one, boot stays unclaimed and makes no claim exchange.

- **Operator browser path (only claim path):** boot the app.
  With no keystore, events boots unclaimed: every route except `/claim`, `/api/claim`,
  and `/api/health` serves a "not claimed yet" page (all under `/events` on the host).
  Open `/events/claim` and paste the one-time code from the kernel operator's `/jin`
  approval card. The code is the operator-only bearer capability; an ordinary user
  session or app token cannot authorize a claim. The kernel enforces single use.
  The server checks the returned DID against `IMAJIN_APP_DID` and activates the
  identity without a restart. Both claim routes 404 afterward; health reports
  `claimed: false` before the claim and `claimed: true` afterward.
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

Root `imajin.app.json` declares the session and ticket QR recipes (names and kinds only).
The kernel issues and seals missing declarations during provision/claim. For an already
registered app, select **Sync manifest secrets** on `/jin` and countersign the proposal.
Never generate, see, paste or copy the resulting credentials.

After establishing the bootstrap keystore, events awaits the published
`@ima-jin/auth-client@0.8.18` app-keystore `loadFromVault` for each required declaration.
Only after both load successfully does it activate the signing identity. Session and
ticket QR signing/verification read these values lazily from shared server memory;
imports and builds need no credentials. No value is persisted, logged or assigned to env,
and stale env entries are ignored with a names-only deletion warning. Without a keystore the existing browser claim gate remains;
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

## Kernel callback registration

The kernel signs; events verifies with the published `@ima-jin/auth/kernel-webhook` **0.8.18**.
The recipient audience is this deployment's `IMAJIN_APP_DID`, not the scoped-token slug.
No shared callback credential is generated, exchanged or copied. The kernel operator uses
the approved vault/tool flow and `/jin` re-sync to register the signer, callbacks and app scopes.
Preserve the public pin and durable replay directories on shared persistent local storage;
trusted util-linux `flock` and a multi-host shared-store adapter before scaling are required.
See [DEPLOY.md](./DEPLOY.md#kernel-signed-callbacks) for discovery, rollout and failure handling.
