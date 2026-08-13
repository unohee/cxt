import { describe, expect, it } from 'vitest';
import { isBsScanPassing } from '../../src/cli/checkHandler.js';

describe('check CI policy', () => {
  it('fails closed on critical findings or incomplete BS scans', () => {
    expect(isBsScanPassing({ critical: 0, errors: [] })).toBe(true);
    expect(isBsScanPassing({ critical: 1, errors: [] })).toBe(false);
    expect(isBsScanPassing({ critical: 0, errors: ['unreadable source'] })).toBe(false);
  });
});
