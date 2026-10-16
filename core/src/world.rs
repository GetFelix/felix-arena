//! The rules: movement, collision, bolts and damage, one 30 Hz step at a time.
//! All state is in the units the tick carries, so a tick holds it exactly.

use crate::arena::{HALF_X, HALF_Z, OBSTACLES, Obstacle, spawn};
use crate::fixed::{self, div_round, length};
use crate::input::{BOOST, FIRE, Input};
use crate::tick::{Bolt, Craft, Event, Keyframe, Player, Tick};

/// Steps a second.
pub const HZ: i32 = 30;
/// Every this many ticks is a keyframe.
pub const KEYFRAME_EVERY: u32 = 30;
/// At most this many crafts, four a side.
pub const MAX_CRAFTS: usize = 8;
pub const CRAFT_RADIUS: i32 = 75;
pub const BOLT_RADIUS: i32 = 10;
/// cm/s.
pub const MAX_SPEED: i32 = 800;
/// cm/s a craft's velocity can change in one tick: full speed in five.
pub const ACCEL: i32 = 160;
/// cm/s lost each tick by a craft whose player has gone quiet.
pub const COAST_DRAG: i32 = 30;
/// cm/s at the start of a dash.
pub const BOOST_SPEED: i32 = 2000;
pub const BOOST_COOLDOWN: u8 = 90;
/// cm/s: 30 m/s.
pub const BOLT_SPEED: i32 = 3000;
/// Ticks between shots: six a second.
pub const FIRE_COOLDOWN: u8 = 5;
pub const BOLT_DAMAGE: u8 = 12;
pub const MAX_HEALTH: u8 = 100;
/// Ticks without damage before health regenerates.
pub const REGEN_AFTER: u16 = 120;
/// Ticks per point of health regenerated.
pub const REGEN_EVERY: u16 = 3;
pub const RESPAWN_AFTER: u16 = 150;
/// Bolts are checked this many times along each tick's flight, so one cannot
/// pass through a craft or a thin wall between two checks.
const BOLT_STEPS: i32 = 4;

/// A team.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Team {
    Coral,
    Violet,
}

/// A craft's state the tick does not carry, which only the sim needs.
#[derive(Clone, Copy, Debug, Default)]
struct Hidden {
    since_damage: u16,
    respawn_in: u16,
}

/// One arena's match: everything the sim steps.
#[derive(Clone, Debug)]
pub struct World {
    match_number: u32,
    tick: u32,
    crafts: Vec<Craft>,
    hidden: [Hidden; MAX_CRAFTS],
    players: Vec<Player>,
    bolts: Vec<Bolt>,
    next_bolt: u16,
    scores: [u16; 2],
    /// What happened in the step that made the current tick.
    events: Vec<Event>,
    /// Joins and leaves since that step, which belong to the next tick.
    pending: Vec<Event>,
}

impl World {
    pub fn new(match_number: u32) -> Self {
        Self {
            match_number,
            tick: 0,
            crafts: Vec::new(),
            hidden: [Hidden::default(); MAX_CRAFTS],
            players: Vec::new(),
            bolts: Vec::new(),
            next_bolt: 0,
            scores: [0; 2],
            events: Vec::new(),
            pending: Vec::new(),
        }
    }

    /// The tick number of the current state.
    pub fn tick(&self) -> u32 {
        self.tick
    }

    pub fn crafts(&self) -> &[Craft] {
        &self.crafts
    }

    /// Add a player identified by `key`, on the smaller team, and spawn its
    /// craft. Answers its slot, or `None` when the arena is full. A key that
    /// is already playing keeps its slot.
    pub fn join(&mut self, key: u64) -> Option<u8> {
        if let Some(player) = self.players.iter().find(|p| p.key == key) {
            return Some(player.slot);
        }
        let slot =
            (0..MAX_CRAFTS as u8).find(|slot| self.players.iter().all(|p| p.slot != *slot))?;
        let coral = self
            .players
            .iter()
            .filter(|p| p.team == Team::Coral)
            .count();
        let team = if coral * 2 <= self.players.len() {
            Team::Coral
        } else {
            Team::Violet
        };
        let place = self.players.iter().filter(|p| p.team == team).count();
        self.players.push(Player {
            slot,
            team,
            key,
            kills: 0,
            deaths: 0,
        });
        self.players.sort_by_key(|p| p.slot);
        self.crafts.push(self.spawned(slot, team, place));
        self.crafts.sort_by_key(|c| c.slot);
        self.hidden[usize::from(slot)] = Hidden::default();
        self.pending.push(Event::Joined { slot, team, key });
        Some(slot)
    }

