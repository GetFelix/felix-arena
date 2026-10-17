use std::time::{Duration, Instant};

use crate::input::{BOOST, FIRE};
use crate::world::{BOLT_DAMAGE, MAX_HEALTH, RESPAWN_AFTER, SPAWN_PROTECTION, SPAWN_SIGHT};
use crate::{
    CRAFT_RADIUS, Event, Input, Phase, Rules, Team, Tick, Timing, World, bolt_ticks, player_key,
    steer,
};

/// A world whose warmup never ends, for tests of the rules within a match.
fn free_play(match_number: u32) -> World {
    World::with_rules(
        match_number,
        Rules {
            warmup: u16::MAX,
            ..Rules::default()
        },
    )
}

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
    let mut world = free_play(1);
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
    let mut world = free_play(3);
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
        bytes <= 12 + 9 + 1 + 8 * 17 + 2 + tick.bolts.len() * 9 + 2 + tick.events.len() * 11,
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
    let mut world = free_play(0);
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
    let mut world = free_play(0);
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
    let mut world = free_play(0);
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
    let mut world = free_play(0);
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
    let mut world = free_play(0);
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
    assert_eq!(world.snapshot(0).state.scores, [1, 0]);
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
    let mut world = free_play(0);
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

#[test]
fn bolts_pass_through_teammates() {
    let mut world = free_play(0);
    for key in 1..=3 {
        world.join(key); // slots 0 and 2 are Coral
    }
    for (slot, x) in [(0, -300), (2, 300)] {
        let mut craft = world.crafts()[slot];
        (craft.x, craft.z) = (x, 1250);
        world.crafts_mut()[slot] = craft;
    }
    let fire = Input {
        seq: 1,
        move_x: 0,
        move_z: 0,
        aim: 0,
        buttons: FIRE,
    };
    for _ in 0..60 {
        world.step(|slot| (slot == 0).then_some(fire));
        assert!(
            !world
                .snapshot(0)
                .events
                .iter()
                .any(|e| matches!(e, Event::Hit { .. }))
        );
    }
    assert_eq!(world.crafts()[2].health, MAX_HEALTH);
}

#[test]
fn unknown_bits_are_refused() {
    let tick = busy(30, 2).snapshot(0);
    let record = tick.encode(None);
    // The flags, the reserved byte, the phase and the first craft's rail
    // charge. Every bit of a craft's flags has a meaning.
    for (at, bit) in [(2, 4), (3, 1), (12, 4), (38, 128)] {
        let mut changed = record.clone();
        changed[at] |= bit;
        assert!(Tick::decode(&changed).is_none(), "byte {at}");
    }
}

#[test]
fn a_lone_craft_predicted_with_steer_matches_the_world() {
    let mut world = free_play(0);
    world.join(1);
    let mut predicted = world.crafts()[0];
    let mut rng = Lcg(5);
    let mut shots = Vec::new();
    for seq in 1..400u16 {
        let input = Input {
            seq,
            move_x: (rng.next() % 255) as i32 as i8,
            move_z: (rng.next() % 255) as i32 as i8,
            aim: rng.next() as u16,
            buttons: (rng.next() % 4) as u8,
        };
        if let Some(shot) = steer(&mut predicted, Some(input)) {
            shots.push(shot.seq);
        }
        world.step(|_| Some(input));
        assert_eq!(world.crafts()[0], predicted, "input {seq}");
        let fired: Vec<u16> = world
            .snapshot(0)
            .events
            .iter()
            .filter_map(|e| match e {
                Event::Fired { seq, .. } => Some(*seq),
                _ => None,
            })
            .collect();
        assert_eq!(fired, shots.split_off(0), "input {seq}");
    }
}

