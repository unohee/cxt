import { describe, expect, it } from 'vitest';
import { parseRetentionDays } from '../../src/cli/projectHandler.js';

describe('parseRetentionDays', () => {
  it('escapes terminal controls in invalid-value errors', () => {
    expect(() => parseRetentionDays('7\u001b]8;;https://evil.invalid\u0007'))
      .toThrow('Retention days must be a non-negative integer: 7]8;;https://evil.invalid�');
  });
});
