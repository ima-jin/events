import { serviceUrl } from './kernel';
import { getPayAppToken, invalidatePayAppToken } from './pay-app-token';

/** POST as events; only an explicit 401 is safe to retry, once with a fresh token. */
export async function postPayAsApp(path: string, body: unknown): Promise<Response> {
  const payUrl = serviceUrl('pay');
  if (!payUrl) throw new Error('pay service URL is not configured (IMAJIN_KERNEL_URL / PAY_SERVICE_URL)');

  const serializedBody = JSON.stringify(body);
  const send = async () => fetch(`${payUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await getPayAppToken()}`,
    },
    body: serializedBody,
  });
  const response = await send();
  if (response.status !== 401) return response;

  await invalidatePayAppToken().catch(() => undefined);
  return send();
}

/** A 403 can mean missing operator approval OR an app-ownership refusal; never retry it. */
export function payForbiddenMessage(scope: 'pay:refund' | 'pay:charge-pledges'): string {
  return `Pay refused ${scope}: the operator must approve ${scope} for events' app DID on the apps:service-scopes card, and the payment/setup must belong to this app`;
}
