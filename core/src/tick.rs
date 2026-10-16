//! The tick record: what the sim commits each tick and every reader decodes.
//! The layout is the table in docs/design.md, "Ticks are commits". All
//! numbers are little-endian.

use crate::world::{MAX_HEALTH, Phase, Team};

/// One tick: the whole dynamic state of the match, so any single tick can be
/// drawn without the ones before it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Tick {
    /// Which run of the simulation wrote the tick; a restart takes the next.
    pub epoch: u16,
    pub match_number: u32,
    pub tick: u32,
    /// Where the match is, carried by every tick so any one can be drawn.
    pub state: MatchState,
    /// In slot order.
    pub crafts: Vec<Craft>,
    pub bolts: Vec<Bolt>,
    /// What happened in the step that made this tick.
    pub events: Vec<Event>,
    /// Present on a keyframe.
    pub keyframe: Option<Keyframe>,
}

/// When the sim stepped and committed a tick, for timing each hop of its way
/// to the browser. It is not part of the state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    /// When the tick's commit started: microseconds since the Unix epoch on
    /// the sim's clock.
    pub commit_start_us: u64,
    /// From the tick falling due to its commit starting: the sim's step.
    pub step_us: u32,
    /// How long the previous tick's commit took to be answered, or 0 when it
    /// failed or there was none. A tick cannot carry its own.
    pub previous_commit_us: u32,
}

/// The match's clock, score and pickup, 9 bytes on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MatchState {
    pub phase: Phase,
    /// Ticks left in the phase. A warmup waiting for players holds at its
    /// full length.
    pub left: u16,
    /// Kills by team: Coral, then Violet.
    pub scores: [u16; 2],
    /// Ticks until a rail appears on the centre crystal, or 0 while one is
    /// there.
    pub rail_in: u16,
}

/// One craft, 17 bytes on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Craft {
    pub slot: u8,
    pub team: Team,
    pub alive: bool,
    /// Ticks until the weapon can fire again, at most 31.
    pub fire_cooldown: u8,
    /// Centimetres from the arena's centre.
    pub x: i16,
    pub z: i16,
    /// Centimetres a second.
    pub vx: i16,
    pub vz: i16,
    /// 65536 is a full turn, 0 faces +x and a quarter turn +z.
    pub heading: u16,
    pub health: u8,
    /// Ticks until the boost can be used again.
    pub boost_cooldown: u8,
    /// The sequence number of the last input applied to this craft.
    pub last_input: u16,
    /// Rail shots left, at most 3.
    pub rail: u8,
    /// Ticks until a charging rail fires, or 0 when none is charging.
    pub charge: u8,
}

/// A blaster bolt in flight, 9 bytes on the wire. It moves at the bolt speed
/// along its heading.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bolt {
    pub id: u16,
    /// The slot that fired it.
    pub owner: u8,
    pub x: i16,
    pub z: i16,
    pub heading: u16,
}

/// Something that happened in a tick. It is carried in the tick it happened
/// in, so it can never be seen apart from the state it describes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    /// A player joined and has this slot. `key` is [`player_key`] of its
    /// Felix principal.
    Joined {
        slot: u8,
        team: Team,
        key: u64,
    },
    Left {
        slot: u8,
    },
    /// A craft came back after its respawn wait.
    Spawned {
        slot: u8,
    },
    /// `slot` fired `bolt` with input `seq`, which is how a client matches
    /// the sim's bolt to the one it predicted.
    Fired {
        slot: u8,
        bolt: u16,
        seq: u16,
    },
    Hit {
        target: u8,
        attacker: u8,
        bolt: u16,
        damage: u8,
    },
    Killed {
        victim: u8,
        killer: u8,
    },
    /// `slot` took the rail from the centre crystal.
    PickedUp {
        slot: u8,
    },
    /// `slot` fired the rail, whose beam ended at `(x, z)`: on `target`, or
    /// on the arena when `target` is `None`.
    Railed {
        slot: u8,
        target: Option<u8>,
        x: i16,
        z: i16,
    },
}

/// What only a keyframe carries.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Keyframe {
    /// In slot order.
    pub players: Vec<Player>,
}

