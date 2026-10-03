# Contributing

This page is how code and pull requests should read. [docs/design.md](docs/design.md)
is what is being built, and [docs/art.md](docs/art.md) is how it must look.

## Code

- Write the simplest thing that meets the design. No abstraction a milestone
  does not need yet. The one seam the design asks for is the gateway's
  transport.
- Keep the gateway a relay. It stamps the sender on inputs and otherwise never
  decodes, reorders or holds game state. Anything that needs to understand a
  tick belongs in `core/`.
- Write the rules once. Movement, collision, damage and the tick encoding live
  in `core/`, linked by the sim and compiled to WebAssembly for the browser,
  never copied into TypeScript.
- The sim is the only authority. A client may predict, but never decides a hit,
  a kill or a score.
- Format with `cargo fmt` and prettier. CI checks both.
- Plain TypeScript and Three.js in `web/`, no UI framework.
- npm and cargo run in CI or a Codespace. Pin dependency versions.

## Art

- Every colour comes from the palette module. No colour literals anywhere else.
- Models are restyled by material name at load time. A model that does not use
  the Kenney material names needs a mapping before it is merged.
- New assets must be CC0 or similarly free, and listed with their source and
  licence in the credits file next to them.
- A change to lighting, materials or post processing comes with a before and
  after screenshot of the same frozen moment (`?t=` on the style frame or the
  game's equivalent), and a frame time on an iGPU.

## Comments and docs

- Comment only where the code is unclear: a sentence or two on a constraint the
  code cannot show, such as an ordering requirement or a failure mode.
- No narration of what the code does, no templated headers, no comments that
  restate a test's name.
- Document public items briefly (`///` and TSDoc): what it does and what it
  guarantees.
- Write docs in plain sentences. No em-dashes, no filler words, no hedging.
- Docs change with the code. If a pull request changes behaviour, update the
  page that describes it.

## Pull requests

- One pull request per milestone, closing that milestone's issues.
- CI must pass before review.
- No AI attribution in commits or pull request descriptions.
- List any design calls under "Review notes", and any Felix gaps you hit under
  "Felix gaps found", with the Felix issue each one is filed as.
