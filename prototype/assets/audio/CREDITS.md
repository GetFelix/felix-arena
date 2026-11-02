# Audio credits

Every file here is CC0 1.0 (public domain). No credit is required; it is given anyway, and the licence of each file
was read on the page it came from.

Nothing is fetched from these sites when the game runs. The files in `sfx/` and `music/` are bundled with the game.
`build.sh` rebuilds them from the downloads named below, and says what it does to each one.

## Sound effects

Both packs are by Kenney (https://kenney.nl), CC0 1.0. The licence file each pack ships with is kept in
`licenses/`. The packs are also on OpenGameArt, where the page lists CC0 as well.

| Pack | Pages |
|---|---|
| Sci-Fi Sounds 1.0 | https://kenney.nl/assets/sci-fi-sounds, https://opengameart.org/content/sci-fi-sounds, licence in `licenses/kenney-sci-fi-sounds.txt` |
| Interface Sounds 1.0 | https://kenney.nl/assets/interface-sounds, https://opengameart.org/content/interface-sounds, licence in `licenses/kenney-interface-sounds.txt` |

| File | From | Used for |
|---|---|---|
| `sfx/fire-1.ogg` | Sci-Fi Sounds `laserSmall_000` | blaster shots |
| `sfx/fire-2.ogg` | Sci-Fi Sounds `laserSmall_001` | blaster shots |
| `sfx/fire-3.ogg` | Sci-Fi Sounds `laserSmall_002` | blaster shots |
| `sfx/hit-1.ogg` | Sci-Fi Sounds `impactMetal_001` | a shot landing on a craft |
| `sfx/hit-2.ogg` | Sci-Fi Sounds `impactMetal_002` | a shot landing on a craft |
| `sfx/hurt.ogg` | Sci-Fi Sounds `impactMetal_004` | your craft being hit |
| `sfx/absorb.ogg` | Sci-Fi Sounds `forceField_000` | a shot stopped by the spawn shield |
| `sfx/spawn.ogg` | Sci-Fi Sounds `forceField_004` | a craft spawning |
| `sfx/explode-1.ogg` | Sci-Fi Sounds `explosionCrunch_000` | a craft destroyed |
| `sfx/explode-2.ogg` | Sci-Fi Sounds `explosionCrunch_001` | a craft destroyed |
| `sfx/destroyed.ogg` | Sci-Fi Sounds `lowFrequency_explosion_000` | your craft destroyed |
| `sfx/rail.ogg` | Sci-Fi Sounds `laserLarge_000` | the rail shot |
| `sfx/boost.ogg` | Sci-Fi Sounds `thrusterFire_000` | your boost |
| `sfx/pickup.ogg` | Interface Sounds `confirmation_002` | the rail taken from the crystal |
| `sfx/overheat.ogg` | Interface Sounds `error_003` | your blaster overheating |
| `sfx/tick.ogg` | Interface Sounds `pluck_001` | the last seconds of warmup |
| `sfx/go.ogg` | Interface Sounds `confirmation_004` | the round starting |
| `sfx/round-end.ogg` | Interface Sounds `select_006` | the round ending |
| `sfx/click.ogg` | Interface Sounds `click_001` | HUD buttons |
| `sfx/toggle.ogg` | Interface Sounds `toggle_001` | the sound switch turned on |
| `sfx/replay-in.ogg` | Interface Sounds `minimize_004` | a replay starting |
| `sfx/replay-out.ogg` | Interface Sounds `maximize_004` | a replay ending |

Changes to every effect: converted from Ogg Vorbis to mono Ogg Opus at 32 kbit/s, leading silence removed, brought to
the same average level (-18 dB RMS) with a limiter above it, and a short fade out. Some are cut shorter: `hit-1`,
`hit-2` (0.3 s), `hurt` (0.38 s), `destroyed` (1.6 s) and `boost` (0.8 s).

## Music

Five fast tracks, played in a shuffled order. Each was downloaded from the page named, where the licence is CC0. The
tempo is measured from the audio, so it is approximate.

| File | Title and author | Page | Download | Tempo |
|---|---|---|---|---|
| `music/final-hour.ogg` | "Final Hour" by isaiah658 | https://opengameart.org/content/final-hour | `Final-Hour-isaiah658.ogg` | drum and bass, about 170 |
| `music/robotic.ogg` | "Friendly Talk On a Robotic Battlefield (Looped)" by illin | https://opengameart.org/content/friendly-talk-on-a-robotic-battlefield-looped | `Friendly Talk On a Robotic Battlefield_0.ogg`, renamed `robotic-battlefield.ogg` | aggressive electronic, about 158 |
| `music/shooter.ogg` | "8 bit Epic Space Shooter Music" by HydroGene | https://opengameart.org/content/8-bit-epic-space-shooter-music | `8bit-spaceshooter.mp3` | chiptune action, about 140 |
| `music/level-1.ogg` | "Level 1" from "5 Chiptunes (Action)" by Juhani Junkala (posted by SubspaceAudio) | https://opengameart.org/content/5-chiptunes-action | `Juhani Junkala [Retro Game Music Pack] Level 1.wav` in the pack's zip, renamed `junkala-level-1.wav` | chiptune action, about 180 |
| `music/level-3.ogg` | "Level 3" from "5 Chiptunes (Action)" by Juhani Junkala (posted by SubspaceAudio) | https://opengameart.org/content/5-chiptunes-action | `Juhani Junkala [Retro Game Music Pack] Level 3.wav` in the pack's zip, renamed `junkala-level-3.wav` | chiptune action, about 140 |

The Junkala pack's own `INFO.txt` says the tracks are released under CC0.

Changes to every track: converted to 48 kHz stereo Ogg Opus at 56 kbit/s, brought to -20 LUFS with a true peak under
-2 dBFS, and a 2 second fade in and out, so that one track starting as the last ends crosses into it. Nothing else was
edited, and the music is not looped inside a file.
