// Google Calendar (iCal feed) -> rows for public.events.
//
// node-ical's expandRecurringEvent does the heavy lifting: RRULE expansion in
// the event's own time zone (so a 7 PM meeting stays at 7 PM across DST),
// EXDATE (deleted instances) and RECURRENCE-ID overrides (moved/edited ones).
// On top of that we drop cancelled events and private events, since the
// members' view is public.

import ical from 'node-ical';

const DAY_MS = 864e5;

const text = (v) => (v && typeof v === 'object' && 'val' in v ? v.val : v ?? '').toString().trim();
const status = (ev) => text(ev?.status).toUpperCase();
const isHidden = (ev) => ['PRIVATE', 'CONFIDENTIAL'].includes(text(ev?.class).toUpperCase());

// node-ical gives all-day dates as local midnight; keep the calendar date and
// store it as 00:00 UTC so it means the same day for every viewer.
function dateOnlyUtc(d) {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString();
}

export async function fetchIcs(url, { timeoutMs = 30_000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`calendar feed returned HTTP ${res.status}`);
  const body = await res.text();
  if (!body.includes('BEGIN:VCALENDAR')) throw new Error('calendar feed is not an iCal file (check GCAL_ICS_URL)');
  return body;
}

/**
 * @param {string} icsText
 * @param {{from: Date, to: Date}} window  instants; events overlapping it are kept
 * @returns {{rows: object[], skipped: {cancelled: number, private: number}}}
 */
export function calendarRows(icsText, { from, to }) {
  const parsed = ical.sync.parseICS(icsText);
  const rows = new Map();
  const skipped = { cancelled: 0, private: 0 };

  for (const ev of Object.values(parsed)) {
    if (ev?.type !== 'VEVENT' || !ev.start) continue;
    if (status(ev) === 'CANCELLED') { skipped.cancelled++; continue; }

    const instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true });
    for (const inst of instances) {
      const src = inst.event ?? ev;
      if (status(src) === 'CANCELLED') { skipped.cancelled++; continue; }
      if (isHidden(src) || isHidden(ev)) { skipped.private++; continue; }

      let startsAt, endsAt;
      if (inst.isFullDay) {
        startsAt = dateOnlyUtc(inst.start);
        endsAt = inst.end ? dateOnlyUtc(inst.end) : startsAt;
        if (endsAt <= startsAt) endsAt = new Date(Date.parse(startsAt) + DAY_MS).toISOString();
      } else {
        startsAt = inst.start.toISOString();
        endsAt = (inst.end && inst.end > inst.start ? inst.end : inst.start).toISOString();
      }
      if (Date.parse(endsAt) < from.getTime() || Date.parse(startsAt) > to.getTime()) continue;

      const id = `${text(ev.uid) || text(inst.summary)}|${startsAt}`;
      rows.set(id, {
        id,
        title: text(inst.summary) || text(ev.summary) || '(No title)',
        starts_at: startsAt,
        ends_at: endsAt,
        all_day: Boolean(inst.isFullDay),
        location: text(src.location) || text(ev.location) || null,
      });
    }
  }

  const sorted = [...rows.values()].sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.title.localeCompare(b.title));
  return { rows: sorted, skipped };
}
