#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const example = fileURLToPath(new URL('../.env.example', import.meta.url));
export const ENV_NAMES = readFileSync(example, 'utf8').split('\n').flatMap((line) => {
  const trimmed = line.trim();
  const assignment = trimmed.startsWith('#') ? trimmed.slice(1).trim() : trimmed;
  const separator = assignment.indexOf('=');
  const name = assignment.slice(0, separator);
  return separator > 0 && /^[A-Z][A-Z0-9_]*$/.test(name) ? [name] : [];
});

const REQUIRED = [
  'APP_DB_SCHEMA', 'IMAJIN_KERNEL_URL', 'IMAJIN_AUTH_URL',
  'AUTH_SERVICE_URL', 'NEXT_PUBLIC_IMAJIN_AUTH_URL', 'NEXT_PUBLIC_AUTH_URL',
  'NEXT_PUBLIC_APP_URL', 'NEXT_PUBLIC_EVENTS_URL', 'NEXT_PUBLIC_BASE_PATH',
  'IMAJIN_APP_DID', 'IMAJIN_APP_KEYSTORE',
];
const FORBIDDEN = [
  'DATABASE_URL',
  'IMAJIN_APP_PRIVATE_KEY', 'AUTH_INTERNAL_API_KEY', 'PROFILE_INTERNAL_API_KEY',
  'ENABLE_REQUEST_LOG', 'ENABLE_APP_LOG', 'LOG_DB_TRANSPORT',
  'PORT', 'NODE_ENV', 'NEXT_RUNTIME',
];
const URL_PATHS = {
  IMAJIN_KERNEL_URL: '', IMAJIN_AUTH_URL: '', NEXT_PUBLIC_IMAJIN_AUTH_URL: '',
  AUTH_SERVICE_URL: '/auth', NEXT_PUBLIC_AUTH_URL: '/auth',
  NEXT_PUBLIC_APP_URL: '/events', NEXT_PUBLIC_EVENTS_URL: '/events',
  AUTH_URL: '/auth', PAY_SERVICE_URL: '/pay', CONNECTIONS_SERVICE_URL: '/connections',
  PROFILE_SERVICE_URL: '/profile', CHAT_SERVICE_URL: '/chat', NOTIFY_SERVICE_URL: '/notify',
  REGISTRY_SERVICE_URL: '/registry', REGISTRY_URL: '/registry', DYKIL_URL: '/dykil',
};

function checkRequiredAndForbidden(env, problems) {
  for (const name of REQUIRED) {
    if (!env[name] || env[name].includes('REPLACE_ME')) problems.push(`${name}: required`);
  }
  for (const name of FORBIDDEN) {
    if (env[name]) problems.push(`${name}: must be unset`);
  }
}

function checkUrls(env, host, problems) {
  for (const [name, pathname] of Object.entries(URL_PATHS)) {
    if (!env[name]) continue;
    try {
      const url = new URL(env[name]);
      if (url.protocol !== 'https:' || url.host !== host || url.pathname !== (pathname || '/')
          || url.username || url.password || url.search || url.hash) {
        problems.push(`${name}: wrong environment, protocol or path`);
      }
    } catch {
      problems.push(`${name}: invalid URL`);
    }
  }
}

function checkTargetSettings(env, target, problems) {
  const settings = {
    APP_DB_SCHEMA: 'events',
    NEXT_PUBLIC_BASE_PATH: '/events',
    NEXT_PUBLIC_SERVICE_PREFIX: target === 'dev' ? 'dev-' : '',
    IMAJIN_ENV: target === 'dev' ? 'dev' : '',
  };
  for (const [name, value] of Object.entries(settings)) {
    if ((env[name] || '') !== value) problems.push(`${name}: wrong target setting`);
  }
  if ((env.NEXT_PUBLIC_DOMAIN || 'imajin.ai') !== 'imajin.ai') problems.push('NEXT_PUBLIC_DOMAIN: must be imajin.ai');
}

function checkIdentityAndSecrets(env, target, problems) {
  if (!/^did:imajin:[a-zA-Z0-9_-]+$/.test(env.IMAJIN_APP_DID || '')) problems.push('IMAJIN_APP_DID: invalid DID');
  if (env.IMAJIN_APP_AUD && env.IMAJIN_APP_AUD !== 'events') problems.push('IMAJIN_APP_AUD: must be events (registry slug)');
  if (env.ENABLE_TICKET_MIGRATION && env.ENABLE_TICKET_MIGRATION !== 'false') {
    problems.push('ENABLE_TICKET_MIGRATION: leave unset/false until cutover soak sign-off');
  }
  const keystore = env.IMAJIN_APP_KEYSTORE || '';
  if (!isAbsolute(keystore) || !keystore.endsWith(`events.${target}.keystore.json`)) {
    problems.push('IMAJIN_APP_KEYSTORE: requires an absolute per-environment events keystore path');
  }
}

/** Reports names only; optional warnings never affect the returned blocking errors. */
export function validateEnvironment(env, target, keystoreExists = existsSync, warnings = []) {
  if (!['dev', 'prod'].includes(target)) return ['target must be dev or prod'];
  const problems = [];
  checkRequiredAndForbidden(env, problems);
  checkUrls(env, target === 'dev' ? 'dev-jin.imajin.ai' : 'jin.imajin.ai', problems);
  checkTargetSettings(env, target, problems);
  checkIdentityAndSecrets(env, target, problems);
  if (env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) {
    warnings.push("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is ignored; the seller's key comes from the kernel. Delete it from the env file.");
  }
  if (!keystoreExists(env.IMAJIN_APP_KEYSTORE || '')) {
    warnings.push("No keystore found — claim at /events/claim after boot with the one-time code from the operator's /jin approval card (docs/REGISTRATION.md).");
  }
  return problems;
}

export function checkFile(target, file, warnings = []) {
  const env = parseEnv(readFileSync(file, 'utf8'));
  const problems = validateEnvironment(env, target, existsSync, warnings);
  if ((statSync(file).mode & 0o777) !== 0o600) problems.push('.env.local: chmod 600 required');
  if (existsSync(env.IMAJIN_APP_KEYSTORE || '')) {
    const keystore = statSync(env.IMAJIN_APP_KEYSTORE);
    if (!keystore.isFile() || (keystore.mode & 0o777) !== 0o600) {
      problems.push('IMAJIN_APP_KEYSTORE: requires a regular file with mode 0600');
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [target, file = '.env.local', extra] = process.argv.slice(2);
    if (extra) throw new Error('usage');
    const warnings = [];
    const problems = checkFile(target, file, warnings);
    for (const warning of warnings) console.warn(`warning: ${warning}`);
    for (const problem of problems) console.error(problem);
    process.exitCode = problems.length > 0 ? 1 : 0;
    if (problems.length === 0) console.log('Environment validated (values withheld).');
  } catch {
    console.error('Cannot validate environment. Usage: node scripts/check-env.mjs <dev|prod> [file]; check file permissions and format.');
    process.exitCode = 2;
  }
}
