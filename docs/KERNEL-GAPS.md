# Kernel gaps (refs ima-jin/imajin-ai#2515, #1988)

events talks to the kernel **only** through the registered-app contract: scoped app tokens, the published
`@ima-jin/*` SDK and the public kernel HTTP API (see `AGENTS.md` §2). The kernel version of these routes reached
into kernel internals (shared DB schemas, an in-process bus, shared service keys, session-only helpers). Where the
public contract has no equivalent yet, the port **fails closed or degrades to a logged no-op** instead of reaching
around the boundary, and the gap is recorded here. Each is a `gap(kernel)` marker in the code.

| Area | Where | Today | What the kernel needs to expose |
|------|-------|-------|---------------------------------|
| Domain events (`event.*`, `ticket.*`, `order.*`, `checkin.*`) | `src/lib/domain-events.ts` | No-op unless `IMAJIN_EVENTS_PUBLISH_PATH` is set. Reactor-driven emails/attestations depend on the kernel receiving these. | An app-auth-gated publish route. |
| Co-host / pod membership | `src/lib/kernel.ts` `isPodMember`, `listMemberPodIds` | `GET /connections/api/pods/{id}` is session-authenticated; an app-token-only caller fails closed (not an organizer). | An app-auth pod-membership route (by pod, and by DID). |
| Contact email visibility | `src/lib/kernel.ts` `resolveProfiles` / `getContactEmail` | `email` only returned when the kernel grants this app email visibility. | A registered-app email scope on `/profile/api/resolve`. |
| Eligibility evaluation after check-in | `src/lib/kernel.ts` `evaluateEligibility` | Best-effort; the kernel may refuse a third-party caller. | App-auth access to `POST /auth/api/eligibility/evaluate`. |
| Contact-email backfill | `src/lib/kernel.ts` `backfillContactEmail` | Best-effort; the kernel may refuse. | App-auth access to `POST /auth/api/identity/{did}/contact`. |
| Onboard magic link in ticket emails | `src/lib/kernel.ts` `createOnboardToken` | Always `null` (emails go out without the magic link). | A route that mints an onboard token for a registered app. |
| Act-as / delegation (forest scope) | `src/lib/auth.ts` `resolveActingDid` | Always the caller's own DID. | Delegation overlay in the app-token contract. |
| Chat sync (member add/migrate, name policy) | `src/lib/event-update-helpers.ts`, webhook, cohosts, event routes | Calls the chat service with this app's `X-App-DID` / `X-App-Authorization`; no kernel-internal shared key. May be refused. | App-auth chat endpoints for registered apps. |
| Pay webhook correlation | `app/api/webhook/payment/route.ts` | Settlement needs the checkout's kernel `transactionId` on the `checkout.completed` webhook; without it settlement is skipped and logged loudly. | `transactionId` in the pay webhook payload (imajin-ai#2741 decision a). |

Settlement (`/pay/api/settle`) uses events' **own app-service token** and is not a gap — see `src/lib/pay-settle.ts`.
Refunds and campaign charge-pledges still use the shared `PAY_SERVICE_API_KEY` (out of scope, imajin-ai#2735).
