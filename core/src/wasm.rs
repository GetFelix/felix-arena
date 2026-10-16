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

/// A client's own craft, stepped ahead of the sim through the same rules.
#[wasm_bindgen]
#[derive(Clone)]
pub struct Prediction {
    craft: crate::Craft,
    others: Vec<crate::Craft>,
}

#[wasm_bindgen]
impl Prediction {
    /// Start from `craft` as a tick has it.
    #[wasm_bindgen(constructor)]
    pub fn new(craft: &JsCraft) -> Self {
        Self {
            craft: craft.0,
            others: Vec::new(),
        }
    }

    /// The other crafts as `tick` has them, which each step is pushed off.
    pub fn among(&mut self, tick: &JsTick) {
        self.others = tick.tick.crafts.clone();
    }

    /// Apply one input, as the sim would in one tick, leaving other crafts
    /// out. Answers the shot when it fired.
    pub fn step(
        &mut self,
        seq: u16,
        move_x: i8,
        move_z: i8,
        aim: u16,
        buttons: u8,
    ) -> Option<JsShot> {
        let input = crate::Input {
            seq,
            move_x,
            move_z,
            aim,
            buttons,
        };
        let shot = crate::steer(&mut self.craft, Some(input));
        crate::separate(&mut self.craft, &self.others);
        shot.map(JsShot)
    }

    /// Step without input, as the sim does a craft whose player is silent
    /// or whose match is over.
    pub fn coast(&mut self) {
        crate::steer(&mut self.craft, None);
        crate::separate(&mut self.craft, &self.others);
    }

    /// A copy to step without changing this one.
    #[wasm_bindgen(js_name = clone)]
    pub fn copy(&self) -> Prediction {
        self.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn craft(&self) -> JsCraft {
        JsCraft(self.craft)
    }
}

/// Where a shot left a craft, and the input that fired it.
#[wasm_bindgen(js_name = Shot)]
pub struct JsShot(crate::Shot);

#[wasm_bindgen(js_class = Shot)]
impl JsShot {
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> i16 {
        self.0.x
    }
    #[wasm_bindgen(getter)]
    pub fn z(&self) -> i16 {
        self.0.z
    }
    #[wasm_bindgen(getter)]
    pub fn heading(&self) -> u16 {
        self.0.heading
    }
    #[wasm_bindgen(getter)]
    pub fn seq(&self) -> u16 {
        self.0.seq
    }
    /// A rail shot: a beam the sim judges, not a bolt.
    #[wasm_bindgen(getter)]
    pub fn rail(&self) -> bool {
        self.0.rail
    }
    /// Ticks the bolt flies before the arena stops it, if it meets no craft.
    #[wasm_bindgen(getter)]
    pub fn ticks(&self) -> u32 {
        crate::bolt_ticks(self.0)
    }
}

/// How close a bolt's centre comes to a craft's to hit it, in centimetres.
#[wasm_bindgen(js_name = boltReach)]
pub fn bolt_reach() -> i32 {
    crate::CRAFT_RADIUS + crate::world::BOLT_RADIUS
}

/// The newest input in an input record, as its sequence number, move x,
/// move z, aim and buttons, or `undefined` when the bytes are not a record.
#[wasm_bindgen(js_name = decodeInput)]
pub fn decode_input(record: &[u8]) -> Option<Vec<i32>> {
    let input = crate::InputRecord::decode(record)?.inputs[0];
    Some(vec![
        i32::from(input.seq),
        i32::from(input.move_x),
        i32::from(input.move_z),
        i32::from(input.aim),
        i32::from(input.buttons),
    ])
}

/// Ticks a destroyed craft waits to respawn.
#[wasm_bindgen(js_name = respawnTicks)]
pub fn respawn_ticks() -> u16 {
    crate::world::RESPAWN_AFTER
}

/// Ticks the boost takes to cool down.
#[wasm_bindgen(js_name = boostTicks)]
pub fn boost_ticks() -> u8 {
    crate::world::BOOST_COOLDOWN
}

/// Ticks a rail charges before it fires.
#[wasm_bindgen(js_name = railChargeTicks)]
pub fn rail_charge_ticks() -> u8 {
    crate::world::RAIL_CHARGE
}

/// Bolt speed in centimetres a second.
#[wasm_bindgen(js_name = boltSpeed)]
pub fn bolt_speed() -> i32 {
    crate::world::BOLT_SPEED
}

/// The sim's world, stepped here so the page's tests can make real ticks
/// without a sim.
#[wasm_bindgen(js_name = World)]
pub struct JsWorld(crate::World);

#[wasm_bindgen(js_class = World)]
impl JsWorld {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self(crate::World::new(0))
    }

