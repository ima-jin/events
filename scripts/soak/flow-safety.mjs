import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';

export const DEV_HOST = 'dev-jin.imajin.ai';

export function privateJson(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) {
      throw new Error('permissions');
    }
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch {
    throw new Error('Private input must be an owned regular 0600 JSON file (no symlinks).');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function options(argv) {
  const result = { prodSmoke: false, interactive: false, timeout: 180_000 };
  const values = new Map([
    ['--env', 'env'], ['--base-url', 'baseUrl'], ['--auth-file', 'authFile'],
    ['--report', 'report'], ['--legacy-urls', 'legacyUrls'], ['--timeout-seconds', 'timeout'],
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--prod-smoke') result.prodSmoke = true;
    else if (arg === '--interactive') result.interactive = true;
    else if (values.has(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      result[values.get(arg)] = argv[++i];
    } else throw new Error('Invalid arguments; see docs/SOAK.md.');
  }
  if (!['dev', 'prod'].includes(result.env) || !result.authFile) throw new Error('env and auth-file are required.');
  const url = new URL(result.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      url.search || url.hash || url.pathname.replaceAll(/\/+$/g, '') !== '/events') {
    throw new Error('Base URL must be HTTPS with /events and no credentials, port, query or fragment.');
  }
  if (!result.prodSmoke && (url.hostname !== DEV_HOST || result.env !== 'dev')) {
    throw new Error('Writes are restricted to the dev host; use --prod-smoke for read-only checks.');
  }
  result.baseUrl = `${url.origin}/events`;
  if (typeof result.timeout === 'string') result.timeout = Number(result.timeout) * 1000;
  if (!Number.isFinite(result.timeout) || result.timeout < 1000 || result.timeout > 900_000) {
    throw new Error('Timeout must be 1–900 seconds.');
  }
  return result;
}

export function assertTestSession(data) {
  if (data.livemode === true || typeof data.sessionId !== 'string' || !data.sessionId.startsWith('cs_test_')) {
    throw new Error('STOP: kernel did not return a Stripe TEST checkout session.');
  }
  const url = new URL(data.url);
  if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com' ||
      url.username || url.password || !url.pathname.includes(data.sessionId)) {
    throw new Error('STOP: checkout URL does not match the TEST session.');
  }
}

export function assertTestSetup(data) {
  // SetupIntent IDs have no test/live prefix; the kernel-returned publishable key is the available mode evidence.
  if (data.livemode === true || !data.publishableKey?.startsWith('pk_test_') ||
      !data.clientSecret?.startsWith('seti_') || !data.clientSecret.includes('_secret_')) {
    throw new Error('STOP: kernel did not return TEST SetupIntent evidence.');
  }
}

export function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value)) {
    throw new Error('Expected an opaque fixture identifier.');
  }
  return encodeURIComponent(value);
}

export function transport(config, auth, fetcher = fetch) {
  const origin = new URL(config.baseUrl).origin;
  return async (path, { method = 'GET', body, role, json = true, statuses = [200, 201] } = {}) => {
    if (config.prodSmoke && !['GET', 'HEAD'].includes(method)) throw new Error('Prod smoke is read-only.');
    const url = new URL(path, `${config.baseUrl}/`);
    if (url.origin !== origin || url.username || url.password ||
        !(url.pathname === '/events' || url.pathname.startsWith('/events/') ||
          url.pathname === '/auth/.well-known/kernel-signing-key')) {
      throw new Error('Request escaped the approved origin/path.');
    }
    const headers = new Headers();
    // Never send arbitrary fixture headers (Host, forwarding headers, etc.).
    for (const key of ['cookie', 'authorization', 'x-app-did', 'x-app-authorization']) {
      if (role && auth[role]?.[key]) headers.set(key, auth[role][key]);
    }
    if (body !== undefined) headers.set('content-type', 'application/json');
    const response = await fetcher(url.href, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    if (!statuses.includes(response.status)) throw new Error(`Unexpected HTTP ${response.status}.`);
    if (json) return response.json();
    const text = await response.text();
    if (!text || text.includes('Not claimed yet')) throw new Error('Empty or unclaimed render.');
    return text;
  };
}

// Only static, locally authored notes are reportable. Never pass response bodies/errors/URLs here.
export function markdown(rows) {
  const cell = (value) => String(value)
    .replaceAll(/did:[^\s|]+/g, '[identity]')
    .replaceAll(/[\w.+-]+@[\w.-]+/g, '[email]')
    .replaceAll(/(?:evt_|tkt_|ord_|plg_|cs_|seti_)[\w-]+/g, '[id]')
    .replaceAll('|', '/').replaceAll('\n', ' ');
  return ['# Events flow pass', '', '| Step | Result | Duration | Note |',
    '| --- | --- | --- | --- |', ...rows.map((row) =>
      `| ${cell(row.name)} | ${row.result} | ${(row.ms / 1000).toFixed(2)}s | ${cell(row.note)} |`),
    '', 'Manual rows are NOT passes. No live rehearsal or operator sign-off is implied.', ''].join('\n');
}