/// One player on the roster, 14 bytes on the wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Player {
    pub slot: u8,
    pub team: Team,
    /// [`player_key`] of the player's Felix principal.
    pub key: u64,
    pub kills: u16,
    pub deaths: u16,
}

/// A 64-bit key for a Felix principal: its FNV-1a hash. Ticks name players by
/// it, so a client finds its own craft without the tick carrying principals.
pub fn player_key(principal: &str) -> u64 {
    fnv(principal.as_bytes())
}

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

const HEADER_LEN: usize = 12;
const TIMING_LEN: usize = 16;
const KEYFRAME: u8 = 1;
const TIMED: u8 = 2;
const ALIVE: u8 = 1;
const VIOLET: u8 = 2;
const FIRE_SHIFT: u8 = 3;
const CHARGE_SHIFT: u8 = 2;
/// A railed event's target when the beam hit no craft.
const NO_TARGET: u8 = 255;

impl Craft {
    pub(crate) fn spawned(slot: u8, team: Team, x: i16, z: i16, heading: u16) -> Self {
        Self {
            slot,
            team,
            alive: true,
            fire_cooldown: 0,
            x,
            z,
            vx: 0,
            vz: 0,
            heading,
            health: MAX_HEALTH,
            boost_cooldown: 0,
            last_input: 0,
            rail: 0,
            charge: 0,
        }
    }
}

impl Tick {
    pub fn is_keyframe(&self) -> bool {
        self.keyframe.is_some()
    }

    /// The tick record, with `timing` after the header when given.
    pub fn encode(&self, timing: Option<&Timing>) -> Vec<u8> {
        let mut out = Vec::with_capacity(64 + self.crafts.len() * 16 + self.bolts.len() * 9);
        out.extend_from_slice(&self.epoch.to_le_bytes());
        out.push(
            if self.is_keyframe() { KEYFRAME } else { 0 }
                | if timing.is_some() { TIMED } else { 0 },
        );
        out.push(0);
        out.extend_from_slice(&self.match_number.to_le_bytes());
        out.extend_from_slice(&self.tick.to_le_bytes());
        if let Some(timing) = timing {
            out.extend_from_slice(&timing.commit_start_us.to_le_bytes());
            out.extend_from_slice(&timing.step_us.to_le_bytes());
            out.extend_from_slice(&timing.previous_commit_us.to_le_bytes());
        }
        out.push(self.state.phase as u8);
        out.extend_from_slice(&self.state.left.to_le_bytes());
        for score in self.state.scores {
            out.extend_from_slice(&score.to_le_bytes());
        }
        out.extend_from_slice(&self.state.rail_in.to_le_bytes());
        out.push(u8::try_from(self.crafts.len()).expect("at most 255 crafts"));
        for craft in &self.crafts {
            out.push(craft.slot);
            let alive = if craft.alive { ALIVE } else { 0 };
            let violet = if craft.team == Team::Violet {
                VIOLET
            } else {
                0
            };
            out.push(alive | violet | (craft.fire_cooldown.min(31) << FIRE_SHIFT));
            for value in [craft.x, craft.z, craft.vx, craft.vz] {
                out.extend_from_slice(&value.to_le_bytes());
            }
            out.extend_from_slice(&craft.heading.to_le_bytes());
            out.push(craft.health);
            out.push(craft.boost_cooldown);
            out.extend_from_slice(&craft.last_input.to_le_bytes());
            out.push(craft.rail.min(3) | (craft.charge.min(31) << CHARGE_SHIFT));
        }
        out.extend_from_slice(
            &u16::try_from(self.bolts.len())
                .expect("at most 65535 bolts")
                .to_le_bytes(),
        );
        for bolt in &self.bolts {
            out.extend_from_slice(&bolt.id.to_le_bytes());
            out.push(bolt.owner);
            out.extend_from_slice(&bolt.x.to_le_bytes());
            out.extend_from_slice(&bolt.z.to_le_bytes());
            out.extend_from_slice(&bolt.heading.to_le_bytes());
        }
        out.extend_from_slice(
            &u16::try_from(self.events.len())
                .expect("at most 65535 events")
                .to_le_bytes(),
        );
        for event in &self.events {
            event.encode(&mut out);
        }
        if let Some(keyframe) = &self.keyframe {
            out.push(u8::try_from(keyframe.players.len()).expect("at most 255 players"));
            for player in &keyframe.players {
                out.push(player.slot);
                out.push(team_byte(player.team));
                out.extend_from_slice(&player.key.to_le_bytes());
                out.extend_from_slice(&player.kills.to_le_bytes());
                out.extend_from_slice(&player.deaths.to_le_bytes());
            }
        }
        out
    }

