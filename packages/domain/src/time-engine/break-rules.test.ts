import { DEFAULT_BREAK_RULE } from '@cueq/policy';
import { describe, expect, it } from 'vitest';
import { requiredBreakMinutes } from './break-rules.js';

describe('requiredBreakMinutes (ArbZG §4: "mehr als" 6 / 9 hours)', () => {
  it.each([
    [6, 0],
    [6.01, 30],
    [9, 30],
    [9.01, 45],
  ])('%s h requires %s min', (hours, minutes) => {
    expect(requiredBreakMinutes(hours, DEFAULT_BREAK_RULE)).toBe(minutes);
  });
});
