/** Applies effective leave rules to annual entitlement and carry-over limits. */
import type { LeaveRule } from '@cueq/policy';
import { roundToTwo } from '../numerical/precision.js';
import type { LeaveLedgerInput } from './leave-ledger.types.js';
import { coveredMonthFactor } from './leave-date.js';

/** Scale annual entitlement by work-time fraction and rule-controlled entry/exit prorating. */
export function calculateEntitlementDays(input: LeaveLedgerInput, rule: LeaveRule): number {
  const fullTimeWeeklyHours = Number(rule.fullTimeWeeklyHours ?? 39.83);
  const employmentFraction = Math.max(input.workTimeModelWeeklyHours / fullTimeWeeklyHours, 0);
  // Each flag controls only its own clamp; no overlap with the year still means no entitlement.
  if (coveredMonthFactor(input.year, input.employmentStartDate, input.employmentEndDate) === 0) {
    return 0;
  }
  const monthFactor = coveredMonthFactor(
    input.year,
    rule.proRataOnEntry ? input.employmentStartDate : undefined,
    rule.proRataOnExit ? input.employmentEndDate : undefined,
  );
  return roundToTwo(rule.annualEntitlementDays * employmentFraction * monthFactor);
}

/** Clamp prior-year carry-over to non-negative input and the active policy maximum. */
export function cappedCarryOverDays(input: LeaveLedgerInput, rule: LeaveRule): number {
  if (!rule.carryOver.enabled) return 0;
  return roundToTwo(
    Math.min(Math.max(input.priorYearCarryOverDays ?? 0, 0), rule.carryOver.maxDays),
  );
}