    /// Remove the player in `slot` and its craft and bolts.
    pub fn leave(&mut self, slot: u8) {
        let before = self.players.len();
        self.players.retain(|p| p.slot != slot);
        if self.players.len() == before {
            return;
        }
        self.crafts.retain(|c| c.slot != slot);
        self.bolts.retain(|b| b.owner != slot);
        self.pending.push(Event::Left { slot });
    }

    /// Advance one tick. `input` answers the input to apply to each slot's
    /// craft, or `None` to let it coast.
    pub fn step(&mut self, mut input: impl FnMut(u8) -> Option<Input>) {
        self.events = std::mem::take(&mut self.pending);
        self.tick = self.tick.wrapping_add(1);
        self.move_bolts();
        for i in 0..self.crafts.len() {
            let slot = self.crafts[i].slot;
            let control = input(slot);
            self.step_craft(i, control);
        }
        self.separate_crafts();
    }

    /// The current state as a tick, for `epoch`. Every
    /// [`KEYFRAME_EVERY`]th tick is a keyframe.
    pub fn snapshot(&self, epoch: u16) -> Tick {
        let keyframe = self.tick.is_multiple_of(KEYFRAME_EVERY).then(|| Keyframe {
            scores: self.scores,
            players: self.players.clone(),
        });
        Tick {
            epoch,
            match_number: self.match_number,
            tick: self.tick,
            crafts: self.crafts.clone(),
            bolts: self.bolts.clone(),
            events: self.events.clone(),
            keyframe,
        }
    }

    fn step_craft(&mut self, i: usize, control: Option<Input>) {
        let mut craft = self.crafts[i];
        let slot = craft.slot;
        let mut hidden = self.hidden[usize::from(slot)];
        craft.boost_cooldown = craft.boost_cooldown.saturating_sub(1);
        craft.fire_cooldown = craft.fire_cooldown.saturating_sub(1);
        if let Some(input) = control {
            craft.last_input = input.seq;
        }
        if craft.alive {
            self.fly(&mut craft, &mut hidden, control);
        } else {
            hidden.respawn_in = hidden.respawn_in.saturating_sub(1);
            if hidden.respawn_in == 0 {
                let place = self
                    .players
                    .iter()
                    .filter(|p| p.team == craft.team && p.slot < slot)
                    .count();
                craft = Craft {
                    last_input: craft.last_input,
                    ..self.spawned(slot, craft.team, place)
                };
                hidden = Hidden::default();
                self.events.push(Event::Spawned { slot });
            }
        }
        self.crafts[i] = craft;
        self.hidden[usize::from(slot)] = hidden;
    }

    fn spawned(&self, slot: u8, team: Team, place: usize) -> Craft {
        let (x, z) = spawn(team, place);
        let heading = if team == Team::Coral { 0 } else { 32768 };
        Craft::spawned(slot, team, x as i16, z as i16, heading)
    }

    fn fly(&mut self, craft: &mut Craft, hidden: &mut Hidden, control: Option<Input>) {
        hidden.since_damage = hidden.since_damage.saturating_add(1);
        if craft.health < MAX_HEALTH
            && hidden.since_damage >= REGEN_AFTER
            && (hidden.since_damage - REGEN_AFTER).is_multiple_of(REGEN_EVERY)
        {
            craft.health += 1;
        }

        let (mut vx, mut vz) = (i32::from(craft.vx), i32::from(craft.vz));
        match control {
            Some(input) => {
                craft.heading = input.aim;
                let (mx, mz) = (
                    i32::from(input.move_x.max(-127)),
                    i32::from(input.move_z.max(-127)),
                );
                let stick = length(mx, mz);
                let full = stick.max(127);
                (vx, vz) = toward(vx, vz, mx * MAX_SPEED / full, mz * MAX_SPEED / full, ACCEL);
                if input.buttons & BOOST != 0 && craft.boost_cooldown == 0 {
                    let (dx, dz) = if stick > 0 {
                        (mx * fixed::ONE / stick, mz * fixed::ONE / stick)
                    } else {
                        (fixed::cos(input.aim), fixed::sin(input.aim))
                    };
                    (vx, vz) = (fixed::scale(dx, BOOST_SPEED), fixed::scale(dz, BOOST_SPEED));
                    craft.boost_cooldown = BOOST_COOLDOWN;
                }
                if input.buttons & FIRE != 0 && craft.fire_cooldown == 0 {
                    craft.fire_cooldown = FIRE_COOLDOWN;
                    let reach = CRAFT_RADIUS + BOLT_RADIUS + 5;
                    let bolt = self.next_bolt;
                    self.next_bolt = self.next_bolt.wrapping_add(1);
                    self.bolts.push(Bolt {
                        id: bolt,
                        owner: craft.slot,
                        x: (i32::from(craft.x) + fixed::scale(fixed::cos(input.aim), reach)) as i16,
                        z: (i32::from(craft.z) + fixed::scale(fixed::sin(input.aim), reach)) as i16,
                        heading: input.aim,
                    });
                    self.events.push(Event::Fired {
                        slot: craft.slot,
                        bolt,
                        seq: input.seq,
                    });
                }
            }
            None => (vx, vz) = toward(vx, vz, 0, 0, COAST_DRAG),
        }

        let (mut x, mut z) = (
            i32::from(craft.x) + div_round(vx, HZ),
            i32::from(craft.z) + div_round(vz, HZ),
        );
        (x, z, vx, vz) = resolve(x, z, vx, vz);
        (craft.x, craft.z, craft.vx, craft.vz) = (x as i16, z as i16, vx as i16, vz as i16);
    }

