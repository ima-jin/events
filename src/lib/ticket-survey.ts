import { eq } from 'drizzle-orm';
import { db, tickets, ticketTypes } from '@/db';
import { getSurveyResponse, type SurveyResponse } from '@/lib/surveys';

/**
 * The survey response a ticket submitted, via dykil's public API.
 * The form id is the ticket type's `registration_form_id`.
 */
export async function getSurveyResponseForTicket(ticketId: string): Promise<SurveyResponse | null> {
  const [row] = await db
    .select({ formId: ticketTypes.registrationFormId })
    .from(tickets)
    .innerJoin(ticketTypes, eq(tickets.ticketTypeId, ticketTypes.id))
    .where(eq(tickets.id, ticketId))
    .limit(1);

  return getSurveyResponse(row?.formId, ticketId);
}