#[test]
fn bolt_ticks_is_how_long_the_world_keeps_a_bolt_that_meets_no_craft() {
    for aim in (0..=u16::MAX).step_by(4099) {
        let mut world = free_play(0);
        world.join(1);
        let fire = Input {
            seq: 1,
            move_x: 0,
            move_z: 0,
            aim,
            buttons: FIRE,
        };
        let mut craft = world.crafts()[0];
        let shot = steer(&mut craft, Some(fire)).unwrap();
        world.step(|_| Some(fire));
        let mut lived = 0;
        loop {
            world.step(|_| None);
            if world.snapshot(0).bolts.is_empty() {
                break;
            }
            lived += 1;
        }
        assert_eq!(bolt_ticks(shot), lived, "aim {aim}");
    }
}

fn short_rules() -> Rules {
    Rules {
        warmup: 30,
        length: 90,
        results: 20,
        kill_limit: 2,
        rail_every: 10,
    }
}

fn input(seq: u16, move_x: i8, move_z: i8, aim: u16, buttons: u8) -> Input {
    Input {
        seq,
        move_x,
        move_z,
        aim,
        buttons,
    }
}

/// Puts `slot`'s craft at `(x, z)`, at rest.
fn place(world: &mut World, slot: usize, x: i16, z: i16) {
    let craft = &mut world.crafts_mut()[slot];
    (craft.x, craft.z, craft.vx, craft.vz) = (x, z, 0, 0);
}

#[test]
fn the_warmup_waits_for_a_second_player_then_counts_down() {
    let mut world = World::with_rules(4, short_rules());
    world.join(1);
    for _ in 0..100 {
        world.step(|_| None);
    }
    assert_eq!(world.state().phase, Phase::Warmup);
    assert_eq!(world.state().left, 30);
    world.join(2);
    for _ in 0..29 {
        world.step(|_| None);
    }
    assert_eq!(
        (world.state().phase, world.state().left),
        (Phase::Warmup, 1)
    );
    world.step(|_| None);
    assert_eq!(
        (world.state().phase, world.state().left),
        (Phase::Playing, 90)
    );
    assert_eq!(world.snapshot(0).match_number, 4);
}

#[test]
fn a_match_runs_out_of_time_into_results_then_the_next_warmup() {
    let mut world = World::with_rules(4, short_rules());
    world.join(1);
    world.join(2);
    for _ in 0..30 + 90 {
        world.step(|_| None);
    }
    assert_eq!(world.state().phase, Phase::Results);
    // After a match, inputs are ignored and nobody fires.
    let go = input(1, 127, 0, 0, FIRE);
    let before = world.crafts()[0];
    for _ in 0..19 {
        world.step(|_| Some(go));
        assert!(world.snapshot(0).events.is_empty());
    }
    assert_eq!((world.crafts()[0].x, world.crafts()[0].vx), (before.x, 0));
    world.step(|_| None);
    let state = world.state();
    assert_eq!(
        (state.phase, state.left, state.scores),
        (Phase::Warmup, 30, [0, 0])
    );
    assert_eq!(world.snapshot(0).match_number, 5);
}

#[test]
fn the_kill_limit_ends_the_match_and_the_start_clears_the_warmup() {
    let rules = Rules {
        warmup: 120,
        length: 1000,
        ..short_rules()
    };
    let mut world = World::with_rules(0, rules);
    world.join(1);
    world.join(2);
    let kill = |world: &mut World| {
        // Back, and its spawn protection run out.
        while !world.crafts()[1].alive || world.crafts()[1].protected {
            world.step(|_| None);
        }
        place(world, 0, -300, 1250);
        place(world, 1, 300, 1250);
        for _ in 0..100 {
            world.step(|slot| (slot == 0).then_some(input(1, 0, 0, 0, FIRE)));
            if !world.crafts()[1].alive {
                return;
            }
        }
        panic!("no kill");
    };
    kill(&mut world);
    assert_eq!(
        (world.state().phase, world.state().scores),
        (Phase::Warmup, [1, 0])
    );
    while world.state().phase == Phase::Warmup {
        world.step(|_| None);
    }
    // The warmup's kill is forgotten and everyone starts afresh.
    assert_eq!(world.state().scores, [0, 0]);
    assert!(
        world
            .crafts()
            .iter()
            .all(|c| c.alive && c.health == MAX_HEALTH)
    );
    let mut roster = world.clone();
    while !roster.snapshot(0).is_keyframe() {
        roster.step(|_| None);
    }
    let players = roster.snapshot(0).keyframe.unwrap().players;
    assert!(players.iter().all(|p| (p.kills, p.deaths) == (0, 0)));

    kill(&mut world);
    assert_eq!(
        (world.state().phase, world.state().scores),
        (Phase::Playing, [1, 0])
    );
    kill(&mut world);
    assert_eq!(
        (world.state().phase, world.state().scores),
        (Phase::Results, [2, 0])
    );
    assert!(world.snapshot(0).bolts.is_empty());
}

