//! Prints tick records from a scripted busy match and their hashes, as JSON,
//! for the web tests to decode with the WebAssembly build and compare.

use felix_arena_core::{Input, Timing, World, player_key};

fn main() {
    let mut world = World::new(2);
    for i in 0..8 {
        world.join(player_key(&format!("player-{i}")));
    }
    let mut seed: u32 = 7;
    let mut next = move || {
        seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
        seed >> 8
    };
    let mut records = Vec::new();
    for t in 1..=150u32 {
        let inputs: Vec<Input> = (0..8u16)
            .map(|i| Input {
                seq: t as u16 + i,
                move_x: (next() % 255) as u8 as i8,
                move_z: (next() % 255) as u8 as i8,
                aim: next() as u16,
                buttons: (next() % 4) as u8,
            })
            .collect();
        world.step(|slot| Some(inputs[usize::from(slot)]));
        let tick = world.snapshot(1);
        if tick.is_keyframe() || t % 7 == 0 {
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
