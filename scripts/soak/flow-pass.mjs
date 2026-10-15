#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { options, privateJson, transport, markdown, identifier, assertTestSession, assertTestSetup } from './flow-safety.mjs';

const MANUAL = 'manual';
function requireValue(value) {
  if (!value) throw new Error('Required response field absent.');
  return value;
}

export async function runFlows(config, auth, { fetcher = fetch, output = console, pause = (ms) => sleep(ms), readAuth = () => privateJson(config.authFile) } = {}) {
  const request = transport(config, auth, fetcher);
  const rows = [];
  const state = {};
  const manual = (name, note) => rows.push({ name, result: MANUAL, ms: 0, note });
  async function step(name, action, note = 'HTTP contract verified.') {
    const started = performance.now();
    try {
      const result = await action();
      rows.push({ name, result: 'pass', ms: performance.now() - started, note });
      return result;
    } catch {
      // Server errors may include PII or credentials. Deliberately do not log arbitrary exception messages.
      rows.push({ name, result: 'fail', ms: performance.now() - started, note: 'Contract failed; inspect privately. No response body recorded.' });
      return undefined;
    }
  }
  async function poll(read, matches) {
    const deadline = Date.now() + config.timeout;
    async function attempt() {
      const value = await read();
      if (matches(value)) return value;
      if (Date.now() >= deadline) throw new Error('Timed out waiting for state transition.');
      await pause(2000);
      return attempt();
    }
    return attempt();
  }
  function browser(name, url, instruction) {
    // Only validated Stripe checkout URLs or locally constructed public URLs reach operator output.
    const safeUrl = url.replaceAll(/[\u0000-\u001f\u007f]/g, '');
    output.log(`${name}: ${safeUrl}\n${instruction}`);
  }
  async function render(name, path, role) {
    return step(name, async () => {
      const html = await request(path, { json: false, role });
      requireValue(html.includes('<html') || html.includes('<!DOCTYPE') || html.includes('<!doctype'));
      requireValue(!html.includes('This page could not be found'));
    }, 'HTML fetched; visual/browser behavior remains operator verification.');
  }
  async function publicChecks(eventId) {
    await render('Public event list render', './');
    if (eventId) await render('Public event page render', `e/${identifier(eventId)}`);
    else manual('Public event page render', 'Provide publicEventId or a published event in the loader dataset.');
    // There is no embed renderer/route in this checkout. Do not invent one or pass ?embed=true as proof.
    manual('Embed render', 'No events embed HTTP route exists here; verify the real consuming iframe/registration embed in a browser.');
    const urls = config.legacySamples ?? auth.legacyUrls ?? [];
    if (urls.length === 0) manual('Legacy shared URLs', 'Supply private legacyUrls samples from loader rows or --legacy-urls.');
    await Promise.all(urls.map((url, index) => render(`Legacy shared URL sample ${index + 1}`, url)));
  }
  await step('Health', async () => {
    const health = await request('api/health');
    requireValue(health.status === 'ok' && health.service === 'imajin-events');
  });
  await step('Kernel callback signer reachability', async () => {
    const key = await request('/auth/.well-known/kernel-signing-key');
    requireValue(key && typeof key === 'object' && Object.keys(key).length > 0);
  }, 'Discovery reachable only; signature acceptance is covered by callback effect checks.');
  const listed = await step('Public event API list', async () => {
    const data = await request('api/events?status=published&limit=5');
    requireValue(Array.isArray(data.events));
    return data.events;
  });
  if (config.prodSmoke) {
    await publicChecks(auth.publicEventId ?? listed?.[0]?.id);
    if (auth.existingTicket) {
      await step('Existing ticket lookup', async () => {
        const data = await request(`api/events/${identifier(auth.existingTicket.eventId)}/my-ticket`, { role: 'buyer' });
        requireValue(data.tickets?.some((ticket) => ticket.id === auth.existingTicket.ticketId));
      });
    } else manual('Existing ticket lookup', 'Supply existingTicket eventId/ticketId and its holder session.');
    manual('Prod operator checklist', 'Operator only: buy one real/comped ticket; refund it; validate its QR. Smoke never performs writes.');
    output.log('PROD MANUAL CHECKLIST: [ ] buy one real/comped ticket [ ] refund it [ ] validate its QR. Not performed by this script.');
    return rows;
  }

  const created = await step('Create event', async () => {
    const data = await request('api/events', {
      method: 'POST', role: 'organizer', body: {
        title: 'Cutover soak fixture', description: 'Disposable dev soak fixture',
        startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), chatEnabled: false,
        tickets: [
          { name: 'RSVP', price: 0, currency: 'CAD', quantity: 20 },
          { name: 'Standard', price: 100, currency: 'CAD', quantity: 20 },
          { name: 'Supporter', price: 200, currency: 'CAD', quantity: 20 },
        ],
      },
    });
    requireValue(data.event?.id && data.ticketTypes?.length === 3);
    return data;
  });
  state.eventId = created?.event?.id;
  state.types = created?.ticketTypes;
  if (!state.eventId) {
    manual('Dependent event flows', 'Event creation failed; edit/checkout/dashboard/refund/cancel not run.');
    await publicChecks(auth.publicEventId ?? listed?.[0]?.id);
    return rows;
  }
  const eventPath = `api/events/${identifier(state.eventId)}`;
  await step('Edit event', async () => {
    const data = await request(eventPath, { method: 'PUT', role: 'organizer', body: { description: 'Edited disposable soak fixture' } });
    requireValue(data.event?.description === 'Edited disposable soak fixture');
  });
  await step('Multi-tier ticket types', async () => {
    const data = await request(`${eventPath}/tiers`);
    requireValue(data.tiers?.length === 3 && new Set(data.tiers.map((tier) => tier.price)).size === 3);
  });
  if (auth.fairManifest) {
    await step('Multi-seller .fair manifest', async () => {
      const sellers = auth.fairManifest.chain?.filter((entry) => ['creator', 'contributor'].includes(entry.role));
      requireValue(new Set(sellers?.map((entry) => entry.did)).size >= 2);
      const data = await request(`${eventPath}/fair`, { method: 'PATCH', role: 'organizer', body: { manifest: auth.fairManifest } });
      requireValue(JSON.stringify(data.manifest) === JSON.stringify(auth.fairManifest));
      state.multiSeller = true;
    }, 'Manifest round-trip only; actual split settlement is checked on the paid receipt.');
  } else manual('Multi-seller .fair manifest', 'Provide fairManifest with two distinct creator/contributor payees from DEV test accounts.');
  manual('Tax quote', 'Checkout returns only sessionId/url. In hosted TEST checkout verify tax address, rate, amount and total; compare Stripe receipt. No tax quote API exists in this app.');
  await step('Publish event', async () => {
    const data = await request(eventPath, { method: 'PATCH', role: 'organizer', body: { status: 'published' } });
    requireValue(data.event?.status === 'published');
  });
  await publicChecks(state.eventId);
  const freeType = state.types?.find((type) => type.price === 0);
  const paidTypes = state.types?.filter((type) => type.price > 0) ?? [];
  await step('Hold and cancel unconfirmed ticket', async () => {
    const held = await request(`${eventPath}/hold`, { method: 'POST', role: 'buyer', body: {
      ticketTypeId: requireValue(paidTypes[0]?.id), holdHours: 1,
    } });
    requireValue(held.ticket?.status === 'held');
    const cancelled = await request(`${eventPath}/tickets/${identifier(held.ticket.id)}/cancel`, {
      method: 'POST', role: 'organizer', body: {},
    });
    requireValue(cancelled.ticket?.status === 'cancelled');
  });
  const rsvp = await step('Free RSVP', async () => {
    const data = await request('api/checkout/free', { method: 'POST', role: 'buyer', body: {
      eventId: state.eventId, ticketTypeId: requireValue(freeType?.id),
    } });
    requireValue(data.success && data.ticketId);
    return data;
  });
  if (rsvp) await newTicketCheckin(rsvp.ticketId);
  if (auth.oldTicket) {
    await step('Old QR rejected cleanly (ruling b)', async () => {
      const old = auth.oldTicket;
      const data = await request(`api/events/${identifier(old.eventId)}/tickets/${identifier(old.ticketId)}/check-in`, {
        method: 'POST', role: 'organizer', body: { token: requireValue(old.token) }, statuses: [400],
      });
      requireValue(data.error === 'Invalid or expired ticket QR token');
    }, 'Old pre-cutover signed token rejected with explicit 400; no reissue.');
  } else manual('Old QR rejected cleanly (ruling b)', 'Provide oldTicket with genuine pre-cutover token, eventId and ticketId; never synthesize an old secret.');
  const before = await step('Buyer order baseline', () => request(`${eventPath}/my-ticket`, { role: 'buyer' }));
  const checkout = await step('Paid multi-tier TEST checkout session', async () => {
    requireValue(paidTypes.length === 2);
    const data = await request('api/checkout', { method: 'POST', role: 'buyer', body: {
      eventId: state.eventId, items: paidTypes.map((type) => ({ ticketTypeId: type.id, quantity: 1 })),
    } });
    assertTestSession(data);
    return data;
  });
  if (!checkout) {
    manual('Payment-dependent flows halted', 'No verified TEST session; no browser, paid refund or campaign settlement will run.');
    await dashboards();
    return rows;
  }
  browser('Hosted Stripe TEST checkout', checkout.url, 'Use test card 4242 4242 4242 4242, future expiry and any CVC. Verify both tiers, .fair sellers and taxes. Never use a real card.');
  await paidCompletion(before);
  await dashboards();
  await campaign();
  await step('Cancel event', async () => {
    const data = await request(eventPath, { method: 'PATCH', role: 'organizer', body: { status: 'cancelled' } });
    requireValue(data.event?.status === 'cancelled');
  });
  manual('Emails and notifications', 'Check DEV inbox + notification UI for RSVP, payment confirmation, check-in, refund and cancellation. Ticket creation is not delivery evidence; no delivery status API exists.');
  manual('Balance / e-transfer / registration', 'Additional rails and survey-dependent registration need seeded balances, manual transfer and completed Dykil survey. Verify in browser; no automatic funds or survey setup.');
  return rows;

  async function newTicketCheckin(ticketId) {
    await step('New holder QR image', async () => {
      const data = await request(`api/tickets/${identifier(ticketId)}/qr`, { role: 'buyer' });
      requireValue(data.qrCodeDataUri?.startsWith('data:image/png;base64,'));
    });
    browser('New ticket QR', `${config.baseUrl}/e/${identifier(state.eventId)}`, 'Sign in as buyer, scan the new ticket QR. Privately put its raw token in auth-file newTicketTokens[ticketId]; do not paste into shell.');
    if (!config.interactive) {
      manual('New QR check-in', 'Requires QR image scan; rerun --interactive to wait for private token input and submit check-in.');
      return;
    }
    await step('New QR check-in', async () => {
      const token = await poll(async () => readAuth().newTicketTokens?.[ticketId], Boolean);
      const data = await request(`${eventPath}/tickets/${identifier(ticketId)}/check-in`, { method: 'POST', role: 'organizer', body: { token } });
      requireValue(data.ticket?.id === ticketId && data.ticket.usedAt);
    });
  }

  async function paidCompletion(baseline) {
    if (!config.interactive) {
      for (const name of ['Hosted checkout completion', 'Payment callback effect', 'Settlement callback effect', 'Paid order refund']) {
        manual(name, 'Use --interactive to complete the TEST checkout and poll the resulting order/receipt transition.');
      }
      return;
    }
    const previous = new Set(baseline?.orders?.map((order) => order.id));
    const order = await step('Payment callback effect', async () => {
      requireValue(baseline);
      const data = await poll(() => request(`${eventPath}/my-ticket`, { role: 'buyer' }),
        (value) => value.orders?.some((item) => !item.isLegacy && !previous.has(item.id) && item.tickets?.length === 2));
      return data.orders.find((item) => !item.isLegacy && !previous.has(item.id));
    }, 'New two-ticket order observed after TEST checkout; no fake callbacks or confirm-payment fallback sent.');
    if (!order) return;
    await step('Settlement callback effect', async () => {
      const data = await poll(() => request(`${eventPath}/my-ticket`, { role: 'buyer' }),
        (value) => value.orders?.some((item) => item.id === order.id && item.fairSettlement?.settledAt));
      const receipt = data.orders.find((item) => item.id === order.id).fairSettlement;
      requireValue(receipt.chain?.length && Number.isFinite(receipt.totalAmount));
      if (state.multiSeller) {
        const expected = auth.fairManifest.chain.filter((entry) => ['creator', 'contributor'].includes(entry.role));
        requireValue(expected.every((entry) => receipt.chain.some((paid) => paid.did === entry.did && paid.amount > 0)));
      }
    });
    await step('Paid order refund', async () => {
      await request(`api/orders/${identifier(order.id)}/refund`, { method: 'POST', role: 'organizer', body: {} });
      await poll(() => request(`${eventPath}/my-ticket`, { role: 'buyer' }),
        (value) => value.orders?.find((item) => item.id === order.id)?.tickets.every((ticket) => ticket.status === 'refunded'));
    });
  }

  async function dashboards() {
    await Promise.all([
      ['Organizer events', 'api/events/mine', true],
      ['Organizer sales', `${eventPath}/sales`, true],
      ['Organizer guests', `${eventPath}/guests`, true],
      ['Sales export', `${eventPath}/sales/export`, false],
      ['Guest export', `${eventPath}/guests/export.csv`, false],
    ].map(([name, path, json]) => step(name, () => request(path, { role: 'organizer', json }), 'Fetched privately; response/export contents never recorded.')));
    await render('Organizer dashboard render', 'dashboard', 'organizer');
  }

  async function campaign() {
    const data = await step('Create campaign', () => request('api/events', {
      method: 'POST', role: 'organizer', body: {
        title: 'Cutover soak campaign', startsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        eventType: 'campaign', targetAmount: 100, chatEnabled: false,
      },
    }));
    if (!data?.event?.id) return;
    const path = `api/campaign/${identifier(data.event.id)}`;
    await step('Publish campaign', () => request(`api/events/${identifier(data.event.id)}`, {
      method: 'PATCH', role: 'organizer', body: { status: 'published' },
    }));
    const pledge = await step('Pledge TEST SetupIntent', async () => {
      const value = await request('api/campaign/pledge', { method: 'POST', role: 'buyer', body: { eventId: data.event.id, amount: 100 } });
      assertTestSetup(value);
      return value;
    }, 'pk_test evidence checked; SetupIntent IDs alone do not encode test/live mode. Client secret never output.');
    if (!pledge) return;
    browser('Campaign TEST pledge', `${config.baseUrl}/e/${identifier(data.event.id)}`,
      'Complete this pending pledge through the DEV campaign UI using 4242; do not create a different pledge. Confirmed/charged state will be polled.');
    if (!config.interactive) {
      manual('Pledge confirm + campaign settle', 'Use --interactive; browser must finish SetupIntent and call pledge/confirm through the normal UI.');
      return;
    }
    const confirmed = await step('Pledge confirmation transition', () =>
      poll(() => request(`${path}/my-pledge`, { role: 'buyer' }),
        (value) => value.pledge?.id === pledge.pledgeId && value.pledge.status === 'confirmed'));
    if (!confirmed) return;
    await step('Campaign settle', async () => {
      const result = await request(`${path}/settle`, { method: 'POST', role: 'organizer', body: {} });
      requireValue(result.charged === 1 && result.failed === 0);
      await poll(() => request(`${path}/my-pledge`, { role: 'buyer' }),
        (value) => value.pledge?.id === pledge.pledgeId && value.pledge.status === 'charged');
    }, 'Confirmed-to-charged observed. Charge route also persists state; this alone does not prove callback provenance.');
  }
}

export async function main(argv, dependencies = {}) {
  const output = dependencies.output ?? console;
  try {
    const config = options(argv);
    const auth = privateJson(config.authFile);
    if (config.legacyUrls) {
      config.legacySamples = privateJson(config.legacyUrls);
      if (!Array.isArray(config.legacySamples)) throw new Error('Legacy URL list must be a JSON array.');
    }
    const rows = await runFlows(config, auth, dependencies);
    const report = markdown(rows);
    if (config.report) writeFileSync(config.report, report, { mode: 0o600, flag: 'wx' });
    output.log(report);
    return rows.some((row) => row.result === 'fail') ? 1 : 0;
  } catch {
    output.error('Flow pass refused or failed: check arguments, private 0600 input and docs/SOAK.md. No input or response data printed.');
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