    /// The tick in `bytes` and its timing block, or `None` when `bytes` is
    /// not exactly one tick record.
    pub fn decode(bytes: &[u8]) -> Option<(Tick, Option<Timing>)> {
        let mut r = Reader(bytes);
        let epoch = r.u16()?;
        let flags = r.u8()?;
        // Unknown bits would mean a layout this decoder cannot read.
        if flags & !(KEYFRAME | TIMED) != 0 || r.u8()? != 0 {
            return None;
        }
        let match_number = r.u32()?;
        let tick = r.u32()?;
        let timing = if flags & TIMED != 0 {
            Some(Timing {
                commit_start_us: r.u64()?,
                step_us: r.u32()?,
                previous_commit_us: r.u32()?,
            })
        } else {
            None
        };
        let state = MatchState {
            phase: Phase::from_byte(r.u8()?)?,
            left: r.u16()?,
            scores: [r.u16()?, r.u16()?],
            rail_in: r.u16()?,
        };
        let crafts = (0..r.u8()?)
            .map(|_| {
                let slot = r.u8()?;
                let flags = r.u8()?;
                if flags & !(ALIVE | VIOLET | 31 << FIRE_SHIFT) != 0 {
                    return None;
                }
                Some(Craft {
                    slot,
                    alive: flags & ALIVE != 0,
                    team: if flags & VIOLET != 0 {
                        Team::Violet
                    } else {
                        Team::Coral
                    },
                    fire_cooldown: flags >> FIRE_SHIFT,
                    x: r.i16()?,
                    z: r.i16()?,
                    vx: r.i16()?,
                    vz: r.i16()?,
                    heading: r.u16()?,
                    health: r.u8()?,
                    boost_cooldown: r.u8()?,
                    last_input: r.u16()?,
                    rail: 0,
                    charge: 0,
                })
                .and_then(|mut craft| {
                    let rail = r.u8()?;
                    if rail >> CHARGE_SHIFT > 31 {
                        return None;
                    }
                    (craft.rail, craft.charge) = (rail & 3, rail >> CHARGE_SHIFT);
                    Some(craft)
                })
            })
            .collect::<Option<Vec<_>>>()?;
        let bolts = (0..r.u16()?)
            .map(|_| {
                Some(Bolt {
                    id: r.u16()?,
                    owner: r.u8()?,
                    x: r.i16()?,
                    z: r.i16()?,
                    heading: r.u16()?,
                })
            })
            .collect::<Option<Vec<_>>>()?;
        let events = (0..r.u16()?)
            .map(|_| Event::decode(&mut r))
            .collect::<Option<Vec<_>>>()?;
        let keyframe = if flags & KEYFRAME != 0 {
            let players = (0..r.u8()?)
                .map(|_| {
                    Some(Player {
                        slot: r.u8()?,
                        team: team(r.u8()?)?,
                        key: r.u64()?,
                        kills: r.u16()?,
                        deaths: r.u16()?,
                    })
                })
                .collect::<Option<Vec<_>>>()?;
            Some(Keyframe { players })
        } else {
            None
        };
        if !r.0.is_empty() {
            return None;
        }
        Some((
            Tick {
                epoch,
                match_number,
                tick,
                state,
                crafts,
                bolts,
                events,
                keyframe,
            },
            timing,
        ))
    }

    /// A hash of the state, the same wherever the tick is decoded. Timing is
    /// left out: it describes the commit, not the match.
    pub fn hash(&self) -> u64 {
        fnv(&self.encode(None))
    }
}

