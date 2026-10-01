import { defineConfig } from 'vitest/config';

/** The agent load test is slow and noisy, so it only runs when asked for (pnpm test:load). */
const load = process.env.LC_LOAD_TEST === '1';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/**/*.test.ts', 'modules/**/*.test.ts', 'apps/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/*.load.test.ts', '**/node_modules/**'],
          environment: 'node',
          setupFiles: ['./test/setup-env.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['packages/**/*.int.test.ts', 'modules/**/*.int.test.ts', 'apps/**/*.int.test.ts', 'test/**/*.int.test.ts'],
          exclude: ['**/node_modules/**'],
          environment: 'node',
          globalSetup: ['./test/global-setup.ts'],
          setupFiles: ['./test/setup-env.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      ...(load
        ? [
            {
              test: {
                name: 'load',
                include: ['test/load/**/*.load.test.ts'],
                environment: 'node',
                globalSetup: ['./test/global-setup.ts'],
                setupFiles: ['./test/setup-env.ts'],
                fileParallelism: false,
                testTimeout: 600_000,
                hookTimeout: 120_000,
              },
            },
          ]
        : []),
    ],
  },
});
