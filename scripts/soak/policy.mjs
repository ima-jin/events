import { createHmac, randomBytes } from 'node:crypto';
import { refuse } from './refusal.mjs';

export const SCRUB_VERSION = 2;
export const POLICY = {
  events: {
    id: 'scrub:id', did: 'scrub:did', public_key: 'regenerate', private_key: 'regenerate',
    creator_did: 'scrub:did', title: 'scrub:public', description: 'scrub:public',
    starts_at: 'keep', ends_at: 'keep', timezone: 'keep', location_type: 'keep',
    is_virtual: 'keep', virtual_url: 'scrub:url', venue: 'scrub:public', address: 'scrub:public',
    city: 'scrub:public', country: 'scrub:public', status: 'keep', event_type: 'keep',
    target_amount: 'keep', deadline: 'keep', access_mode: 'keep', image_url: 'scrub:url',
    image_asset_id: 'scrub:id', tags: 'scrub:public-json', metadata: 'scrub:json',
    registration_config: 'scrub:config', name_display_policy: 'keep', chat_enabled: 'keep',
    course_slug: 'scrub:id', currency: 'keep', emt_email: 'scrub:email',
    pod_id: 'scrub:id', lobby_conversation_id: 'scrub:id', created_at: 'keep', updated_at: 'keep',
  },
  ticket_types: {
    id: 'scrub:id', event_id: 'scrub:id', name: 'scrub:public', description: 'scrub:public',
    price: 'keep', currency: 'keep', quantity: 'keep', sold: 'keep', perks: 'scrub:public-json',
    metadata: 'scrub:json', sort_order: 'keep', requires_registration: 'keep',
    registration_form_id: 'scrub:id', max_per_order: 'keep', access_code: 'scrub:id', created_at: 'keep',
  },
  orders: {
    id: 'scrub:id', event_id: 'scrub:id', buyer_did: 'scrub:did', ticket_type_id: 'scrub:id',
    quantity: 'keep', amount_total: 'keep', currency: 'keep', payment_method: 'keep',
    stripe_session_id: 'scrub:id', payment_id: 'scrub:id', status: 'keep',
    fair_settlement: 'scrub:json', purchased_at: 'keep', metadata: 'scrub:json',
    buyer_email: 'scrub:email', created_at: 'keep',
  },
  tickets: {
    id: 'scrub:id', event_id: 'scrub:id', ticket_type_id: 'scrub:id', owner_did: 'scrub:did',
    order_id: 'scrub:id', original_owner_did: 'scrub:did', purchased_at: 'keep',
    price_paid: 'keep', currency: 'keep', payment_id: 'scrub:id', status: 'keep',
    held_by: 'scrub:did', held_until: 'keep', used_at: 'keep', signature: 'scrub:signature',
    payment_method: 'keep', hold_expires_at: 'keep', payment_confirmed_at: 'keep',
    registration_status: 'keep', last_email_sent_at: 'keep', metadata: 'scrub:json', created_at: 'keep',
  },
  ticket_transfers: {
    id: 'scrub:id', ticket_id: 'scrub:id', from_did: 'scrub:did', to_did: 'scrub:did',
    transferred_at: 'keep', signature: 'scrub:signature',
  },
  ticket_queue: {
    id: 'scrub:id', ticket_type_id: 'scrub:id', did: 'scrub:did', position: 'keep',
    joined_at: 'keep', notified_at: 'keep', expires_at: 'keep', status: 'keep',
  },
  event_invites: {
    id: 'scrub:id', event_id: 'scrub:id', token: 'scrub:id', label: 'scrub:text',
    max_uses: 'keep', used_count: 'keep', expires_at: 'keep', created_at: 'keep',
  },
  pledges: {
    id: 'scrub:id', event_id: 'scrub:id', backer_did: 'scrub:did', amount: 'keep',
    currency: 'keep', stripe_setup_intent_id: 'scrub:id', stripe_payment_method_id: 'scrub:id',
    stripe_customer_id: 'scrub:id', mjnx_escrow_id: 'scrub:id', status: 'keep',
    charged_at: 'keep', failure_reason: 'scrub:text', metadata: 'scrub:json', created_at: 'keep',
  },
};

