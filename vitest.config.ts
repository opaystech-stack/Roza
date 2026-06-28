import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Property-based tests (fast-check) can run longer than the default.
    // scrypt-heavy AES-256-GCM properties run >=100 iterations with multiple
    // synchronous scryptSync calls each, so the full-suite run needs headroom.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
