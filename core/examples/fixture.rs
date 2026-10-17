//! Prints tick records from a scripted busy match and their hashes, as JSON,
//! for the web tests to decode with the WebAssembly build and compare. After
//! a while of wandering, everyone hunts the nearest enemy, so the records
//! include kills, respawns and spawn protection.

use felix_arena_core::{Craft, Input, Rules, Timing, World, player_key};

fn main() {
    // A warmup that outlasts the run, so no match start resets the crafts.
    let mut world = World::with_rules(
        2,
        Rules {
            warmup: u16::MAX,
            ..Rules::default()
        },
    );
    for i in 0..8 {
        world.join(player_key(&format!("player-{i}")));
    }
    let mut seed: u32 = 7;
    let mut next = move || {
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        seed >> 8
    };
    let mut records = Vec::new();
    for t in 1..=480u32 {
        let crafts = world.crafts().to_vec();
        let inputs: Vec<Input> = (0..8u16)
            .map(|i| {
                let random = Input {
                    seq: t as u16 + i,
                    move_x: (next() % 255) as u8 as i8,
                    move_z: (next() % 255) as u8 as i8,
                    aim: next() as u16,
                    buttons: (next() % 4) as u8,
                };
                match crafts.iter().find(|c| u16::from(c.slot) == i) {
                    Some(me) if t > 150 => hunt(me, &crafts).unwrap_or(random),
                    _ => random,
                }
            })
            .collect();
        world.step(|slot| Some(inputs[usize::from(slot)]));
        let tick = world.snapshot(1);
        let protected = tick.crafts.iter().any(|c| c.protected);
        if tick.is_keyframe() || t % 7 == 0 || (protected && t % 3 == 0) {
            let timing = Timing {
                commit_start_us: 1_760_000_000_000_000 + u64::from(t) * 33_333,
                step_us: t,
                previous_commit_us: 2 * t,
            };
            let hex: String = tick
                .encode(Some(&timing))
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            records.push(format!(
                "  {{\"tick\": {}, \"record\": \"{hex}\", \"hash\": \"{:016x}\"}}",
                tick.tick,
                tick.hash()
            ));
        }
    }
    println!("[\n{}\n]", records.join(",\n"));
}

/// Close on the nearest live enemy and fire at it. The fixture runs only
/// natively, so floating point is fine here.
fn hunt(me: &Craft, crafts: &[Craft]) -> Option<Input> {
    let (x, z) = (f64::from(me.x), f64::from(me.z));
    let enemy = crafts
        .iter()
        .filter(|c| c.alive && c.team != me.team)
        .min_by_key(|c| (f64::from(c.x) - x).hypot(f64::from(c.z) - z) as i64)?;
    let (dx, dz) = (f64::from(enemy.x) - x, f64::from(enemy.z) - z);
    let length = dx.hypot(dz).max(1.0);
    let aim = (dz.atan2(dx) / std::f64::consts::TAU * 65536.0).round() as i64 as u16;
    Some(Input {
        seq: me.last_input.wrapping_add(1),
        move_x: (dx / length * 127.0) as i8,
        move_z: (dz / length * 127.0) as i8,
        aim,
        buttons: 1,
    })
}