#[test]
fn the_plinth_keeps_crafts_off_the_crystal() {
    let mut world = free_play(0);
    world.join(1);
    place(&mut world, 0, -800, 0);
    for seq in 1..90 {
        world.step(|_| Some(input(seq, 127, 0, 0, 0)));
    }
    let craft = world.crafts()[0];
    let distance = crate::fixed::length(i32::from(craft.x), i32::from(craft.z));
    assert!(distance >= 230 + CRAFT_RADIUS, "{distance}");
}

#[test]
fn the_rail_waits_on_the_crystal_then_goes_to_whoever_touches_it() {
    let mut world = World::with_rules(
        0,
        Rules {
            warmup: u16::MAX,
            ..short_rules()
        },
    );
    world.join(1);
    place(&mut world, 0, -320, 0);
    for _ in 0..9 {
        world.step(|_| None);
        assert_eq!(world.crafts()[0].rail, 0);
    }
    assert_eq!(world.state().rail_in, 1);
    world.step(|_| None);
    assert_eq!(world.state().rail_in, 0);
    world.step(|_| None);
    assert_eq!(world.crafts()[0].rail, 3);
    assert!(
        world
            .snapshot(0)
            .events
            .contains(&Event::PickedUp { slot: 0 })
    );
    assert_eq!(world.state().rail_in, 10);
}

#[test]
fn the_rail_charges_then_beams_through_to_the_first_enemy() {
    let mut world = free_play(0);
    world.join(1);
    world.join(2);
    place(&mut world, 0, -600, 1250);
    place(&mut world, 1, 600, 1250);
    world.crafts_mut()[0].rail = 3;
    let fire = input(1, 0, 0, 0, FIRE);
    world.step(|slot| (slot == 0).then_some(fire));
    assert_eq!(world.crafts()[0].charge, crate::world::RAIL_CHARGE);
    let mut railed = None;
    for _ in 0..crate::world::RAIL_CHARGE {
        world.step(|slot| (slot == 0).then_some(input(1, 0, 0, 0, 0)));
        railed = railed.or(world
            .snapshot(0)
            .events
            .iter()
            .find_map(|e| matches!(e, Event::Railed { .. }).then_some(*e)));
    }
    let Some(Event::Railed {
        slot: 0, target, x, ..
    }) = railed
    else {
        panic!("no rail: {railed:?}");
    };
    assert_eq!(target, Some(1));
    // The beam stops at the target's edge, give or take its reach.
    assert!((450..=600).contains(&x), "{x}");
    assert_eq!(
        world.crafts()[1].health,
        MAX_HEALTH - crate::world::RAIL_DAMAGE
    );
    assert_eq!((world.crafts()[0].rail, world.crafts()[0].charge), (2, 0));
}

