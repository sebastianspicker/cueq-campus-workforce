import { describe, expect, it } from 'vitest';
import { DEFAULT_SURCHARGE_RULE, SurchargeRuleSchema } from './index.js';

describe('SurchargeRuleSchema night window', () => {
  it('accepts the default rule', () => {
    expect(SurchargeRuleSchema.safeParse(DEFAULT_SURCHARGE_RULE).success).toBe(true);
  });

  it.each(['24:00', '12:60'])('rejects out-of-range local time %s', (startLocalTime) => {
    const result = SurchargeRuleSchema.safeParse({
      ...DEFAULT_SURCHARGE_RULE,
      nightWindow: { ...DEFAULT_SURCHARGE_RULE.nightWindow, startLocalTime },
    });
    expect(result.success).toBe(false);
  });
});
