//! The browser's view of the crate.

use wasm_bindgen::prelude::*;

/// A client's input records: each call makes the next record, numbered one
/// after the last and carrying the two inputs before it.
#[wasm_bindgen]
pub struct Inputs {
    newest: crate::Input,
    previous: [crate::Input; 2],
}

#[wasm_bindgen]
impl Inputs {
    /// The first record will be numbered `first`.
    #[wasm_bindgen(constructor)]
    pub fn new(first: u16) -> Self {
        let none = crate::Input {
            seq: first.wrapping_sub(1),
            ..Default::default()
        };
        Self {
            newest: none,
            previous: [none; 2],
        }
    }

    /// The record for this tick's controls: the move stick from -127 to 127
    /// on each axis, the aim heading and the buttons (1 fire, 2 boost).
    pub fn next(&mut self, move_x: i8, move_z: i8, aim: u16, buttons: u8) -> Vec<u8> {
        let input = crate::Input {
            seq: self.newest.seq.wrapping_add(1),
            move_x,
            move_z,
            aim,
            buttons,
        };
        self.previous = [self.newest, self.previous[0]];
        self.newest = input;
        crate::InputRecord::new(input, self.previous)
            .encode()
            .to_vec()
    }

    /// The sequence number of the last record made.
    #[wasm_bindgen(getter)]
    pub fn seq(&self) -> u16 {
        self.newest.seq
    }
}

/// A decoded tick record.
#[wasm_bindgen(js_name = Tick)]
pub struct JsTick {
    tick: crate::Tick,
    timing: Option<crate::Timing>,
}

/// Decode one tick record, or throw when the bytes are not one.
#[wasm_bindgen(js_name = decodeTick)]
pub fn decode_tick(record: &[u8]) -> Result<JsTick, JsError> {
    let (tick, timing) =
        crate::Tick::decode(record).ok_or_else(|| JsError::new("not a tick record"))?;
    Ok(JsTick { tick, timing })
}

/// [`crate::player_key`] as 16 hex digits.
#[wasm_bindgen(js_name = playerKey)]
pub fn player_key(principal: &str) -> String {
    format!("{:016x}", crate::player_key(principal))
}

/// The arena in centimetres, for drawing it: half its length and width, then
/// each obstacle in [`crate::arena::OBSTACLES`] order as five numbers, a kind
/// (0 a box, 1 a round prop), x, z, then half x and half z for a box or the
/// radius and 0 for a round prop.
#[wasm_bindgen]
pub fn arena() -> Vec<i32> {
    use crate::arena::{HALF_X, HALF_Z, OBSTACLES, Obstacle};
    let mut out = vec![HALF_X, HALF_Z];
    for obstacle in OBSTACLES {
        out.extend(match obstacle {
            Obstacle::Box {
                x,
                z,
                half_x,
                half_z,
            } => [0, x, z, half_x, half_z],
            Obstacle::Round { x, z, radius } => [1, x, z, radius, 0],
        });
    }
    out
}

#[wasm_bindgen(js_class = Tick)]
impl JsTick {
    #[wasm_bindgen(getter)]
    pub fn epoch(&self) -> u16 {
        self.tick.epoch
    }
    #[wasm_bindgen(getter, js_name = matchNumber)]
    pub fn match_number(&self) -> u32 {
        self.tick.match_number
    }
    #[wasm_bindgen(getter)]
    pub fn tick(&self) -> u32 {
        self.tick.tick
    }
    #[wasm_bindgen(getter)]
    pub fn keyframe(&self) -> bool {
        self.tick.is_keyframe()
    }
    /// The state hash as 16 hex digits, as the sim logs it.
    #[wasm_bindgen(getter)]
    pub fn hash(&self) -> String {
        format!("{:016x}", self.tick.hash())
    }
    #[wasm_bindgen(getter)]
    pub fn timing(&self) -> Option<JsTiming> {
        self.timing.map(JsTiming)
    }
    #[wasm_bindgen(getter)]
    pub fn crafts(&self) -> Vec<JsCraft> {
        self.tick.crafts.iter().copied().map(JsCraft).collect()
    }
    #[wasm_bindgen(getter, js_name = boltCount)]
    pub fn bolt_count(&self) -> usize {
        self.tick.bolts.len()
    }
    #[wasm_bindgen(getter, js_name = eventCount)]
    pub fn event_count(&self) -> usize {
        self.tick.events.len()
    }
    /// The roster, on a keyframe; empty otherwise.
    #[wasm_bindgen(getter)]
    pub fn players(&self) -> Vec<JsPlayer> {
        self.tick
            .keyframe
            .iter()
            .flat_map(|k| k.players.iter().copied().map(JsPlayer))
            .collect()
    }
}

/// When the sim stepped and committed a tick.
#[wasm_bindgen(js_name = Timing)]
pub struct JsTiming(crate::Timing);

#[wasm_bindgen(js_class = Timing)]
impl JsTiming {
    /// µs since the Unix epoch. A double holds it exactly until the year 2255.
    #[wasm_bindgen(getter, js_name = commitStartUs)]
    pub fn commit_start_us(&self) -> f64 {
        self.0.commit_start_us as f64
    }
    #[wasm_bindgen(getter, js_name = stepUs)]
    pub fn step_us(&self) -> u32 {
        self.0.step_us
    }
    #[wasm_bindgen(getter, js_name = previousCommitUs)]
    pub fn previous_commit_us(&self) -> u32 {
        self.0.previous_commit_us
    }
}

/// One craft in a tick. Positions in centimetres, headings in 65536ths of a
/// turn.
#[wasm_bindgen(js_name = Craft)]
pub struct JsCraft(crate::Craft);

#[wasm_bindgen(js_class = Craft)]
impl JsCraft {
    #[wasm_bindgen(getter)]
    pub fn slot(&self) -> u8 {
        self.0.slot
    }
    #[wasm_bindgen(getter)]
    pub fn violet(&self) -> bool {
        self.0.team == crate::Team::Violet
    }
    #[wasm_bindgen(getter)]
    pub fn alive(&self) -> bool {
        self.0.alive
    }
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> i16 {
        self.0.x
    }
    #[wasm_bindgen(getter)]
    pub fn z(&self) -> i16 {
        self.0.z
    }
    #[wasm_bindgen(getter)]
    pub fn vx(&self) -> i16 {
        self.0.vx
    }
    #[wasm_bindgen(getter)]
    pub fn vz(&self) -> i16 {
        self.0.vz
    }
    #[wasm_bindgen(getter)]
    pub fn heading(&self) -> u16 {
        self.0.heading
    }
    #[wasm_bindgen(getter)]
    pub fn health(&self) -> u8 {
        self.0.health
    }
    #[wasm_bindgen(getter, js_name = lastInput)]
    pub fn last_input(&self) -> u16 {
        self.0.last_input
    }
}

/// One player on a keyframe's roster.
#[wasm_bindgen(js_name = Player)]
pub struct JsPlayer(crate::Player);

#[wasm_bindgen(js_class = Player)]
impl JsPlayer {
    #[wasm_bindgen(getter)]
    pub fn slot(&self) -> u8 {
        self.0.slot
    }
    /// [`player_key`] of the player's principal, as 16 hex digits.
    #[wasm_bindgen(getter)]
    pub fn key(&self) -> String {
        format!("{:016x}", self.0.key)
    }
    #[wasm_bindgen(getter)]
    pub fn violet(&self) -> bool {
        self.0.team == crate::Team::Violet
    }
}