#[test]
fn the_rail_stops_at_cover() {
    let mut world = free_play(0);
    world.join(1);
    world.join(2);
    // The cover box at x = -12.5 m, from z = -1.5 - 3 to -1.5 + 3 m, between the two.
    place(&mut world, 0, -1700, -150);
    place(&mut world, 1, -900, -150);
    world.crafts_mut()[0].rail = 1;
    world.step(|slot| (slot == 0).then_some(input(1, 0, 0, 0, FIRE)));
    let mut end = None;
    for _ in 0..crate::world::RAIL_CHARGE {
        world.step(|_| None);
        for e in world.snapshot(0).events {
            if let Event::Railed { target, x, .. } = e {
                end = Some((target, x));
            }
        }
    }
    let (target, x) = end.expect("the rail fired");
    assert_eq!(target, None);
    assert!((-1310..=-1290).contains(&x), "{x}");
    assert_eq!(world.crafts()[1].health, MAX_HEALTH);
}

/// Destroys `slot`'s craft where it is, so it respawns in the next step.
fn wreck(world: &mut World, slot: usize) {
    let craft = &mut world.crafts_mut()[slot];
    (craft.alive, craft.health) = (false, 0);
}

/// The nearest enemy to `point` and whether any enemy within
/// [`SPAWN_SIGHT`] has a clear line to it.
fn exposure(point: (i32, i32), enemies: &[(i32, i32)]) -> (i32, bool) {
    let nearest = enemies
        .iter()
        .map(|e| crate::fixed::length(e.0 - point.0, e.1 - point.1))
        .min()
        .unwrap();
    let seen = enemies.iter().any(|&e| {
        crate::fixed::length(e.0 - point.0, e.1 - point.1) < SPAWN_SIGHT
            && crate::arena::line_of_sight(point, e)
    });
    (nearest, seen)
}

#[test]
fn a_respawn_avoids_an_enemy_camping_the_spawn() {
    let mut world = free_play(0);
    world.join(1); // Coral
    world.join(2); // Violet
    let camp = crate::arena::spawn(Team::Coral, 0);
    place(&mut world, 1, camp.0 as i16, camp.1 as i16);
    wreck(&mut world, 0);
    world.step(|_| None);
    let craft = world.crafts()[0];
    assert!(craft.alive && craft.protected);
    assert!(
        world
            .snapshot(0)
            .events
            .contains(&Event::Spawned { slot: 0 })
    );
    let (nearest, seen) = exposure((craft.x.into(), craft.z.into()), &[camp]);
    assert!(
        nearest >= 1000 && !seen,
        "({}, {}): {nearest} {seen}",
        craft.x,
        craft.z
    );
}

#[test]
fn a_respawn_is_never_close_or_in_sight_when_a_safe_point_exists() {
    const SAFE: i32 = 1000;
    let mut rng = Lcg(5);
    let mut checked = 0;
    for _ in 0..300 {
        let mut world = free_play(0);
        for key in 0..6 {
            world.join(key); // Coral in even slots, Violet in odd ones.
        }
        let mut enemies = Vec::new();
        for slot in [1, 3, 5] {
            let (x, z) = loop {
                let x = (rng.next() % 3800) as i32 - 1900;
                let z = (rng.next() % 2600) as i32 - 1300;
                if crate::arena::OBSTACLES
                    .iter()
                    .all(|o| !o.touches(x, z, CRAFT_RADIUS))
                {
                    break (x, z);
                }
            };
            place(&mut world, slot, x as i16, z as i16);
            enemies.push((x, z));
        }
        let safe = crate::arena::respawn_points(Team::Coral).any(|p| {
            let (nearest, seen) = exposure(p, &enemies);
            nearest >= SAFE && !seen
        });
        let chosen = world.respawn_point(Team::Coral, 0);
        assert!(crate::arena::respawn_points(Team::Coral).any(|p| p == chosen));
        if safe {
            checked += 1;
            let (nearest, seen) = exposure(chosen, &enemies);
            assert!(
                nearest >= SAFE && !seen,
                "{enemies:?} -> {chosen:?}: {nearest} {seen}"
            );
        }
    }
    assert!(checked > 100, "{checked}");
}

