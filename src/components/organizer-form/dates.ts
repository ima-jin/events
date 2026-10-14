/** Render an instant as the selected zone's wall clock, not the browser's zone. */
export function zonedDateTime(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid date');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`;
}

/** Resolve a wall clock in an IANA zone. Nonexistent DST times fail rather than silently drift. */
export function toInstant(local: string, timezone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local)) throw new Error('Enter a valid date and time');
  const wall = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(wall)) throw new Error('Enter a valid date and time');
  let instant = wall;
  for (let attempt = 0; attempt < 3; attempt++) {
    const represented = Date.parse(`${zonedDateTime(new Date(instant).toISOString(), timezone)}:00Z`);
    instant += wall - represented;
  }
  const iso = new Date(instant).toISOString();
  if (zonedDateTime(iso, timezone) !== local) throw new Error('This date and time does not exist in the selected timezone');
  return iso;
}
