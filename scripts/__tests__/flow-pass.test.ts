import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { options, privateJson, assertTestSession, assertTestSetup, identifier, transport, markdown } from '../soak/flow-safety.mjs';
import { main, runFlows } from '../soak/flow-pass.mjs';

const dev = 'https://dev-jin.imajin.ai/events';
const args = (base = dev) => ['--env', 'dev', '--base-url', base, '--auth-file', '/private/fixture'];
const quiet = { ...console, log: vi.fn(), error: vi.fn() };
const types = [{ id: 'free', price: 0 }, { id: 'paid1', price: 100 }, { id: 'paid2', price: 200 }];
const manifest = { chain: [
  { did: 'did:imajin:fixture-a', role: 'creator', share: 0.5 },
  { did: 'did:imajin:fixture-b', role: 'contributor', share: 0.5 },
] };

function fixture({ live = false, createFail = false, settleFail = false, setupLive = false } = {}) {
  const calls: { path: string; method: string; headers: Headers; body: unknown }[] = [];
  let buyerReads = 0;
  let refunded = false;
  let charged = false;
  const order = () => ({
    id: 'ord_fixture', isLegacy: false,
    tickets: [{ status: refunded ? 'refunded' : 'valid' }, { status: refunded ? 'refunded' : 'valid' }],
    fairSettlement: { settledAt: '2026-10-15', totalAmount: 3, chain: manifest.chain.map((entry) => ({ ...entry, amount: 1.5 })) },
  });
  const fetcher = vi.fn(async (value: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(value instanceof Request ? value.url : String(value));
    const path = url.pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ path, method, headers: init.headers as Headers, body });
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
    if (path.endsWith('/api/health')) return json({ status: 'ok', service: 'imajin-events' });
    if (path.endsWith('kernel-signing-key')) return json({ publicKey: 'fixture-public' });
    if (path.endsWith('/api/events') && method === 'GET') return json({ events: [{ id: 'evt_fixture' }] });
    if (path.endsWith('/api/events') && method === 'POST') {
      if (createFail) return json({ error: 'private@example.test did:imajin:private' }, 500);
      return json({ event: { id: body.eventType === 'campaign' ? 'evt_campaign' : 'evt_fixture' }, ticketTypes: types });
    }
    if (path.endsWith('/tiers')) return json({ tiers: types });
    if (path.endsWith('/fair')) return json({ manifest: body.manifest });
    if (path.endsWith('/api/events/evt_fixture') || path.endsWith('/api/events/evt_campaign')) return json({ event: body });
    if (path.endsWith('/checkout/free')) return json({ success: true, ticketId: 'tkt_fixture' });
    if (path.endsWith('/hold')) return json({ ticket: { id: 'held_fixture', status: 'held' } });
    if (path.endsWith('/cancel')) return json({ ticket: { id: 'held_fixture', status: 'cancelled' } });
    if (path.endsWith('/resend-email')) return json({ success: true, email: 'private@example.test', lastEmailSentAt: '2026-10-15' });
    if (path.endsWith('/guests')) return json({ guests: [{ id: 'tkt_fixture', lastEmailSentAt: '2026-10-15' }] });
    if (path.endsWith('/qr')) return json({ qrCodeDataUri: 'data:image/png;base64,fixture' });
    if (path.includes('/old/check-in')) return json({ error: 'Invalid or expired ticket QR token' }, 400);
    if (path.endsWith('/check-in')) return json({ ticket: { id: 'tkt_fixture', usedAt: '2026-10-15' } });
    if (path.endsWith('/my-ticket')) {
      buyerReads++;
      return json({ tickets: [{ id: 'existing' }], orders: buyerReads > 1 ? [order()] : [] });
    }
    if (path.endsWith('/api/checkout')) {
      const sessionId = live ? 'cs_live_fixture' : 'cs_test_fixture';
      return json({ sessionId, url: `https://checkout.stripe.com/c/pay/${sessionId}` });
    }
    if (path.endsWith('/refund')) { refunded = true; return json({ success: true }); }
    if (path.endsWith('/campaign/pledge')) return json({
      pledgeId: 'plg_fixture', clientSecret: 'seti_fixture_secret_private',
      publishableKey: setupLive ? 'pk_live_fixture' : 'pk_test_fixture',
    });
    if (path.endsWith('/my-pledge')) return json({ pledge: { id: 'plg_fixture', status: charged ? 'charged' : 'confirmed' } });
    if (path.endsWith('/settle')) { charged = true; return json({ charged: settleFail ? 0 : 1, failed: settleFail ? 1 : 0 }); }
    if (path.endsWith('/export') || path.endsWith('.csv')) return new Response('column\nprivate@example.test');
    if (path.includes('/api/')) return json({ success: true });
    return new Response('<!doctype html><html>Fixture</html>');
  });
  return { fetcher, calls };
}

