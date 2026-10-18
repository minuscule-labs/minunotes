import { defineConfig } from 'vitest/config';

// Deliberately independent of Vite/SST: only the opt-in demo lifecycle suite.
export default defineConfig({
  test: {
    include: ['tests/demo/**/*.test.ts'],
    fileParallelism: false,
  },
});