    /// A world under shorter rules, in ticks, for tests of the match loop.
    #[wasm_bindgen(js_name = withRules)]
    pub fn with_rules(
        warmup: u16,
        length: u16,
        results: u16,
        kill_limit: u16,
        rail_every: u16,
    ) -> Self {
        Self(crate::World::with_rules(
            0,
            crate::Rules {
                warmup,
                length,
                results,
                kill_limit,
                rail_every,
            },
        ))
    }

    /// Join the player with Felix principal `principal`: its slot, or
    /// `undefined` when the arena is full.
    pub fn join(&mut self, principal: &str) -> Option<u8> {
        self.0.join(crate::player_key(principal))
    }

    /// Advance one tick. `controls` holds six numbers per slot, in slot
    /// order: 1 to apply an input or 0 to coast, then its sequence number,
    /// move x, move z, aim and buttons.
    pub fn step(&mut self, controls: &[i32]) {
        self.0.step(|slot| {
            let c = controls.get(usize::from(slot) * 6..usize::from(slot) * 6 + 6)?;
            (c[0] != 0).then(|| crate::Input {
                seq: c[1] as u16,
                move_x: c[2] as i8,
                move_z: c[3] as i8,
                aim: c[4] as u16,
                buttons: c[5] as u8,
            })
        });
    }

    /// The current state as an untimed tick record of epoch 0.
    pub fn record(&self) -> Vec<u8> {
        self.0.snapshot(0).encode(None)
    }
}

