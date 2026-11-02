use felix_arena_core::{Rules, Tick, World};

use super::rebuild;

/// Ticks 1 to `n` of a two-player world written under `epoch`.
fn written(epoch: u16, from: u32, n: u32) -> Vec<Tick> {
    let mut world = World::with_rules(
        0,
        Rules {
            warmup: u16::MAX,
            ..Rules::default()
        },
    );
    world.join(1);
    world.join(2);
    (0..n)
        .map(|_| {
            world.step(|_| None);
            world.snapshot(epoch)
        })
        .skip_while(|tick| tick.tick < from)
        .collect()
}

#[test]
fn resumes_from_the_tail_one_epoch_on() {
    let ticks = written(3, 1, 75);
    let recovered = rebuild(Rules::default(), ticks);
    assert_eq!(recovered.epoch, 4);
    assert_eq!(recovered.world.unwrap().tick(), 75);
}

#[test]
fn ticks_of_an_older_epoch_and_repeats_are_ignored() {
    // A stale sim's ticks reach past the new one's, and one commit landed twice.
    let mut ticks = written(1, 1, 100);
    let mut newer = written(2, 1, 70);
    newer.insert(41, newer[40].clone());
    ticks.splice(0..0, newer);
    let recovered = rebuild(Rules::default(), ticks);
    assert_eq!(recovered.epoch, 3);
    assert_eq!(recovered.world.unwrap().tick(), 70);
}

#[test]
fn a_tail_with_no_keyframe_still_moves_the_epoch_on() {
    let recovered = rebuild(Rules::default(), written(5, 1, 20));
    assert_eq!(recovered.epoch, 6);
    assert!(recovered.world.is_none());
}

#[test]
fn an_empty_log_starts_fresh() {
    let recovered = rebuild(Rules::default(), Vec::new());
    assert_eq!(recovered.epoch, 0);
    assert!(recovered.world.is_none());
}