#[test]
fn the_same_enemies_give_the_same_respawn_and_the_mirror_for_violet() {
    let mut world = free_play(0);
    for key in 0..4 {
        world.join(key);
    }
    place(&mut world, 0, -1000, 300);
    place(&mut world, 2, -400, -900);
    place(&mut world, 1, 1000, -300);
    place(&mut world, 3, 400, 900);
    let (coral, violet) = (
        world.respawn_point(Team::Coral, 0),
        world.respawn_point(Team::Violet, 0),
    );
    assert_eq!(violet, (-coral.0, -coral.1));
    assert_eq!(world.clone().respawn_point(Team::Coral, 0), coral);
}

#[test]
fn with_no_enemy_alive_a_craft_respawns_at_its_own_spawn() {
    let mut world = free_play(0);
    world.join(1);
    world.join(2);
    wreck(&mut world, 1);
    assert_eq!(
        world.respawn_point(Team::Coral, 0),
        crate::arena::spawn(Team::Coral, 0)
    );
}

/// A world where Coral's craft has just respawned with an enemy 4 m in front
/// of it, on open floor along z = 12.5 m.
fn respawned_under_fire() -> World {
    let mut world = free_play(0);
    world.join(1);
    world.join(2);
    wreck(&mut world, 0);
    world.step(|_| None);
    assert!(world.crafts()[0].protected);
    place(&mut world, 0, -200, 1250);
    place(&mut world, 1, 200, 1250);
    world
}

#[test]
fn spawn_protection_stops_shots_then_runs_out() {
    let mut world = respawned_under_fire();
    let fire = input(1, 0, 0, 32768, FIRE);
    // The respawn tick was the first of the protection.
    for step in 1..SPAWN_PROTECTION {
        world.step(|slot| (slot == 1).then_some(fire));
        let craft = world.crafts()[0];
        assert!(craft.protected, "step {step}");
        assert_eq!(craft.health, MAX_HEALTH, "step {step}");
        assert!(
            !world
                .snapshot(0)
                .events
                .iter()
                .any(|e| matches!(e, Event::Hit { target: 0, .. })),
            "step {step}"
        );
        // Stopped by the shield, not passed through.
        assert!(
            world.snapshot(0).bolts.iter().all(|b| b.x > -150),
            "step {step}"
        );
    }
    world.step(|slot| (slot == 1).then_some(fire));
    assert!(!world.crafts()[0].protected);
    let mut hit = false;
    for _ in 0..10 {
        world.step(|slot| (slot == 1).then_some(fire));
        hit |= world.crafts()[0].health < MAX_HEALTH;
    }
    assert!(hit);
}

#[test]
fn firing_ends_spawn_protection_at_once_in_the_world_and_in_steer() {
    let mut world = respawned_under_fire();
    let mut predicted = world.crafts()[0];
    let fire = input(1, 0, 0, 0, FIRE);
    world.step(|slot| (slot == 0).then_some(fire));
    assert!(steer(&mut predicted, Some(fire)).is_some());
    assert!(!predicted.protected);
    assert!(!world.crafts()[0].protected);
    assert!(
        world
            .snapshot(0)
            .events
            .iter()
            .any(|e| matches!(e, Event::Fired { slot: 0, .. }))
    );
    world.step(|slot| (slot == 1).then_some(input(1, 0, 0, 32768, FIRE)));
    let mut hit = false;
    for _ in 0..10 {
        world.step(|slot| (slot == 1).then_some(input(1, 0, 0, 32768, FIRE)));
        hit |= world.crafts()[0].health < MAX_HEALTH;
    }
    assert!(hit);
}

#[test]
fn spawn_protection_rides_in_the_crafts_flags() {
    let mut world = respawned_under_fire();
    world.step(|_| None);
    let tick = world.snapshot(0);
    assert!(tick.crafts[0].protected && !tick.crafts[1].protected);
    let record = tick.encode(None);
    // Header 12, match 9, the craft count 1, then the first craft's slot.
    assert_eq!(record[23] & 4, 4);
    assert_eq!(record[23 + 17] & 4, 0);
    assert_eq!(Tick::decode(&record), Some((tick, None)));
}
