import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: [
        'src/registry/entityScanner.ts',
        'src/registry/bsDetector.ts',
        'src/registry/sqliteStore.ts',
        'src/registry/ignoreRules.ts',
        'src/cli/exportHandler.ts',
        'src/cli/initHandler.ts',
      ],
      exclude: ['src/cli.ts', 'src/i18n.ts', 'src/cli/checkHandler.ts'],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 60,
      },
    },
  },
});
