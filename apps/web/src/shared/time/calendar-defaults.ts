/** Form and filter defaults derived from the current Europe/Berlin calendar date. */
import { localDateTimeInputToIsoInstant } from './datetime-local';

const berlinDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const CALENDAR_PATTERN = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/u;

function calendarParts(value: string): { year: number; month: number; day: number } {
  const match = CALENDAR_PATTERN.exec(value);
  if (!match) {
    throw new RangeError(`${value} is not a YYYY-MM or YYYY-MM-DD value.`);
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3] ?? '1') };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatUtcDate(value: Date): string {
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}

/** Today's calendar date in Europe/Berlin as `YYYY-MM-DD`. */
export function berlinToday(now: Date = new Date()): string {
  const parts = new Map(
    berlinDateFormatter
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}`;
}

/** Shifts a `YYYY-MM-DD` calendar date by whole days. */
export function addCalendarDays(date: string, days: number): string {
  const { year, month, day } = calendarParts(date);
  return formatUtcDate(new Date(Date.UTC(year, month - 1, day + days)));
}

/** The Europe/Berlin month containing `now`, shifted by `offset` months, as `YYYY-MM`. */
export function berlinMonth(now: Date = new Date(), offset = 0): string {
  const { year, month } = calendarParts(berlinToday(now));
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}`;
}

/** First and last calendar date of a `YYYY-MM` month. */
export function monthBounds(month: string): { first: string; last: string } {
  const { year, month: monthNumber } = calendarParts(month);
  return {
    first: `${month}-01`,
    last: formatUtcDate(new Date(Date.UTC(year, monthNumber, 0))),
  };
}

/** ISO instant for a Europe/Berlin wall-clock date and `HH:MM` time. */
export function berlinInstant(date: string, time: string): string {
  const instant = localDateTimeInputToIsoInstant(`${date}T${time}`);
  if (!instant) {
    throw new RangeError(`${date}T${time} does not exist in Europe/Berlin.`);
  }
  return instant;
}