// Parents before children; reverse order is used for restore/truncate documentation.
export const TABLES = Object.keys(POLICY);
const timezones = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);
const enumShape = (value) => /^[a-z_]{1,32}$/.test(value);
const currencyShape = (value) => /^[A-Z]{3}$/.test(value);
// Keep app enum validation where defined; other unconstrained enum-like text
// is bounded by shape so legacy operational states are not silently rewritten.
const keepChecks = {
  timezone: (value) => timezones.has(value),
  currency: currencyShape,
  location_type: enumShape,
  status: enumShape,
  event_type: enumShape,
  name_display_policy: (value) => ['real_name', 'handle', 'anonymous', 'attendee_choice'].includes(value),
  payment_method: enumShape,
  registration_status: enumShape,
  access_mode: (value) => ['public', 'invite_only'].includes(value),
};

function checkedKeep(table, column, value) {
  const check = keepChecks[column];
  refuse(check && (typeof value !== 'string' || value.trim() !== value || !check(value)),
    `Unexpected keep value: ${table}.${column}.`);
  return value;
}

export function isPublicEvent(row) {
  return row.access_mode === 'public' && ['published', 'completed'].includes(row.status);
}

function neutralText(value) {
  // Buckets preserve rough size without disclosing exact lengths.
  if (value.length === 0) return '';
  return 'x'.repeat(Math.max(8, Math.ceil(value.length / 8) * 8));
}

/** No original JSON keys survive: free-form keys can themselves contain PII. */
function neutralJson(value) {
  if (value === null) return null;
  if (typeof value === 'string') return neutralText(value);
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  if (Array.isArray(value)) return value.map(neutralJson);
  return Object.fromEntries(Object.values(value).map((entry, index) => [`field_${index}`, neutralJson(entry)]));
}

function scrubConfig(value) {
  const result = {};
  if (typeof value.enforce_unique_emails === 'boolean') {
    result.enforce_unique_emails = value.enforce_unique_emails;
  }
  if (typeof value.registration_deadline === 'string'
      && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(value.registration_deadline)) {
    result.registration_deadline = value.registration_deadline;
  }
  return result;
}

export function createScrubber(didMap = {}) {
  const salt = randomBytes(32); // Per-export, memory-only; never persisted or returned.
  const digest = (value) => createHmac('sha256', salt).update(String(value)).digest('hex');
  const rules = {
    'scrub:did': (value) => Object.hasOwn(didMap, value) ? didMap[value] : `did:imajin:scrubbed-${digest(value)}`,
    'scrub:email': (value) => `scrubbed+${digest(value.trim().toLowerCase())}@example.invalid`,
    'scrub:id': (value) => `scrubbed_${digest(value)}`,
    'scrub:text': neutralText,
    'scrub:signature': neutralText,
    'scrub:url': () => 'https://example.invalid/scrubbed',
    'scrub:json': neutralJson,
    'scrub:config': scrubConfig,
    'scrub:public': (value, visible) => visible ? value : neutralText(value),
    'scrub:public-json': (value, visible) => visible ? value : neutralJson(value),
  };
  return (table, row, visible = false) => {
    if (!POLICY[table]) throw new Error('Unknown table');
    /** @type {Record<string, unknown>} */
    const result = {};
    for (const [column, rule] of Object.entries(POLICY[table])) {
      if (rule === 'regenerate') continue; // Key material never enters the artifact.
      const value = row[column];
      if (value === undefined) throw new Error('Missing classified column');
      if (value === null) result[column] = null;
      else if (rule === 'keep') result[column] = checkedKeep(table, column, value);
      else result[column] = rules[rule](value, visible);
    }
    return result;
  };
}
