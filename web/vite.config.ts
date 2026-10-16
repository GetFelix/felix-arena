import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The models and HDRI live in ../prototype/assets, shared with the style frame.
  server: { fs: { allow: ['..'] } },
  test: { environment: 'node' },
});
