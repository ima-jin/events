import { serviceUrl } from '@/lib/kernel';
import { listAdminEventRows, type AdminEventRow, type NumericLike } from '@/repositories/sales-repository';
import { buildCsvFile, CSV_MIME, type CsvFile } from '@/services/sales-service';

const HEADERS = [
  'Event ID',
  'Title',
  'Status',
  'Starts At',
  'Ends At',
  'City',
  'Creator DID',
  'Creator Handle',
  'Total Ticket Types',
  'Tickets Sold',
  'Tickets Used',
  'Total Revenue',
  'Currency',
  'Has Registration Form',
  'Surveys Completed Count',
];

interface LookupBody {
  handle?: string | null;
  identity?: { handle?: string | null };
}

/** A creator's handle via the kernel auth service's public lookup route; any failure is non-fatal (null). */
async function resolveHandle(authBase: string, did: string): Promise<string | null> {
  try {
    const res = await fetch(`${authBase}/api/lookup/${encodeURIComponent(did)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as LookupBody;
    return (data.identity ?? data).handle || null;
  } catch {
    return null;
  }
}

function isoOrBlank(date: AdminEventRow['starts_at']): string {
  return date ? new Date(date).toISOString() : '';
}

function adminRow(row: AdminEventRow, handle: string): (string | NumericLike)[] {
  return [
    row.id,
    row.title,
    row.status,
    isoOrBlank(row.starts_at),
    isoOrBlank(row.ends_at),
    row.city || '',
    row.creator_did || '',
    handle,
    row.ticket_type_count,
    row.tickets_sold,
    row.tickets_used,
    row.total_revenue,
    row.currency || '',
    row.has_registration_form ? 'true' : 'false',
    row.surveys_completed,
  ];
}

/**
 * Overview of every event as CSV, with creator handles resolved through the
 * kernel. The caller (route) is responsible for requiring a platform admin.
 */
export async function buildAdminEventsCsv(): Promise<CsvFile> {
  const rows = await listAdminEventRows();
  const authBase = serviceUrl('auth') ?? '';
  const creatorDids = [...new Set(rows.map((r) => r.creator_did).filter((did): did is string => Boolean(did)))];
  const handles = await Promise.all(creatorDids.map((did) => resolveHandle(authBase, did)));
  const handleByDid = new Map(creatorDids.map((did, i) => [did, handles[i]]));

  const lines = rows.map((row) => adminRow(row, row.creator_did ? (handleByDid.get(row.creator_did) ?? '') : ''));
  return buildCsvFile(`imajin-events-${new Date().toISOString().split('T')[0]}.csv`, CSV_MIME, HEADERS, lines);
}
