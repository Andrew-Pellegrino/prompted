// Week labels ("April 27–May 3, 2026") <-> ISO dates, slugs, and the Monday send schedule.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const iso = (y, m, d) => `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const addDays = (isoDate, n) => {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Parse "April 6–12, 2026" / "April 27–May 3, 2026" / "December 28, 2026–January 3, 2027". */
export function parseWeekLabel(label) {
  const s = label.trim().replace(/\s*[-–—]\s*/g, '–');
  const m = /^([A-Za-z]+) (\d{1,2})(?:, (\d{4}))?–(?:([A-Za-z]+) )?(\d{1,2}), (\d{4})$/.exec(s);
  if (!m) throw new Error(`Unrecognised week label: "${label}"`);
  const [, m1, d1, y1, m2, d2, y2] = m;
  const mi1 = MONTHS.indexOf(m1), mi2 = MONTHS.indexOf(m2 || m1);
  if (mi1 < 0 || mi2 < 0) throw new Error(`Unrecognised month in week label: "${label}"`);
  const endY = Number(y2);
  const startY = y1 ? Number(y1) : mi1 > mi2 ? endY - 1 : endY;
  const start = iso(startY, mi1, Number(d1)), end = iso(endY, mi2, Number(d2));
  const span = (new Date(end) - new Date(start)) / 864e5;
  if (span < 5 || span > 8) throw new Error(`Week label "${label}" spans ${span} days`);
  // Issues go out the Monday after the week closes (week ends Sunday).
  const endDow = new Date(end + 'T00:00:00Z').getUTCDay();
  const nominal = addDays(end, endDow === 0 ? 1 : (8 - endDow) % 7 || 7);
  return { label: formatWeekLabel(start, end), start, end, nominal_send_date: nominal };
}

export function formatWeekLabel(start, end) {
  const a = new Date(start + 'T00:00:00Z'), b = new Date(end + 'T00:00:00Z');
  const ma = MONTHS[a.getUTCMonth()], mb = MONTHS[b.getUTCMonth()];
  if (a.getUTCFullYear() !== b.getUTCFullYear()) return `${ma} ${a.getUTCDate()}, ${a.getUTCFullYear()}–${mb} ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
  return ma === mb ? `${ma} ${a.getUTCDate()}–${b.getUTCDate()}, ${b.getUTCFullYear()}` : `${ma} ${a.getUTCDate()}–${mb} ${b.getUTCDate()}, ${b.getUTCFullYear()}`;
}

/** Header form used in the masthead: "Week of November 1–8" (no year), per the production spec. */
export const mastheadWeek = (week) => 'Week of ' + week.label.replace(/, \d{4}(?=–|$)/g, '');

export const slugForWeek = (week) =>
  'week-of-' + week.label.toLowerCase().replace(/[–,]/g, ' ').trim().replace(/\s+/g, '-');

/** Offset (minutes) of America/New_York from UTC at a given instant, via Intl (DST-correct). */
function nyOffsetMinutes(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** UTC instant for a wall-clock time in America/New_York. */
export function nyWallTimeToUtc(isoDate, hour, minute) {
  const guess = new Date(`${isoDate}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const first = new Date(guess.getTime() - nyOffsetMinutes(guess) * 60000);
  return new Date(guess.getTime() - nyOffsetMinutes(first) * 60000);
}

/** The standing send slot: Monday 8:45 a.m. America/New_York. */
export const SEND_SLOT = { weekday: 1, hour: 8, minute: 45, timeZone: 'America/New_York' };

/** Send instant for an issue: the Monday after its week ends, 8:45 a.m. Eastern. */
export function scheduledSendFor(week) {
  const at = nyWallTimeToUtc(week.nominal_send_date, SEND_SLOT.hour, SEND_SLOT.minute);
  return { local: `${week.nominal_send_date}T08:45`, timeZone: SEND_SLOT.timeZone, utc: at.toISOString() };
}

/** Next Monday 8:45 a.m. Eastern strictly after `now`. */
export function nextSendSlot(now = new Date()) {
  const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  for (let i = 0; i < 8; i++) {
    const day = addDays(nyDate, i);
    if (new Date(day + 'T00:00:00Z').getUTCDay() !== 1) continue;
    const at = nyWallTimeToUtc(day, SEND_SLOT.hour, SEND_SLOT.minute);
    if (at > now) return { local: `${day}T08:45`, timeZone: SEND_SLOT.timeZone, utc: at.toISOString() };
  }
  throw new Error('unreachable');
}
