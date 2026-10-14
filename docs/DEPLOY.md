# Deploying events (dev + prod)

Refs ima-jin/imajin-ai#2518; this change prepares deployment only. Ryan mints the app identity through
the kernel claim flow; dev/prod cutover remains in #2529/#2516.

Events runs from `~/dev/events` as `dev-events` on port **3006**, and from `~/prod/events` as
`prod-events` on port **7006**. These are the existing listener ports in
`ima-jin/imajin-ai/deploy/ecosystem.dev.config.js` and `deploy/ecosystem.prod.config.js`.
Caddy keeps the kernel host's `/events` path prefix intact.

Deployment must use the registered-app contract: separate kernel-minted identities per environment,
published `@ima-jin/*` packages, scoped tokens and the public kernel API. No kernel checkout is a
build dependency, and no signing key belongs in an environment file or log.

After re-pointing a pm2 entry to the standalone checkout, the operator must run **`pm2 save`**.
On 2026-10-10 a reboot resurrected stale kernel copies of market, learn, coffee and dykil because
the persisted process list still referenced the old checkouts.
