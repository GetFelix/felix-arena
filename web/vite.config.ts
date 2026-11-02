import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  // The models and HDRI live in ../prototype/assets, shared with the style frame.
  server: { fs: { allow: ['..'] } },
  build: {
    rollupOptions: { input: ['index.html', 'play.html', 'ticks.html', 'fx-bench.html', 'lobby.html'] },
    // The short sound effects stay files: audio elements and fetch both want a URL, and a data: URL for each is no smaller.
    assetsInlineLimit: (file) => (file.endsWith('.ogg') ? false : undefined),
  },
  // smoke/ needs the dev stack; `npm run smoke` runs it.
  test: { environment: 'node', exclude: [...configDefaults.exclude, 'smoke/**'] },
});