    fn move_bolts(&mut self) {
        let mut bolts = std::mem::take(&mut self.bolts);
        bolts.retain_mut(|bolt| {
            let (x0, z0) = (i32::from(bolt.x), i32::from(bolt.z));
            let (dx, dz) = (fixed::cos(bolt.heading), fixed::sin(bolt.heading));
            // Bolts pass through teammates: no friendly fire.
            let shooter = self
                .players
                .iter()
                .find(|p| p.slot == bolt.owner)
                .map(|p| p.team);
            for step in 1..=BOLT_STEPS {
                let travel = BOLT_SPEED * step / (HZ * BOLT_STEPS);
                let (x, z) = (x0 + fixed::scale(dx, travel), z0 + fixed::scale(dz, travel));
                if x.abs() > HALF_X - BOLT_RADIUS
                    || z.abs() > HALF_Z - BOLT_RADIUS
                    || OBSTACLES.iter().any(|o| o.touches(x, z, BOLT_RADIUS))
                {
                    return false;
                }
                let hit = self.crafts.iter().position(|c| {
                    c.alive && Some(c.team) != shooter && {
                        let (ex, ez) =
                            (i64::from(x - i32::from(c.x)), i64::from(z - i32::from(c.z)));
                        let reach = i64::from(CRAFT_RADIUS + BOLT_RADIUS);
                        ex * ex + ez * ez < reach * reach
                    }
                });
                if let Some(target) = hit {
                    self.damage(target, bolt.owner, bolt.id);
                    return false;
                }
                if step == BOLT_STEPS {
                    (bolt.x, bolt.z) = (x as i16, z as i16);
                }
            }
            true
        });
        self.bolts = bolts;
    }

    fn damage(&mut self, target: usize, attacker: u8, bolt: u16) {
        let craft = &mut self.crafts[target];
        let damage = BOLT_DAMAGE.min(craft.health);
        craft.health -= damage;
        let slot = craft.slot;
        self.hidden[usize::from(slot)].since_damage = 0;
        self.events.push(Event::Hit {
            target: slot,
            attacker,
            bolt,
            damage,
        });
        if craft.health > 0 {
            return;
        }
        craft.alive = false;
        (craft.vx, craft.vz) = (0, 0);
        self.hidden[usize::from(slot)].respawn_in = RESPAWN_AFTER;
        self.events.push(Event::Killed {
            victim: slot,
            killer: attacker,
        });
        let killer_team = self
            .players
            .iter()
            .find(|p| p.slot == attacker)
            .map(|p| p.team);
        for player in &mut self.players {
            if player.slot == slot {
                player.deaths = player.deaths.saturating_add(1);
            }
            if player.slot == attacker {
                player.kills = player.kills.saturating_add(1);
            }
        }
        if let Some(team) = killer_team {
            let score = &mut self.scores[team as usize];
            *score = score.saturating_add(1);
        }
    }

    /// Push overlapping crafts apart, each by half the overlap, in slot order.
    fn separate_crafts(&mut self) {
        for i in 0..self.crafts.len() {
            for j in i + 1..self.crafts.len() {
                let (a, b) = (self.crafts[i], self.crafts[j]);
                if !a.alive || !b.alive {
                    continue;
                }
                let (dx, dz) = (
                    i32::from(b.x) - i32::from(a.x),
                    i32::from(b.z) - i32::from(a.z),
                );
                let distance = length(dx, dz);
                let overlap = 2 * CRAFT_RADIUS - distance;
                if overlap <= 0 {
                    continue;
                }
                let (dx, dz, distance) = if distance == 0 {
                    (1, 0, 1)
                } else {
                    (dx, dz, distance)
                };
                let (px, pz) = (
                    dx * (overlap / 2 + 1) / distance,
                    dz * (overlap / 2 + 1) / distance,
                );
                for (k, sign) in [(i, -1), (j, 1)] {
                    let craft = self.crafts[k];
                    let (x, z, vx, vz) = resolve(
                        i32::from(craft.x) + sign * px,
                        i32::from(craft.z) + sign * pz,
                        i32::from(craft.vx),
                        i32::from(craft.vz),
                    );
                    (self.crafts[k].x, self.crafts[k].z) = (x as i16, z as i16);
                    (self.crafts[k].vx, self.crafts[k].vz) = (vx as i16, vz as i16);
                }
            }
        }
    }
}

