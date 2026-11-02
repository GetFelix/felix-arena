// Every .ogg under prototype/assets/audio is part of the game; adding a file is enough to bundle it. The files are
// listed with their licences in prototype/assets/audio/CREDITS.md.
import type { SoundFiles } from './sound';

const urls = (found: Record<string, string>): Record<string, string> => {
  const byName: Record<string, string> = {};
  for (const [path, url] of Object.entries(found)) {
    byName[path.slice(path.lastIndexOf('/') + 1, -'.ogg'.length)] = url;
  }
  return byName;
};

export const soundFiles: SoundFiles = {
  sfx: urls(
    import.meta.glob<string>('../../prototype/assets/audio/sfx/*.ogg', {
      query: '?url',
      import: 'default',
      eager: true,
    }),
  ),
  music: urls(
    import.meta.glob<string>('../../prototype/assets/audio/music/*.ogg', {
      query: '?url',
      import: 'default',
      eager: true,
    }),
  ),
};
