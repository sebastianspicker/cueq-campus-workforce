import { describe, expect, it } from 'vitest';
import { isDevelopmentOrTest } from './runtime-environment.js';

describe('isDevelopmentOrTest', () => {
  it.each([
    [undefined, false],
    ['', false],
    ['production', false],
    ['prod', false],
    ['staging', false],
    ['development', true],
    [' Development ', true],
    ['TEST', true],
  ])('classifies NODE_ENV=%j as %s', (nodeEnv, expected) => {
    expect(isDevelopmentOrTest({ NODE_ENV: nodeEnv } as NodeJS.ProcessEnv)).toBe(expected);
  });
});
