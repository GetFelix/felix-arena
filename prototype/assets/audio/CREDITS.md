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
| `sfx/toggle.ogg` | Interface Sounds `toggle_001` | the sound switch |
| `sfx/replay-in.ogg` | Interface Sounds `minimize_004` | a replay starting |
| `sfx/replay-out.ogg` | Interface Sounds `maximize_004` | a replay ending |

Changes to every effect: converted from Ogg Vorbis to mono Ogg Opus at 32 kbit/s, leading silence removed, brought to
the same average level (-18 dB RMS) with a limiter above it, and a short fade out. Some are cut shorter: `hit-1`,
`hit-2` (0.3 s), `hurt` (0.38 s), `destroyed` (1.6 s) and `boost` (0.8 s).

## Music

Five tracks, played in a shuffled order. Each was downloaded from the page named, where the licence is CC0.

| File | Title and author | Page | Download |
|---|---|---|---|
| `music/void.ogg` | "Claimed by the Void" by vitalezzz | https://opengameart.org/content/claimed-by-the-void | `claimed_by_the_void_loop.mp3` |
| `music/temple.ogg` | "Galactic Temple" by yd | https://opengameart.org/content/galactic-temple | `GalacticTemple.ogg` from `GalacticTemple.zip` |
| `music/synthwave.ogg` | "Synthwave 4k" by cynicmusic (The Cynic Project) | https://opengameart.org/node/97098 | `001_Synthwave_4k_0.mp3` |
| `music/outer.ogg` | "Outer Space Loop" by wipics | https://opengameart.org/content/outer-space-loop | `outer_space_2.mp3` |
| `music/echo.ogg` | "Space Echo" by Centurion_of_war | https://opengameart.org/content/space-echo | `space_echo.ogg` |

Changes to every track: converted to 48 kHz stereo Ogg Opus at 48 kbit/s, brought to -20 LUFS with a true peak under
-2 dBFS, and a 3 second fade in and out, so that one track starting as the last ends crosses into it. Nothing else was
edited, and the music is not looped inside a file.
