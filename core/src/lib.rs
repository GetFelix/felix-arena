//! The rules of Felix Arena and the tick encoding, with no I/O. The sim links
//! this natively and the browser loads it as WebAssembly, so both run the
//! same code.
//!
//! Everything is integer arithmetic in centimetres, centimetres a second and
//! 16-bit headings, so a step gives bit-identical results on every platform.

pub mod arena;
pub mod fixed;
pub mod input;
pub mod tick;
#[cfg(target_arch = "wasm32")]
pub mod wasm;
pub mod world;

pub use input::{Input, InputRecord};
pub use tick::{Bolt, Craft, Event, Keyframe, Player, Tick, Timing, player_key};
pub use world::{CRAFT_RADIUS, Shot, Team, World, bolt_ticks, separate, steer};

#[cfg(test)]
mod tests;
