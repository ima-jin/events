import { createLogger } from '@ima-jin/logger';

/**
 * Survey reads via dykil's PUBLIC HTTP API (ima-jin/dykil `api-spec/openapi.yaml`).
 *
 * The kernel version of this app joined `dykil.survey_responses` / `dykil.surveys`
 * directly. Dykil now owns no tables (surveys are signed documents, responses
 * are attestations), so the events app asks dykil instead:
 *
 *   GET {DYKIL_URL}/api/surveys/{formId}/responses/check?ticketId={ticketId}&include=answers
 *   GET {DYKIL_URL}/api/surveys/{formId}
 *
 * A survey form is identified by the ticket type's `registration_form_id`.
 * All helpers are non-throwing; a missing `DYKIL_URL` or an unreachable dykil
 * yields "no response" so guest lists / exports still render (just without
 * survey columns), as the kernel code did when no response row existed.
 */

const log = createLogger('events');

/** Max concurrent dykil lookups when resolving many tickets at once. */
const LOOKUP_CONCURRENCY = 8;

export interface SurveyAnswers {
  email?: string;
  full_name?: string;
  name?: string;
  [key: string]: unknown;
}

export interface SurveyResponse {
  id: string;
  surveyId: string;
  answers: SurveyAnswers;
}

export interface SurveyForm {
  id: string;
  fields: unknown;
}

export interface TicketFormRef {
  ticketId: string;
  formId: string | null;
}

function dykilBaseUrl(): string | null {
  const url = process.env.DYKIL_URL;
  if (!url) return null;
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end -= 1;
  return url.slice(0, end);
}

/** The survey response a ticket submitted for `formId`, or null when none / unavailable. */
export async function getSurveyResponse(
  formId: string | null | undefined,
  ticketId: string
): Promise<SurveyResponse | null> {
  const base = dykilBaseUrl();
  if (!base || !formId) return null;

  try {
    const url = `${base}/api/surveys/${encodeURIComponent(formId)}/responses/check?ticketId=${encodeURIComponent(ticketId)}&include=answers`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { completed?: boolean; responseId?: string; answers?: SurveyAnswers | null };
    if (!data.completed || !data.responseId) return null;
    return { id: data.responseId, surveyId: formId, answers: data.answers ?? {} };
  } catch (err) {
    log.warn({ ticketId, formId, err: String(err) }, 'Survey response lookup failed');
    return null;
  }
}

/** Survey responses for many tickets (bounded concurrency). Keyed by ticket id. */
export async function getSurveyResponsesForTickets(
  refs: TicketFormRef[]
): Promise<Map<string, SurveyResponse>> {
  const result = new Map<string, SurveyResponse>();
  const queue = refs.filter((r): r is { ticketId: string; formId: string } => Boolean(r.formId));

  /** Drain the shared queue one lookup at a time; `LOOKUP_CONCURRENCY` drains run side by side. */
  async function worker(): Promise<void> {
    const next = queue.shift();
    if (!next) return;
    const response = await getSurveyResponse(next.formId, next.ticketId);
    if (response) result.set(next.ticketId, response);
    return worker();
  }

  await Promise.all(Array.from({ length: Math.min(LOOKUP_CONCURRENCY, queue.length) }, worker));
  return result;
}

/** A survey form definition (title/fields), or null when unreadable. */
export async function getSurveyForm(formId: string): Promise<SurveyForm | null> {
  const base = dykilBaseUrl();
  if (!base) return null;

  try {
    const res = await fetch(`${base}/api/surveys/${encodeURIComponent(formId)}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = (await res.json()) as { fields?: unknown };
    return { id: formId, fields: data.fields ?? [] };
  } catch (err) {
    log.warn({ formId, err: String(err) }, 'Survey form lookup failed');
    return null;
  }
}

/** Survey form definitions keyed by form id. */
export async function getSurveyForms(formIds: string[]): Promise<Map<string, SurveyForm>> {
  const forms = await Promise.all(Array.from(new Set(formIds)).map((id) => getSurveyForm(id)));
  const result = new Map<string, SurveyForm>();
  for (const form of forms) {
    if (form) result.set(form.id, form);
  }
  return result;
}