impl Default for JsWorld {
    fn default() -> Self {
        Self::new()
    }
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
    /// `warmup`, `playing` or `results`.
    #[wasm_bindgen(getter)]
    pub fn phase(&self) -> String {
        match self.tick.state.phase {
            crate::Phase::Warmup => "warmup",
            crate::Phase::Playing => "playing",
            crate::Phase::Results => "results",
        }
        .into()
    }
    /// Ticks left in the phase.
    #[wasm_bindgen(getter, js_name = phaseLeft)]
    pub fn phase_left(&self) -> u16 {
        self.tick.state.left
    }
    #[wasm_bindgen(getter, js_name = coralScore)]
    pub fn coral_score(&self) -> u16 {
        self.tick.state.scores[0]
    }
    #[wasm_bindgen(getter, js_name = violetScore)]
    pub fn violet_score(&self) -> u16 {
        self.tick.state.scores[1]
    }
    /// Ticks until a rail is on the crystal, or 0 while one is.
    #[wasm_bindgen(getter, js_name = railIn)]
    pub fn rail_in(&self) -> u16 {
        self.tick.state.rail_in
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
    #[wasm_bindgen(getter)]
    pub fn bolts(&self) -> Vec<JsBolt> {
        self.tick.bolts.iter().copied().map(JsBolt).collect()
    }
    #[wasm_bindgen(getter)]
    pub fn events(&self) -> Vec<JsEvent> {
        self.tick.events.iter().copied().map(JsEvent).collect()
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
    #[wasm_bindgen(getter, js_name = fireCooldown)]
    pub fn fire_cooldown(&self) -> u8 {
        self.0.fire_cooldown
    }
    #[wasm_bindgen(getter, js_name = boostCooldown)]
    pub fn boost_cooldown(&self) -> u8 {
        self.0.boost_cooldown
    }
    /// Rail shots left.
    #[wasm_bindgen(getter)]
    pub fn rail(&self) -> u8 {
        self.0.rail
    }
    /// Ticks until a charging rail fires, or 0.
    #[wasm_bindgen(getter)]
    pub fn charge(&self) -> u8 {
        self.0.charge
    }
}

/// Something that happened in a tick. `kind` names it; the other fields are
/// those its kind has, and 0 otherwise.
#[wasm_bindgen(js_name = Event)]
pub struct JsEvent(crate::Event);

#[wasm_bindgen(js_class = Event)]
impl JsEvent {
    /// `joined`, `left`, `spawned`, `fired`, `hit` or `killed`.
    #[wasm_bindgen(getter)]
    pub fn kind(&self) -> String {
        use crate::Event::*;
        match self.0 {
            Joined { .. } => "joined",
            Left { .. } => "left",
            Spawned { .. } => "spawned",
            Fired { .. } => "fired",
            Hit { .. } => "hit",
            Killed { .. } => "killed",
            PickedUp { .. } => "picked",
            Railed { .. } => "railed",
        }
        .into()
    }
    /// The slot it happened to: who joined, left, spawned or fired, the
    /// target of a hit, the victim of a kill.
    #[wasm_bindgen(getter)]
    pub fn slot(&self) -> u8 {
        use crate::Event::*;
        match self.0 {
            Joined { slot, .. }
            | Left { slot }
            | Spawned { slot }
            | Fired { slot, .. }
            | PickedUp { slot }
            | Railed { slot, .. } => slot,
            Hit { target, .. } => target,
            Killed { victim, .. } => victim,
        }
    }
    /// The attacker of a hit, the killer of a kill.
    #[wasm_bindgen(getter)]
    pub fn by(&self) -> u8 {
        match self.0 {
            crate::Event::Hit { attacker, .. } => attacker,
            crate::Event::Killed { killer, .. } => killer,
            _ => 0,
        }
    }
    /// Who a rail's beam hit, if anyone.
    #[wasm_bindgen(getter)]
    pub fn target(&self) -> Option<u8> {
        match self.0 {
            crate::Event::Railed { target, .. } => target,
            _ => None,
        }
    }
    /// Where a rail's beam ended, in centimetres.
    #[wasm_bindgen(getter)]
    pub fn x(&self) -> i16 {
        match self.0 {
            crate::Event::Railed { x, .. } => x,
            _ => 0,
        }
    }
    #[wasm_bindgen(getter)]
    pub fn z(&self) -> i16 {
        match self.0 {
            crate::Event::Railed { z, .. } => z,
            _ => 0,
        }
    }
    #[wasm_bindgen(getter)]
    pub fn bolt(&self) -> u16 {
        match self.0 {
            crate::Event::Fired { bolt, .. } | crate::Event::Hit { bolt, .. } => bolt,
            _ => 0,
        }
    }
    /// The input that fired a shot.
    #[wasm_bindgen(getter)]
    pub fn seq(&self) -> u16 {
        match self.0 {
            crate::Event::Fired { seq, .. } => seq,
            _ => 0,
        }
    }
    #[wasm_bindgen(getter)]
    pub fn damage(&self) -> u8 {
        match self.0 {
            crate::Event::Hit { damage, .. } => damage,
            _ => 0,
        }
    }
    /// The team of who joined.
    #[wasm_bindgen(getter)]
    pub fn violet(&self) -> bool {
        matches!(
            self.0,
            crate::Event::Joined {
                team: crate::Team::Violet,
                ..
            }
        )
    }
}

/// A bolt in flight. Position in centimetres, heading in 65536ths of a turn.
#[wasm_bindgen(js_name = Bolt)]
pub struct JsBolt(crate::Bolt);

#[wasm_bindgen(js_class = Bolt)]
impl JsBolt {
    #[wasm_bindgen(getter)]
    pub fn id(&self) -> u16 {
        self.0.id
    }
    /// The slot that fired it.
    #[wasm_bindgen(getter)]
    pub fn owner(&self) -> u8 {
        self.0.owner
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
    pub fn heading(&self) -> u16 {
        self.0.heading
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
    #[wasm_bindgen(getter)]
    pub fn kills(&self) -> u16 {
        self.0.kills
    }
    #[wasm_bindgen(getter)]
    pub fn deaths(&self) -> u16 {
        self.0.deaths
    }
}
