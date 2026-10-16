import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // The models and HDRI live in ../prototype/assets, shared with the style frame.
  server: { fs: { allow: ['..'] } },
  build: { rollupOptions: { input: ['index.html', 'play.html', 'ticks.html'] } },
  // smoke/ needs the dev stack; `npm run smoke` runs it.
  test: { environment: 'node', exclude: [...configDefaults.exclude, 'smoke/**'] },
});
