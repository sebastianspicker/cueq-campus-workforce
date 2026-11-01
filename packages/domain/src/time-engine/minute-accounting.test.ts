import { describe, expect, it } from 'vitest';
import { recordWorkMinutes, type DailyTotals } from './minute-accounting.js';

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Berlin',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// NIGHT outranks WEEKEND here so the local 02:00-03:00 window is visible on a Sunday.
const categories = new Map([
  ['NIGHT', { category: 'NIGHT', ratePercent: 25, priority: 2 }],
  ['WEEKEND', { category: 'WEEKEND', ratePercent: 50, priority: 1 }],
] as const);

function account(start: string, end: string) {
  const daily = new Map<string, DailyTotals>();
  const buckets = new Map();
  const total = recordWorkMinutes(
    [{ start, end, type: 'WORK' }],
    formatter,
    daily,
    new Set(),
    120,
    180,
    categories,
    buckets,
  );
  return {
    total,
    days: Object.fromEntries([...daily].map(([day, totals]) => [day, totals.workMinutes])),
    night: buckets.get('NIGHT') ?? 0,
  };
}

describe('minute accounting across Europe/Berlin DST transitions', () => {
  it('skips the missing local hour on 2026-03-29', () => {
    expect(account('2026-03-28T22:00:00.000Z', '2026-03-29T04:00:00.000Z')).toEqual({
      total: 360,
      days: { '2026-03-28': 60, '2026-03-29': 300 },
      night: 0,
    });
  });

  it('counts the repeated local hour twice on 2026-10-25', () => {
    expect(account('2026-10-24T22:00:00.000Z', '2026-10-25T04:00:00.000Z')).toEqual({
      total: 360,
      days: { '2026-10-25': 360 },
      night: 120,
    });
  });
});
