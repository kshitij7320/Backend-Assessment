import { describe, it, expect } from 'vitest';
import { runFullVerificationSuite } from '../scripts/verify-all';

describe('Shodh a Code — End-to-End Verification Suite (Stages 1-4)', () => {
  it(
    'passes all 5 scenario families across real Docker runner and deterministic fault double',
    async () => {
      const summary = await runFullVerificationSuite();
      expect(summary.all_passed).toBe(true);
      expect(summary.results.length).toBeGreaterThanOrEqual(8);
    },
    120_000,
  );
});
