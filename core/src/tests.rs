use std::time::{Duration, Instant};

use crate::input::{BOOST, FIRE};
use crate::world::{BOLT_DAMAGE, MAX_HEALTH, RESPAWN_AFTER};
use crate::{Event, Input, Team, Tick, Timing, World, player_key};

/// A fixed pseudo-random sequence, so tests are repeatable without a crate.
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u32 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) as u32
    }
}

/// A busy arena: eight players wandering and firing, after `ticks` steps.
fn busy(ticks: u32, seed: u64) -> World {
    let mut world = World::new(1);
    for i in 0..8 {
        world.join(player_key(&format!("player-{i}")));
    }
    let mut rng = Lcg(seed);
    for _ in 0..ticks {
        let inputs: Vec<Input> = (0..8)
            .map(|_| Input {
                seq: 0,
                move_x: (rng.next() % 255) as i32 as i8,
                move_z: (rng.next() % 255) as i32 as i8,
                aim: rng.next() as u16,
                buttons: (rng.next() % 4) as u8,
            })
            .collect();
        world.step(|slot| Some(inputs[usize::from(slot)]));
    }
    world
}

#[test]
fn a_tick_round_trips_through_its_record() {
    for seed in 0..20 {
        let world = busy(40 + seed as u32, seed);
        let tick = world.snapshot(3);
        let timing = Timing {
            commit_start_us: 1_700_000_000_000_000 + seed,
            step_us: 40,
            previous_commit_us: 2500,
        };
        let record = tick.encode(Some(&timing));
        assert_eq!(Tick::decode(&record), Some((tick.clone(), Some(timing))));
        assert_eq!(Tick::decode(&tick.encode(None)), Some((tick.clone(), None)));
        assert_eq!(Timing::of(&record), Some(timing));
        assert_eq!(crate::tick::tick_number(&record), Some(tick.tick));
        assert!(Tick::decode(&record[..record.len() - 1]).is_none());
        let mut longer = record.clone();
        longer.push(0);
        assert!(Tick::decode(&longer).is_none());
    }
}

#[test]
fn the_header_matches_the_design() {
    let mut world = World::new(3);
    for _ in 0..30 {
        world.step(|_| None);
    }
    let tick = world.snapshot(7);
    assert!(tick.is_keyframe());
    let record = tick.encode(Some(&Timing {
        commit_start_us: 1,
        step_us: 2,
        previous_commit_us: 3,
    }));
    assert_eq!(record[..12], [7, 0, 3, 0, 3, 0, 0, 0, 30, 0, 0, 0]);
    assert_eq!(
        record[12..28],
        [1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0]
    );
}

#[test]
fn a_busy_tick_fits_the_design_budget() {
    let world = busy(45, 1);
    let tick = world.snapshot(0);
    let bytes = tick.encode(None).len();
    assert!(
        bytes <= 16 + 8 * 16 + tick.bolts.len() * 9 + 5 + tick.events.len() * 11,
        "{bytes}"
    );
    assert!(!tick.bolts.is_empty());
}

#[test]
fn the_same_inputs_give_the_same_state() {
    assert_eq!(
        busy(200, 9).snapshot(0).hash(),
        busy(200, 9).snapshot(0).hash()
    );
    assert_ne!(
        busy(200, 9).snapshot(0).hash(),
        busy(200, 10).snapshot(0).hash()
    );
}

#[test]
fn players_split_into_teams_and_the_ninth_is_refused() {
    let mut world = World::new(0);
    let slots: Vec<_> = (0..8)
        .map(|i| world.join(player_key(&i.to_string())).unwrap())
        .collect();
    assert_eq!(slots, [0, 1, 2, 3, 4, 5, 6, 7]);
    let violet = world
        .crafts()
        .iter()
        .filter(|c| c.team == Team::Violet)
        .count();
    assert_eq!(violet, 4);
    assert_eq!(world.join(player_key("8")), None);
    assert_eq!(world.join(player_key("3")), Some(3));
    world.leave(3);
    assert_eq!(world.join(player_key("8")), Some(3));
}

#[test]
fn a_craft_moves_with_its_stick_and_stops_at_a_wall() {
    let mut world = World::new(0);
    world.join(1);
    let start = world.crafts()[0];
    let right = Input {
        seq: 1,
        move_x: 127,
        move_z: 0,
        aim: 0,
        buttons: 0,
    };
    for _ in 0..30 {
        world.step(|_| Some(right));
    }
    let after = world.crafts()[0];
    // Full speed after five ticks: a little under 8 m in the first second.
    assert!(
        (700..800).contains(&(after.x - start.x)),
        "{} cm",
        after.x - start.x
    );
    assert_eq!(after.vx, 800);
    assert_eq!(after.last_input, 1);
    let left = Input {
        move_x: -127,
        ..right
    };
    for _ in 0..90 {
        world.step(|_| Some(left));
    }
    let craft = world.crafts()[0];
    assert_eq!(
        i32::from(craft.x),
        -crate::arena::HALF_X + crate::CRAFT_RADIUS
    );
    assert_eq!(craft.vx, 0);
}