describe('flow pass safety contract', () => {
  it.each(['https://jin.imajin.ai/events', 'https://evil.test/events', 'https://dev-jin.imajin.ai.evil.test/events',
    'http://dev-jin.imajin.ai/events', `${dev}?token=private`, 'https://user:pass@dev-jin.imajin.ai/events',
    'https://dev-jin.imajin.ai:3006/events', 'https://dev-jin.imajin.ai/wrong'])('refuses unsafe target %s', (url) => {
    expect(() => options(args(url))).toThrow();
  });
  it('requires explicit options and bounds polling', () => {
    expect(options(args()).timeout).toBe(180_000);
    expect(options([...args(), '--interactive', '--timeout-seconds', '2']).timeout).toBe(2000);
    for (const extra of [['--unknown'], ['--timeout-seconds', '0'], ['--timeout-seconds', '901'], ['--timeout-seconds', 'NaN']]) {
      expect(() => options([...args(), ...extra])).toThrow();
    }
    expect(() => options([])).toThrow();
  });
  it('refuses group/world-readable auth and symlinks without exposing contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-auth-'));
    const file = join(dir, 'auth');
    try {
      writeFileSync(file, '{"cookie":"never-print-fixture"}', { mode: 0o600 });
      expect(privateJson(file)).toEqual({ cookie: 'never-print-fixture' });
      for (const mode of [0o640, 0o604, 0o644]) {
        chmodSync(file, mode);
        expect(() => privateJson(file)).toThrow('0600');
      }
      chmodSync(file, 0o600);
      symlinkSync(file, join(dir, 'link'));
      expect(() => privateJson(join(dir, 'link'))).toThrow('0600');
      expect(() => privateJson(dir)).toThrow('0600');
      writeFileSync(file, '{invalid never-print-fixture');
      expect(() => privateJson(file)).toThrow('0600');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses live/malformed checkout and SetupIntent evidence', () => {
    assertTestSession({ sessionId: 'cs_test_fixture', url: 'https://checkout.stripe.com/c/pay/cs_test_fixture' });
    for (const data of [
      { sessionId: 'cs_live_private', url: 'https://checkout.stripe.com/c/pay/cs_live_private' },
      { sessionId: 'cs_test_fixture', url: 'https://evil.test/cs_test_fixture' },
      { sessionId: 'cs_test_fixture', url: 'https://checkout.stripe.com/other' },
      { sessionId: 'cs_test_fixture', livemode: true },
      {},
    ]) expect(() => assertTestSession(data)).toThrow();
    assertTestSetup({ publishableKey: 'pk_test_fixture', clientSecret: 'seti_fixture_secret_private' });
    expect(() => assertTestSetup({ publishableKey: 'pk_live_private', clientSecret: 'seti_fixture_secret_private' })).toThrow();
    expect(() => assertTestSetup({})).toThrow();
    expect(() => identifier('../escape')).toThrow();
    expect(() => identifier(undefined)).toThrow();
  });
  it('enforces GET/HEAD even when transport is called directly in prod smoke', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}'));
    const request = transport({ ...options([...args(), '--prod-smoke']) }, {}, fetcher);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await expect(request('api/checkout', { method })).rejects.toThrow('read-only');
    expect(fetcher).not.toHaveBeenCalled();
    for (const path of ['https://evil.test/events', '/pay/api/checkout', '/events/../auth/api/session']) {
      await expect(request(path)).rejects.toThrow('escaped');
    }
    await request('api/health', { method: 'HEAD' });
    expect(fetcher.mock.calls[0][0]).toBe(`${dev}/api/health`);
  });
  it('checks response status and renders without recording sensitive failures', async () => {
    await expect(transport(options(args()), {}, async () => new Response('secret', { status: 500 }))('api/health')).rejects.toThrow('HTTP 500');
    for (const body of ['', '<html>Not claimed yet</html>']) {
      await expect(transport(options(args()), {}, async () => new Response(body))('./', { json: false })).rejects.toThrow();
    }
    const report = markdown([{ name: 'evt_private did:imajin:private', result: 'pass', ms: 1, note: 'person@example.test | ord_private\nnote' }]);
    expect(report).not.toMatch(/person@|did:|evt_private|ord_private/);
    expect(report).toContain('[email]');
  });
  it('follows legacy redirects only within approved paths and never repeats writes', async () => {
    const redirect = (location: string) => new Response('', { status: 302, headers: { location } });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(redirect('/events/e/evt_fixture'))
      .mockResolvedValueOnce(new Response('<html>fixture</html>'));
    const request = transport(options([...args(), '--prod-smoke']), {}, fetcher);
    expect(await request('/events/old', { json: false })).toContain('fixture');
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const destination of ['https://evil.test/events', '/auth/api/session']) {
      await expect(transport(options(args()), {}, async () => redirect(destination))('/events/old')).rejects.toThrow('escaped');
    }
    await expect(transport(options(args()), {}, async () => redirect('/events/loop'))('/events/loop')).rejects.toThrow('limit');
    const write = vi.fn<typeof fetch>(async () => redirect('/events/api/checkout'));
    await expect(transport(options(args()), {}, write)('api/checkout', { method: 'POST' })).rejects.toThrow('302');
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('scripted HTTP flows', () => {
  it('runs prod smoke read-only with malicious write fixtures ignored', async () => {
    const { fetcher, calls } = fixture();
    const rows = await runFlows(options([...args('https://jin.imajin.ai/events'), '--prod-smoke']), {
      fairManifest: manifest, oldTicket: { token: 'private' },
      legacyUrls: ['/events/e/evt_legacy'], existingTicket: { eventId: 'evt_fixture', ticketId: 'existing' },
      buyer: { cookie: 'private-cookie', Host: 'evil.test' },
    }, { fetcher, output: quiet });
    expect(calls.every((call) => ['GET', 'HEAD'].includes(call.method))).toBe(true);
    expect(rows.some((row) => row.result === 'fail')).toBe(false);
    expect(rows.some((row) => row.name === 'Prod operator checklist' && row.result === 'manual')).toBe(true);
    expect(calls.find((call) => call.path.endsWith('/my-ticket'))?.headers.get('cookie')).toBe('private-cookie');
    expect(calls.every((call) => !call.headers.has('host'))).toBe(true);
    expect(markdown(rows)).not.toMatch(/private-cookie|private@example|did:imajin/);
  });
  it('labels missing samples as manual, not false passes', async () => {
    const { fetcher } = fixture();
    const rows = await runFlows(options([...args(), '--prod-smoke']), {}, { fetcher, output: quiet });
    expect(rows.filter((row) => row.result === 'manual').map((row) => row.name)).toContain('Existing ticket lookup');
  });
  it('runs all HTTP contracts in interactive dev with simulated browser effects', async () => {
    const { fetcher, calls } = fixture();
    const rows = await runFlows(options([...args(), '--interactive']), {
      fairManifest: manifest, oldTicket: { eventId: 'evt_old', ticketId: 'old', token: 'genuine-fixture-old-token' },
      legacyUrls: ['/events/e/evt_legacy'],
    }, { fetcher, output: quiet, readAuth: () => ({ newTicketTokens: { tkt_fixture: 'scanned-private-token' } }) });
    expect(rows.filter((row) => row.result === 'fail')).toEqual([]);
    for (const name of ['New QR check-in', 'Paid order refund', 'Campaign settle', 'Settlement callback effect',
      'Old QR rejected cleanly (ruling b)', 'Confirmation notification bookkeeping']) {
      expect(rows.find((row) => row.name === name)?.result).toBe('pass');
    }
    expect(calls.some((call) => call.path.endsWith('/settle'))).toBe(true);
    expect(calls.some((call) => call.path.includes('/webhook/'))).toBe(false);
    expect(markdown(rows)).not.toMatch(/did:imajin|@example|scanned-private|seti_fixture_secret/);
  });
  it('reports browser gates manual in noninteractive dev', async () => {
    const { fetcher, calls } = fixture();
    const rows = await runFlows(options(args()), {}, { fetcher, output: quiet });
    expect(rows.filter((row) => row.result === 'fail')).toEqual([]);
    expect(rows.find((row) => row.name === 'Paid order refund')?.result).toBe('manual');
    expect(calls.some((call) => call.path.endsWith('/settle') || call.path.endsWith('/refund'))).toBe(false);
  });
  it('halts payment-dependent writes on a live session', async () => {
    const { fetcher, calls } = fixture({ live: true });
    const rows = await runFlows(options(args()), {}, { fetcher, output: quiet });
    expect(rows.find((row) => row.name === 'Paid multi-tier TEST checkout session')?.result).toBe('fail');
    expect(calls.some((call) => /\/(refund|settle|pledge)$/.test(call.path))).toBe(false);
  });
  it('fails create without leaking server PII and does not buy', async () => {
    const { fetcher, calls } = fixture({ createFail: true });
    const rows = await runFlows(options(args()), {}, { fetcher, output: quiet });
    expect(rows.find((row) => row.name === 'Create event')?.result).toBe('fail');
    expect(calls.some((call) => call.path.endsWith('/checkout'))).toBe(false);
    expect(markdown(rows)).not.toContain('private@example.test');
  });
  it('does not settle a live SetupIntent', async () => {
    const { fetcher, calls } = fixture({ setupLive: true });
    const rows = await runFlows(options([...args(), '--interactive']), {}, {
      fetcher, output: quiet, readAuth: () => ({ newTicketTokens: { tkt_fixture: 'fixture' } }),
    });
    expect(rows.find((row) => row.name === 'Pledge TEST SetupIntent')?.result).toBe('fail');
    expect(calls.some((call) => call.path.endsWith('/settle'))).toBe(false);
  });
  it('times out browser state polling and never refunds an unobserved order', async () => {
    const data = fixture();
    let now = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).includes('/my-ticket')) return new Response('{"orders":[]}');
      return data.fetcher(input, init);
    };
    try {
      const rows = await runFlows(options([...args(), '--interactive', '--timeout-seconds', '1']), {}, {
        fetcher, output: quiet, pause: async () => { now += 2000; },
        readAuth: () => ({ newTicketTokens: { tkt_fixture: 'fixture' } }),
      });
      expect(rows.find((row) => row.name === 'Payment callback effect')?.result).toBe('fail');
      expect(data.calls.some((call) => call.path.endsWith('/refund'))).toBe(false);
    } finally { clock.mockRestore(); }
  });
  it('reports failed campaign charges as failures', async () => {
    const { fetcher } = fixture({ settleFail: true });
    const rows = await runFlows(options([...args(), '--interactive']), {}, {
      fetcher, output: quiet, readAuth: () => ({ newTicketTokens: { tkt_fixture: 'fixture' } }),
    });
    expect(rows.find((row) => row.name === 'Campaign settle')?.result).toBe('fail');
  });
  it('exits nonzero for automated failures, writes only a private new report, refuses invalid auth', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'soak-main-'));
    const file = join(dir, 'auth');
    const report = join(dir, 'report');
    try {
      writeFileSync(file, '{}', { mode: 0o600 });
      const argv = [...args(), '--auth-file', file, '--report', report];
      expect(await main(argv, { ...fixture({ createFail: true }), output: quiet })).toBe(1);
      expect(readFileSync(report, 'utf8')).toContain('| Create event | fail |');
      expect(await main(argv, { ...fixture(), output: quiet })).toBe(1); // refuses overwrite
      chmodSync(file, 0o644);
      const fetcher = vi.fn();
      expect(await main(argv, { fetcher, output: quiet })).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
