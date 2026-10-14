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
- `IMAJIN_APP_CLAIM_CODE`: the one-time approval code, first boot only.
- `IMAJIN_APP_KEYSTORE`: the persistent, environment-specific bootstrap path in DEPLOY.md.
- `IMAJIN_APP_ATTESTATION_ID`: when using public app-auth service calls outside a user session.

Never print or paste approval-card credentials, key material or `.env.local` into logs,
issues or command history. **`IMAJIN_APP_PRIVATE_KEY` must never be set.**

## Claim — normal boot through the published SDK

`instrumentation.ts` refuses a missing DID or raw-key env, then calls
`bootstrapSigningIdentity()` → published `@ima-jin/auth-client` `loadAppSigningKey()`.

- **First boot:** the SDK spends the one-time claim code and binds a narrowly scoped
  bootstrap credential. It persists only the bootstrap keystore (`0600`), not the real
  app signing key. The signing key remains in process memory.
- **After healthy first boot:** delete `IMAJIN_APP_CLAIM_CODE` from `.env.local`.
- **Later boots:** the SDK proves possession of the persisted bootstrap key to fetch
  the signing key again. Ordinary restart needs no new approval.
- **Lost keystore:** Ryan re-approves with `reissueClaim: true`; redeeming the fresh
  code revokes the lost bootstrap binding. Never manufacture replacement key material.

The one-command deploy starts pm2 only after install, build and safe baseline checks.
First-boot identity mint/claim is not executed by the coding agent or CI.

## Scoped authority

Events' user-token audience is the **registry slug `events`**, not the shared kernel
hostname. Read operations require `events:read`; writes require `events:write`.
`requireSessionOrAppToken` comes from the published auth SDK. The session-cookie fallback
is the existing transition path and cannot enforce token scopes.

Paid checkout and settlement use events' **own app-service token**. Ryan must approve
`pay:settle` via the `apps:service-scopes` card; an unapproved or unclaimed app fails closed.
No shared key is used for settlement. The legacy refund/charge-pledges dependency is
tracked separately in imajin-ai#2735; other public-contract limitations are documented in
[KERNEL-GAPS.md](./KERNEL-GAPS.md).
