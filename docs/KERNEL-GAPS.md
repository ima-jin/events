# Kernel gaps (refs ima-jin/imajin-ai#2515, epic #1988)

The events app composes the kernel through the registered-app contract only: scoped app tokens
(`requireSessionOrAppToken` from the published `@ima-jin/auth`), the published `@ima-jin/*` SDK, and the kernel's
public HTTP API. The kernel version of `apps/events` reached further than that contract allows (in-process bus,
direct reads of `auth`/`profile`/`dykil`/`pay` tables, kernel-internal service keys). Where the public API has no
equivalent yet, the port degrades to a documented fallback instead of reaching around the boundary.

Each gap below is marked `gap(kernel)` in code. Close a gap by shipping the kernel route, then deleting the fallback.

## Auth

- **Cookie forwarding to kernel routes.** `GET /connections/api/pods/{id}` (co-host membership), `GET /connections/api/pods`
  (attending), `/pay/api/balance/{did}` and `/pay/api/transfer` are session-authenticated. This app forwards the caller's
  own session cookie. A caller using only an `events`-audience app token has no cookie to forward, so they fail closed
  (not an organizer / no balance) until the kernel accepts app tokens on these routes or exposes app-auth equivalents.
- **`X-Acting-For` delegation.** `requireSessionOrAppToken` in `@ima-jin/auth@0.8.16` does not surface the verified
  `actingFor` (kernel `main` does, unreleased). `resolveActingDid` already prefers `actingFor`, so it starts working when
  the SDK ships it. Act-as groups (`actingAs`) work today.

## Interim kernel-internal credentials

These are not part of the registered-app contract. They exist only so ported flows keep working; each needs a
scoped replacement before cutover (#1988 step 5).

- `PAY_SERVICE_API_KEY` — refunds (`/pay/api/refund`), campaign pledges/settlement (`/pay/api/setup-intent`,
  `/pay/api/charge-pledges`). Needs app-token routes (e.g. a `pay:refund` scope).
- `WEBHOOK_SECRET` — inbound pay-service webhooks (`/api/webhook/payment`, `/api/webhook/settlement`).
- `NOTIFY_WEBHOOK_SECRET` — broadcast message recipient lookup/send (`/api/events/{id}/message`).
- `AUTH_INTERNAL_API_KEY` — chat context sync for name-display policy.

## Missing public routes

- **Domain events.** The kernel's in-process `@imajin/bus` is not importable. `src/lib/domain-events.ts` posts to
  `IMAJIN_EVENTS_PUBLISH_PATH` when set and is a logged no-op otherwise, so reactor-driven side effects (notification
  emails, attestations) do not fire until the kernel exposes a publish route.
- **Onboard tokens.** A registered app cannot mint `auth.onboard_tokens`, so confirmation emails carry the plain
  deep link instead of a sign-in magic link.
- **Contact email.** Resolved through `POST /profile/api/resolve`; `email` is only returned when the kernel grants this
  app email visibility.
- **Eligibility evaluation / contact backfill** after check-in and checkout call the documented routes and degrade to
  a no-op when the kernel refuses an app caller.
- **Transaction ids on sales.** The kernel joined `pay.transactions` to show `transactionId`; there is no public
  equivalent, so the field is omitted.
- **Event chat name.** The kernel set the chat conversation name/avatar directly; only membership and
  name-display-policy are synced here.
