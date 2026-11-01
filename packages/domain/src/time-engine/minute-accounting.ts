/** Accounts for work, pause, and surcharge minutes without introducing I/O or mutable state. */
import type { SurchargeCategory, SurchargeRule } from '@cueq/policy';
import { isWithinWindow, localMinuteInfo, selectSurchargeCategory } from './surcharge.js';
import type { TimeRuleInterval } from './types.js';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export type DailyTotals = { workMinutes: number; pauseMinutes: number };
type SurchargeCategoryConfig = SurchargeRule['categories'][number];
export type CategoryConfigByCategory = Map<SurchargeCategory, SurchargeCategoryConfig>;

function surchargeCategoryForMinute(
  localMinute: ReturnType<typeof localMinuteInfo>,
  holidayDates: Set<string>,
  nightStart: number | null,
  nightEnd: number | null,
  categoryConfigByCategory: CategoryConfigByCategory,
): SurchargeCategory | null {
  const matches: SurchargeCategory[] = [];
  if (holidayDates.has(localMinute.isoDate)) matches.push('HOLIDAY');
  if (localMinute.weekday === 0 || localMinute.weekday === 6) matches.push('WEEKEND');
  if (
    nightStart !== null &&
    nightEnd !== null &&
    isWithinWindow(localMinute.localMinuteOfDay, nightStart, nightEnd)
  ) {
    matches.push('NIGHT');
  }
  return selectSurchargeCategory(matches, categoryConfigByCategory);
}

/** Local wall-clock minus UTC, in ms, for the minute containing `timestamp`. */
function utcOffsetMs(timestamp: number, formatter: Intl.DateTimeFormat): number {
  const local = localMinuteInfo(timestamp, formatter);
  return (
    Date.parse(`${local.isoDate}T00:00:00Z`) +
    local.localMinuteOfDay * MINUTE_MS -
    Math.floor(timestamp / MINUTE_MS) * MINUTE_MS
  );
}

/**
 * Projects every started minute through the formatter's time zone. Intl is called twice per UTC
 * hour: when the offset is equal at both ends of the hour it holds for the whole hour, so the
 * local minute is plain arithmetic; an hour containing a transition falls back to Intl per minute.
 */
function forEachStartedMinute(
  intervals: TimeRuleInterval[],
  formatter: Intl.DateTimeFormat,
  visit: (localMinute: ReturnType<typeof localMinuteInfo>) => void,
): void {
  let cachedHour = Number.NaN;
  let cachedOffset: number | null = null;
  for (const interval of intervals) {
    const endMs = new Date(interval.end).getTime();
    for (let cursor = new Date(interval.start).getTime(); cursor < endMs; cursor += MINUTE_MS) {
      const hour = Math.floor(cursor / HOUR_MS);
      if (hour !== cachedHour) {
        cachedHour = hour;
        const first = utcOffsetMs(hour * HOUR_MS, formatter);
        const last = utcOffsetMs(hour * HOUR_MS + HOUR_MS - MINUTE_MS, formatter);
        cachedOffset = first === last ? first : null;
      }
      if (cachedOffset === null) {
        visit(localMinuteInfo(cursor, formatter));
        continue;
      }
      const local = new Date(Math.floor(cursor / MINUTE_MS) * MINUTE_MS + cachedOffset);
      visit({
        isoDate: local.toISOString().slice(0, 10),
        weekday: local.getUTCDay(),
        localMinuteOfDay: local.getUTCHours() * 60 + local.getUTCMinutes(),
      });
    }
  }
}

/** Record each started work minute once and assign at most one surcharge category. */
export function recordWorkMinutes(
  intervals: TimeRuleInterval[],
  formatter: Intl.DateTimeFormat,
  daily: Map<string, DailyTotals>,
  holidayDates: Set<string>,
  nightStart: number | null,
  nightEnd: number | null,
  categoryConfigByCategory: CategoryConfigByCategory,
  surchargeBuckets: Map<SurchargeCategory, number>,
): number {
  let totalWorkMinutes = 0;
  forEachStartedMinute(intervals, formatter, (localMinute) => {
    const day = daily.get(localMinute.isoDate) ?? { workMinutes: 0, pauseMinutes: 0 };
    day.workMinutes += 1;
    totalWorkMinutes += 1;
    const category = surchargeCategoryForMinute(
      localMinute,
      holidayDates,
      nightStart,
      nightEnd,
      categoryConfigByCategory,
    );
    if (category) surchargeBuckets.set(category, (surchargeBuckets.get(category) ?? 0) + 1);
    daily.set(localMinute.isoDate, day);
  });
  return totalWorkMinutes;
}

/** Add pause minutes to per-local-day totals using the same timezone projection as work. */
export function recordPauseMinutes(
  intervals: TimeRuleInterval[],
  formatter: Intl.DateTimeFormat,
  daily: Map<string, DailyTotals>,
): void {
  forEachStartedMinute(intervals, formatter, (localMinute) => {
    const day = daily.get(localMinute.isoDate) ?? { workMinutes: 0, pauseMinutes: 0 };
    day.pauseMinutes += 1;
    daily.set(localMinute.isoDate, day);
  });
}
