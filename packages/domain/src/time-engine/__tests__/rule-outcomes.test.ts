import { DEFAULT_MAX_HOURS_RULE, DEFAULT_REST_RULE, DEFAULT_SURCHARGE_RULE } from '@cueq/policy';
import { describe, expect, it } from 'vitest';
import type { DomainWarning, RuleViolation } from '../../types.js';
import {
  addDailyMaxHoursOutcome,
  addRestViolations,
  addWeeklyMaxHoursViolation,
  buildSurchargeMinutes,
} from '../rule-outcomes.js';

describe('rule outcomes', () => {
  it('merges same-day intervals and reports a rest deficit to the next day', () => {
    const violations: RuleViolation[] = [];
    addRestViolations(
      [
        { start: '2026-03-03T07:00:00.000Z', end: '2026-03-03T16:00:00.000Z', type: 'WORK' },
        { start: '2026-03-03T08:00:00.000Z', end: '2026-03-03T10:00:00.000Z', type: 'WORK' },
        { start: '2026-03-03T17:00:00.000Z', end: '2026-03-03T20:00:00.000Z', type: 'WORK' },
        { start: '2026-03-04T05:00:00.000Z', end: '2026-03-04T10:00:00.000Z', type: 'WORK' },
      ],
      DEFAULT_REST_RULE,
      violations,
      'Europe/Berlin',
    );

    expect(violations.map((violation) => violation.code)).toEqual(['REST_HOURS_DEFICIT']);
  });

  it('classifies daily hours as ok, warning or violation', () => {
    const warnings: DomainWarning[] = [];
    const violations: RuleViolation[] = [];
    addDailyMaxHoursOutcome('2026-03-03', 8, DEFAULT_MAX_HOURS_RULE, warnings, violations);
    expect([warnings.length, violations.length]).toEqual([0, 0]);
    addDailyMaxHoursOutcome('2026-03-03', 9, DEFAULT_MAX_HOURS_RULE, warnings, violations);
    expect([warnings.length, violations.length]).toEqual([1, 0]);
    addDailyMaxHoursOutcome('2026-03-03', 11, DEFAULT_MAX_HOURS_RULE, warnings, violations);
    expect([warnings.length, violations.length]).toEqual([1, 1]);
  });

  it('reports a weekly maximum violation only above the limit', () => {
    const violations: RuleViolation[] = [];
    addWeeklyMaxHoursViolation(48, DEFAULT_MAX_HOURS_RULE, violations);
    expect(violations).toHaveLength(0);
    addWeeklyMaxHoursViolation(48.5, DEFAULT_MAX_HOURS_RULE, violations);
    expect(violations.map((violation) => violation.code)).toEqual(['MAX_WEEKLY_HOURS_EXCEEDED']);
  });

  it('orders surcharge minutes by descending priority', () => {
    const config = new Map(
      DEFAULT_SURCHARGE_RULE.categories.map((entry) => [entry.category, entry]),
    );
    const result = buildSurchargeMinutes(
      new Map([
        ['NIGHT', 30],
        ['HOLIDAY', 60],
      ]),
      config,
    );
    expect(result.map((line) => [line.category, line.ratePercent])).toEqual([
      ['HOLIDAY', 100],
      ['NIGHT', 25],
    ]);
  });
});
