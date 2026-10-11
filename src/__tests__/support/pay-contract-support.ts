/**
 * Shared assertions for the pay contract suites: they check the events app's
 * outbound HTTP requests against the checked-in contract fixture
 * (`test/fixtures/pay-contract.ts`, sourced from the public pay API shape)
 * instead of grepping source files or reaching into a kernel checkout.
 */
import { expect, vi } from 'vitest';
import { PAY_CONTRACT, type PayContractOperation } from '../../../test/fixtures/pay-contract';

/** A pay base URL as events is configured with it: already `/pay`-suffixed. */
export const PAY_BASE_URL = 'https://kernel.events.test/pay';

export interface PayFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

type FetchCall = [url: string, init?: PayFetchInit];

/** A typed `fetch` stub whose recorded calls can be handed straight to the assertions below. */
export function createFetchMock() {
  return vi.fn<(url: string, init?: PayFetchInit) => Promise<unknown>>();
}

/** Look up one documented operation. */
export function payOperation(path: string, method: 'get' | 'post'): PayContractOperation {
  const operation = PAY_CONTRACT.paths[path]?.[method];
  if (!operation) throw new Error(`pay contract fixture has no ${method.toUpperCase()} ${path}`);
  return operation;
}

/** Expand a documented path template (`{did}` etc.) into a concrete, URL-encoded path. */
export function expandPath(path: string, params: Record<string, string> = {}): string {
  let expanded = path;
  for (const [name, value] of Object.entries(params)) {
    expanded = expanded.replaceAll(`{${name}}`, encodeURIComponent(value));
  }
  return expanded;
}

/**
 * The full URL a documented path is served at under the pay service base:
 * the fixture's server prefix is `/{service}` with `service` defaulting to
 * `pay`, so the configured (already `/pay`-suffixed) base + the bare
 * documented path is exactly right — a second `/pay` segment would 404.
 */
export function expectedUrl(path: string, params: Record<string, string> = {}): string {
  return `${PAY_BASE_URL}${expandPath(path, params)}`;
}

/** Assert the call's URL is exactly the documented path under the pay base (no duplicated `/pay`). */
export function expectCallUrl(call: FetchCall, path: string, params: Record<string, string> = {}): void {
  expect(PAY_CONTRACT.server.pathPrefix).toBe('/{service}');
  expect(PAY_CONTRACT.server.serviceDefault).toBe('pay');
  expect(call[0]).toBe(expectedUrl(path, params));
  expect(call[0]).not.toContain('/pay/pay/');
}

/**
 * Assert the call authenticates with one of the operation's documented
 * security schemes. Events forwards the caller's own session cookie, so the
 * `cookieAuth` scheme (a cookie) must be both documented and the one used.
 */
export function expectCookieAuth(call: FetchCall, operation: PayContractOperation, cookie: string): void {
  expect(operation.security).toContain('cookieAuth');
  expect(PAY_CONTRACT.securitySchemes.cookieAuth).toMatchObject({ type: 'apiKey', in: 'cookie' });
  expect(call[1]?.headers?.Cookie).toBe(cookie);
}

/** Assert a JSON request body carries every required field and only documented ones. */
export function expectBodyMatchesContract(call: FetchCall, operation: PayContractOperation): Record<string, unknown> {
  const requestBody = operation.requestBody;
  if (!requestBody) throw new Error(`${operation.operationId} documents no request body`);
  const body = JSON.parse(call[1]?.body ?? '{}') as Record<string, unknown>;

  for (const field of requestBody.required) {
    expect(body, `required field ${field}`).toHaveProperty(field);
  }
  for (const [field, value] of Object.entries(body)) {
    const documented = requestBody.properties[field];
    expect(documented, `undocumented field ${field}`).toBeDefined();
    expect(typeof value, `type of ${field}`).toBe(documented.type);
  }
  return body;
}
