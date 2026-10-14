# Signed ticket QRs
Ticket QRs contain `ticket-v1.<base64url claims>.<HMAC-SHA256>`, not a raw ticket ID.
The MAC covers the version and claims. Claims bind `ticketId` and optionally
`expiresAt` (Unix seconds). Verification uses a constant-time MAC comparison,
requires the route's exact ticket ID, and rejects expiry at or before the current second.
Tokens are bearer credentials: do not log, share publicly or cache them.

## Deployment and migration
Provision a dedicated app-held `TICKET_QR_SECRET` independently for each environment:
at least 32 random bytes encoded as 64 hex characters. Keep it in the private
`.env.local`, not a public variable, kernel private key, or repository file.
`scripts/check-env.mjs` requires it and QR issuance fails closed without it.
All app instances serving the same environment must use the same secret.

**Old raw-ID QRs are rejected, with no organizer override.** Before deployment,
notify organizers and holders: holders sign in and load their ticket QR again,
or organizers resend ticket emails (the existing resend cooldown still applies).
All email issuance paths now use the same signed format. Updating the check-in
client to submit the scanned token is required in the same deployment window.
There is no database migration. Rotating the secret invalidates all existing
tokens; reissue QRs through the same holder/email paths after rotation.

Default emailed/API tokens have no expiry, to support saved and printed tickets.
The signing helper accepts an optional expiry for bounded-lifetime issuance.
Check-in still reads current ticket status and event membership from the database;
cancelled, refunded and already-used tickets remain invalid.

## API contract
`GET /api/tickets/:id/qr` requires an authenticated session or scoped app token.
Only the current holder's resolved DID (including verified act-as/delegation)
matches; a non-holder or unknown ticket returns 404. Successful responses are
`private, no-store`. Public registration completion no longer returns a QR;
the signed QR is delivered in its existing email and via the holder-only route.

Organizers submit `POST /api/events/:id/tickets/:ticketId/check-in` with JSON
`{"token":"<scanned ticket-v1 token>"}`. Decode the token's claims only to choose
the ticket route; never trust that decoding as verification. The server verifies
the MAC and exact ticket binding before reading or updating the ticket. Missing,
forged, wrong-ticket, expired or raw-ID payloads return 400. Organizer
authorization is still required; possessing a token alone cannot check in a ticket.

## Production copy
The standalone cutover issues ima-jin/imajin-ai#2516, #2529 and #2784 were still
open when this fix was prepared. Repository documentation says kernel deployment
configs still own monorepo events entries. This PR changes only `ima-jin/events`;
it does not prove a production cutover or secure an old kernel checkout. Coordinate
the production copy's matching security rollout before claiming production protection.
