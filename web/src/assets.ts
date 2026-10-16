// Every GLB under prototype/assets/models is part of the game; adding a file is enough to load it.
const found = import.meta.glob<string>('../../prototype/assets/models/**/*.glb', {
  query: '?url',
  import: 'default',
  eager: true,
});

/** Model URLs keyed by file name without the extension, such as `craft_speederA`. */
export const modelUrls: Record<string, string> = {};
for (const [path, url] of Object.entries(found)) {
  const name = path.slice(path.lastIndexOf('/') + 1, -'.glb'.length);
  if (name in modelUrls) throw new Error(`two models are named ${name}`);
  modelUrls[name] = url;
}

/** The studio HDRI the scene's reflections come from. */
export { default as hdriUrl } from '../../prototype/assets/hdri/studio_small_09_1k.hdr?url';
