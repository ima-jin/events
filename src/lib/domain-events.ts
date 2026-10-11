import { createLogger } from '@ima-jin/logger';
import { kernelFetch } from './kernel';

/**
 * Domain-event publisher — replaces the kernel's in-process `@imajin/bus`
 * `publish()`. The bus is kernel-internal; this app emits `event.*` /
 * `ticket.*` / `order.*` / `checkin.*` events by calling the kernel's
 * app-auth-gated domain API instead of importing a publisher.
 *
 * gap(kernel): the kernel does not yet expose a public publish route.
 * Until it does, set `IMAJIN_EVENTS_PUBLISH_PATH` (e.g. the path the kernel
 * ships) to enable delivery; when unset, publishing is a logged no-op so
 * routes keep their kernel-parity request/response behaviour. Reactor-driven
 * side effects (notification emails, attestations) depend on the kernel
 * receiving these events — see docs/KERNEL-GAPS.md.
 */

const log = createLogger('events');

export interface DomainEvent {
  issuer: string;
  subject: string;
  scope: string;
  payload: Record<string, unknown>;
  correlationId?: string;
  timestamp?: string;
}

export interface PublishResult {
  attestationId?: string;
}

/**
 * Publish a domain event. Never throws — callers treat publishing as
 * best-effort, exactly as the kernel routes did (`.catch(log)`).
 */
export async function publish(type: string, event: DomainEvent): Promise<PublishResult> {
  const path = process.env.IMAJIN_EVENTS_PUBLISH_PATH;
  if (!path) {
    log.debug({ event: type }, 'IMAJIN_EVENTS_PUBLISH_PATH not set — domain event not delivered');
    return {};
  }

  const result = await kernelFetch<PublishResult>(path, {
    method: 'POST',
    body: { type, ...event, timestamp: event.timestamp ?? new Date().toISOString() },
  });
  return result ?? {};
}