/// The tick number in a record's header, without decoding the rest.
pub fn tick_number(record: &[u8]) -> Option<u32> {
    Some(u32::from_le_bytes(
        record.get(8..HEADER_LEN)?.try_into().ok()?,
    ))
}

impl Timing {
    /// The timing block of a record, if it has one.
    pub fn of(record: &[u8]) -> Option<Self> {
        if record.get(2)? & TIMED == 0 {
            return None;
        }
        let mut r = Reader(record.get(HEADER_LEN..HEADER_LEN + TIMING_LEN)?);
        Some(Timing {
            commit_start_us: r.u64()?,
            step_us: r.u32()?,
            previous_commit_us: r.u32()?,
        })
    }
}

impl Event {
    fn encode(&self, out: &mut Vec<u8>) {
        match *self {
            Event::Joined { slot, team, key } => {
                out.extend_from_slice(&[1, slot, team_byte(team)]);
                out.extend_from_slice(&key.to_le_bytes());
            }
            Event::Left { slot } => out.extend_from_slice(&[2, slot]),
            Event::Spawned { slot } => out.extend_from_slice(&[3, slot]),
            Event::Fired { slot, bolt, seq } => {
                out.extend_from_slice(&[4, slot]);
                out.extend_from_slice(&bolt.to_le_bytes());
                out.extend_from_slice(&seq.to_le_bytes());
            }
            Event::Hit {
                target,
                attacker,
                bolt,
                damage,
            } => {
                out.extend_from_slice(&[5, target, attacker]);
                out.extend_from_slice(&bolt.to_le_bytes());
                out.push(damage);
            }
            Event::Killed { victim, killer } => out.extend_from_slice(&[6, victim, killer]),
            Event::PickedUp { slot } => out.extend_from_slice(&[7, slot]),
            Event::Railed { slot, target, x, z } => {
                out.extend_from_slice(&[8, slot, target.unwrap_or(NO_TARGET)]);
                out.extend_from_slice(&x.to_le_bytes());
                out.extend_from_slice(&z.to_le_bytes());
            }
        }
    }

    fn decode(r: &mut Reader<'_>) -> Option<Self> {
        Some(match r.u8()? {
            1 => Event::Joined {
                slot: r.u8()?,
                team: team(r.u8()?)?,
                key: r.u64()?,
            },
            2 => Event::Left { slot: r.u8()? },
            3 => Event::Spawned { slot: r.u8()? },
            4 => Event::Fired {
                slot: r.u8()?,
                bolt: r.u16()?,
                seq: r.u16()?,
            },
            5 => Event::Hit {
                target: r.u8()?,
                attacker: r.u8()?,
                bolt: r.u16()?,
                damage: r.u8()?,
            },
            6 => Event::Killed {
                victim: r.u8()?,
                killer: r.u8()?,
            },
            7 => Event::PickedUp { slot: r.u8()? },
            8 => Event::Railed {
                slot: r.u8()?,
                target: Some(r.u8()?).filter(|t| *t != NO_TARGET),
                x: r.i16()?,
                z: r.i16()?,
            },
            _ => return None,
        })
    }
}

fn team_byte(team: Team) -> u8 {
    match team {
        Team::Coral => 0,
        Team::Violet => 1,
    }
}

fn team(byte: u8) -> Option<Team> {
    match byte {
        0 => Some(Team::Coral),
        1 => Some(Team::Violet),
        _ => None,
    }
}

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
        let (head, rest) = self.0.split_first_chunk::<N>()?;
        self.0 = rest;
        Some(*head)
    }
    fn u8(&mut self) -> Option<u8> {
        Some(self.take::<1>()?[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take().map(u16::from_le_bytes)
    }
    fn i16(&mut self) -> Option<i16> {
        self.take().map(i16::from_le_bytes)
    }
    fn u32(&mut self) -> Option<u32> {
        self.take().map(u32::from_le_bytes)
    }
    fn u64(&mut self) -> Option<u64> {
        self.take().map(u64::from_le_bytes)
    }
}