#[test]
fn cover_blocks_a_craft() {
    // Coral's second craft spawns at (-17.5, 2) m; cover stands at x -12.5 m
    // from z -1.5 to 4.5 m.
    let mut world = World::new(0);
    for key in 1..=3 {
        world.join(key);
    }
    let right = Input {
        seq: 1,
        move_x: 127,
        move_z: 0,
        aim: 0,
        buttons: 0,
    };
    let mut sliding = world.clone();
    for _ in 0..60 {
        world.step(|_| Some(right));
    }
    let craft = world.crafts()[2];
    assert_eq!(
        i32::from(craft.x),
        -1250 - 50 - crate::CRAFT_RADIUS,
        "{craft:?}"
    );
    assert_eq!(craft.vx, 0);
    // Moving up and right slides along the cover instead of stopping.
    let diagonal = Input {
        move_z: 127,
        ..right
    };
    for _ in 0..60 {
        sliding.step(|_| Some(diagonal));
    }
    assert!(sliding.crafts()[2].z > 450, "{:?}", sliding.crafts()[2]);
}

#[test]
fn a_boost_dashes_and_cools_down() {
    let mut world = World::new(0);
    world.join(1);
    let boost = Input {
        seq: 1,
        move_x: 0,
        move_z: 127,
        aim: 0,
        buttons: BOOST,
    };
    world.step(|_| Some(boost));
    assert_eq!(world.crafts()[0].vz, 2000);
    assert_eq!(world.crafts()[0].boost_cooldown, 90);
    world.step(|_| Some(boost));
    assert!(world.crafts()[0].vz < 2000);
}

#[test]
fn bolts_hit_damage_and_kill() {
    let mut world = World::new(0);
    world.join(1); // Coral, at (-17.5, -2) m
    world.join(2); // Violet, at (17.5, 2) m
    // Put both in open floor along z = 12.5 m, facing each other 6 m apart.
    let place = |world: &mut World, slot: usize, x: i16| {
        let mut craft = world.crafts()[slot];
        (craft.x, craft.z) = (x, 1250);
        world.crafts_mut()[slot] = craft;
    };
    place(&mut world, 0, -300);
    place(&mut world, 1, 300);
    let fire = Input {
        seq: 1,
        move_x: 0,
        move_z: 0,
        aim: 0,
        buttons: FIRE,
    };
    let mut hits = 0;
    let mut killed = false;
    for _ in 0..400 {
        world.step(|slot| (slot == 0).then_some(fire));
        let tick = world.snapshot(0);
        for event in &tick.events {
            match event {
                Event::Hit {
                    target: 1,
                    attacker: 0,
                    damage,
                    ..
                } => {
                    assert_eq!(*damage, BOLT_DAMAGE.min(world_health_before(hits)));
                    hits += 1;
                }
                Event::Killed {
                    victim: 1,
                    killer: 0,
                } => killed = true,
                _ => {}
            }
        }
        if killed {
            break;
        }
    }
    assert!(killed);
    assert_eq!(hits, usize::from(MAX_HEALTH.div_ceil(BOLT_DAMAGE)));
    let victim = world.crafts()[1];
    assert!(!victim.alive);
    let keyframe_scores = |world: &World| {
        let mut w = world.clone();
        while !w.snapshot(0).is_keyframe() {
            w.step(|_| None);
        }
        w.snapshot(0).keyframe.unwrap().scores
    };
    assert_eq!(keyframe_scores(&world), [1, 0]);
    for _ in 0..RESPAWN_AFTER {
        world.step(|_| None);
    }
    assert!(world.crafts()[1].alive);
    assert_eq!(world.crafts()[1].health, MAX_HEALTH);
}

fn world_health_before(hits: usize) -> u8 {
    MAX_HEALTH - (hits as u8) * BOLT_DAMAGE
}

#[test]
fn a_quiet_player_coasts_to_a_stop() {
    let mut world = World::new(0);
    world.join(1);
    let up = Input {
        seq: 1,
        move_x: 0,
        move_z: 127,
        aim: 0,
        buttons: 0,
    };
    for _ in 0..10 {
        world.step(|_| Some(up));
    }
    world.step(|_| None);
    assert_eq!(world.crafts()[0].vz, 800 - 30);
    for _ in 0..40 {
        world.step(|_| None);
    }
    assert_eq!(world.crafts()[0].vz, 0);
}

/// The design's budget is 2 ms for 8 players and 64 bolts. This checks it
/// loosely, in whatever profile the tests run.
#[test]
fn a_step_with_eight_players_and_64_bolts_is_well_under_2_ms() {
    let mut world = busy(0, 3);
    let mut rng = Lcg(5);
    let mut slowest = Duration::ZERO;
    let mut steps = 0;
    let started = Instant::now();
    while steps < 300 {
        let aim = rng.next() as u16;
        let input = Input {
            seq: 0,
            move_x: 0,
            move_z: 0,
            aim,
            buttons: FIRE,
        };
        world.fill_bolts(64);
        let at = Instant::now();
        world.step(|_| Some(input));
        let tick = world.snapshot(0);
        std::hint::black_box(tick.encode(None));
        slowest = slowest.max(at.elapsed());
        steps += 1;
    }
    let mean = started.elapsed() / steps;
    assert!(
        mean < Duration::from_millis(1),
        "mean {mean:?}, slowest {slowest:?}"
    );
}
