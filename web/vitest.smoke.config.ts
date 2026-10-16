import { defineConfig } from 'vitest/config';

// The smoke tests need the dev stack, so `npm test` leaves them out.
export default defineConfig({
  test: { environment: 'node', include: ['smoke/**/*.test.ts'] },
});
