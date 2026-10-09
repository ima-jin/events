import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@ima-jin/logger';
import { eq, and } from 'drizzle-orm';

const log = createLogger('events');
import { db, tickets, ticketTypes } from '@/db';
import { getSurveyForm, getSurveyResponse } from '@/lib/surveys';
import { authenticateActing, forbidUnlessOrganizer, type TicketParams } from '@/lib/route-helpers';

export async function GET(
  request: NextRequest,
  { params }: TicketParams
) {
  const auth = await authenticateActing(request);
  if (auth instanceof NextResponse) return auth;
  const { did } = auth;
  const { id: eventId, ticketId } = await params;

  try {
    const forbidden = await forbidUnlessOrganizer(eventId, did, request, 'Forbidden');
    if (forbidden) return forbidden;

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, ticketId), eq(tickets.eventId, eventId)))
      .limit(1);
    if (!ticket) {
      return NextResponse.json({ error: 'Ticket not found' }, { status: 404 });
    }

    const [ticketType] = await db
      .select({ formId: ticketTypes.registrationFormId })
      .from(ticketTypes)
      .where(eq(ticketTypes.id, ticket.ticketTypeId))
      .limit(1);
    const formId = ticketType?.formId ?? null;

    // Survey data comes from dykil's public API (never its tables).
    const response = await getSurveyResponse(formId, ticketId);

    if (!response) {
      return NextResponse.json({ registration: null, questions: [] });
    }

    const registration = {
      id: response.id,
      ticketId,
      formId: response.surveyId,
      responseId: response.id,
      name: response.answers.full_name || response.answers.name || null,
      email: response.answers.email || null,
    };

    let questions: Array<{ question: string; answer: unknown }> = [];

    // fields can be { elements: [...] } or directly an array
    const form = formId ? await getSurveyForm(formId) : null;
    const rawFields = (form?.fields ?? {}) as { elements?: Array<{ name: string; title?: string }> };
    let fields: Array<{ name: string; title?: string }>;
    if (Array.isArray(rawFields)) {
      fields = rawFields;
    } else if (Array.isArray(rawFields.elements)) {
      fields = rawFields.elements;
    } else {
      fields = [];
    }
    const answers: Record<string, unknown> = response.answers || {};

    questions = fields
      .filter((f) => f.name in answers)
      .map((f) => ({
        question: f.title || f.name,
        answer: answers[f.name],
      }));

    return NextResponse.json({ registration, questions });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch registration');
    return NextResponse.json({ error: 'Failed to fetch registration' }, { status: 500 });
  }
}
