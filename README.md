<h1 align="center">Felix Arena</h1>

<p align="center">
  A browser arena game whose entire backend is <a href="https://github.com/gabloe/felix">Felix</a>.<br>
  Every match is a log, so every kill can be replayed from it.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

![The style frame: two teams of hover-craft trading fire around a glowing crystal in a walled arena](docs/screenshots/style-frame.jpg)

Up to eight players fly low-poly hover-craft in a walled arena, Coral against
Violet, seen from a tilted top-down camera. An authoritative simulation commits
every tick to a durable Felix stream. When you die, the last few seconds replay
from that stream, from your view, your killer's, or a camera that orbits the
fight. Spectators join a match in progress by reading the same stream from its
last keyframe, and a hundred of them cost the players nothing.

**Status: design stage.** There is a [design](docs/design.md), an
[art direction](docs/art.md) and a [style frame](prototype/style-frame.html)
that proves the look. No game code yet.

## Why it exists

A broker does not argue for itself. Felix can fan one record out to hundreds of
subscribers, isolate a slow one, and serve any offset of a log again. In a game
those become features you can feel: a kill cam that is a read of the log, a
spectator feed that is more subscribers on it, and a match that survives losing
the server it was on. The [design](docs/design.md#how-multiplayer-games-are-normally-built)
compares this with how games are usually built, and says what it costs.

## See the style frame

The style frame is one HTML file that loads Three.js from jsDelivr. Serve the
`prototype` folder and open it:

```bash
cd prototype && python3 -m http.server 8000
# open http://localhost:8000/style-frame.html
```

Drag to orbit. Add `?t=1.2` to freeze the action at a moment.

## Build order

| M | Milestone | Proves |
|---|---|---|
| 0 | The look, locked | The game looks good at 60 fps on a laptop iGPU before any gameplay exists |
| 1 | A browser reaches Felix | Ticks flow at 30 Hz through the gateway, every hop timed |
| 2 | One authority | Playable through Felix with prediction and interpolation |
| 3 | Join mid-match | A spectator draws a correct frame in under 500 ms |
| 4 | The kill cam | A replay from the log on screen within 800 ms of a kill |
| 5 | Isolation and gaps | A throttled client falls behind alone and recovers |
| 6 | Per-arena sign-in | The broker enforces who can play and who can only watch |
| 7 | Scale and failover | 100 spectators, and a match that survives losing its broker |
| 8 | Self-hosting | Anyone can run it from published images |

## Related

[felix-canvas](https://github.com/gabloe/felix-canvas) is the sibling project:
a multiplayer drawing canvas on Felix. This one reuses its gateway, its
sign-in and its approach to joins and gaps.

## Licence

MIT. Models and the HDRI are CC0; see [prototype/assets/CREDITS.md](prototype/assets/CREDITS.md).
