//! Rebuilding a world from the ticks a crashed sim left in the log.

use super::{Hidden, MAX_CRAFTS, Phase, RESPAWN_AFTER, Rules, SPAWN_PROTECTION, World};
use crate::tick::{Event, Player, Tick};

impl World {
    /// The world a replacement sim carries on from: the state of the last of
    /// `after`, or of `keyframe` when none follows it. `after` holds the ticks
    /// since the keyframe in order.
    ///
    /// The ticks carry everything but the roster's kills and deaths, which
    /// the keyframe holds and the events since it update, and a few timers the
    /// sim keeps to itself: those start over, so a craft's health regenerates
    /// late, a dead craft waits out its respawn again and a shield is full.
    /// Answers `None` when `keyframe` has no roster.
    pub fn recover(rules: Rules, keyframe: &Tick, after: &[Tick]) -> Option<World> {
        let mut players = keyframe.keyframe.as_ref()?.players.clone();
        let mut phase = keyframe.state.phase;
        for tick in after {
            // A new warmup or match starts everyone at nothing, after the
            // step's kills, so the kills in that tick do not count.
            let fresh = tick.state.phase != phase && tick.state.phase != Phase::Results;
            phase = tick.state.phase;
            if fresh {
                for player in &mut players {
                    (player.kills, player.deaths) = (0, 0);
                }
            }
            for event in &tick.events {
                match *event {
                    Event::Joined { slot, team, key } => {
                        players.retain(|p| p.slot != slot);
                        players.push(Player {
                            slot,
                            team,
                            key,
                            kills: 0,
                            deaths: 0,
                        });
                    }
                    Event::Left { slot } => players.retain(|p| p.slot != slot),
                    Event::Killed { victim, killer, .. } if !fresh => {
                        for player in &mut players {
                            if player.slot == victim {
                                player.deaths += 1;
                            } else if player.slot == killer {
                                player.kills += 1;
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        players.sort_by_key(|p| p.slot);
        let last = after.last().unwrap_or(keyframe);
        let mut hidden = [Hidden::default(); MAX_CRAFTS];
        for craft in &last.crafts {
            let slot = usize::from(craft.slot);
            if slot >= MAX_CRAFTS {
                return None;
            }
            hidden[slot] = Hidden {
                since_damage: 0,
                respawn_in: if craft.alive { 0 } else { RESPAWN_AFTER },
                protected_for: if craft.protected { SPAWN_PROTECTION } else { 0 },
            };
        }
        Some(World {
            match_number: last.match_number,
            tick: last.tick,
            crafts: last.crafts.clone(),
            hidden,
            players,
            bolts: last.bolts.clone(),
            next_bolt: last
                .bolts
                .iter()
                .map(|b| b.id)
                .max()
                .map_or(0, |id| id.wrapping_add(1)),
            rules,
            state: last.state,
            events: Vec::new(),
            pending: Vec::new(),
        })
    }
}