#[cfg(test)]
impl World {
    pub(crate) fn crafts_mut(&mut self) -> &mut [Craft] {
        &mut self.crafts
    }

    /// Top up the bolts in flight to `count`, spread over the arena.
    pub(crate) fn fill_bolts(&mut self, count: usize) {
        while self.bolts.len() < count {
            let n = self.bolts.len() as i32;
            let id = self.next_bolt;
            self.next_bolt = self.next_bolt.wrapping_add(1);
            self.bolts.push(Bolt {
                id,
                owner: (n % 8) as u8,
                x: (-1800 + (n * 577) % 3600) as i16,
                z: (-1200 + (n * 331) % 2400) as i16,
                heading: (n as u16).wrapping_mul(9_973),
            });
        }
    }
}

/// A craft at `(x, z)` moved out of any cover and walls it overlaps, with
/// the velocity into them removed.
fn resolve(mut x: i32, mut z: i32, mut vx: i32, mut vz: i32) -> (i32, i32, i32, i32) {
    for _ in 0..2 {
        for obstacle in OBSTACLES {
            let Some((nx, nz, ux, uz, distance, reach)) = contact(obstacle, x, z) else {
                continue;
            };
            x = nx + ux * reach / distance;
            z = nz + uz * reach / distance;
            (vx, vz) = slide(vx, vz, ux, uz, distance);
        }
        let cx = x.clamp(-HALF_X + CRAFT_RADIUS, HALF_X - CRAFT_RADIUS);
        let cz = z.clamp(-HALF_Z + CRAFT_RADIUS, HALF_Z - CRAFT_RADIUS);
        if cx != x {
            vx = 0;
        }
        if cz != z {
            vz = 0;
        }
        (x, z) = (cx, cz);
    }
    (x, z, vx, vz)
}

/// `(vx, vz)` moved toward `(tx, tz)` by at most `limit`.
fn toward(vx: i32, vz: i32, tx: i32, tz: i32, limit: i32) -> (i32, i32) {
    let (dx, dz) = (tx - vx, tz - vz);
    let distance = length(dx, dz);
    if distance <= limit {
        (tx, tz)
    } else {
        (vx + dx * limit / distance, vz + dz * limit / distance)
    }
}

/// Velocity with any part into a surface whose outward normal is `(nx, nz)`
/// removed.
fn slide(vx: i32, vz: i32, nx: i32, nz: i32, length: i32) -> (i32, i32) {
    let into = (vx * nx + vz * nz) / length;
    if into >= 0 {
        return (vx, vz);
    }
    (vx - nx * into / length, vz - nz * into / length)
}

/// Where a craft at `(x, z)` overlaps `obstacle`: the obstacle's surface
/// point (or centre, for a round one), the outward direction and its length,
/// and how far from that point the craft's centre must be. `None` when they
/// do not overlap.
fn contact(obstacle: Obstacle, x: i32, z: i32) -> Option<(i32, i32, i32, i32, i32, i32)> {
    let ((nx, nz), own) = obstacle.nearest(x, z);
    let reach = CRAFT_RADIUS + own;
    let (ux, uz) = (x - nx, z - nz);
    let distance = length(ux, uz);
    if distance >= reach {
        return None;
    }
    if distance > 0 {
        return Some((nx, nz, ux, uz, distance, reach));
    }
    match obstacle {
        // The centre is inside the box: out through the nearest face.
        Obstacle::Box {
            x: cx,
            z: cz,
            half_x,
            half_z,
        } => {
            let (gap_x, gap_z) = (half_x - (x - cx).abs(), half_z - (z - cz).abs());
            let (sx, sz) = (if x >= cx { 1 } else { -1 }, if z >= cz { 1 } else { -1 });
            Some(if gap_x <= gap_z {
                (cx + sx * half_x, z, sx, 0, 1, reach)
            } else {
                (x, cz + sz * half_z, 0, sz, 1, reach)
            })
        }
        Obstacle::Round { .. } => Some((nx, nz, 1, 0, 1, reach)),
    }
}
