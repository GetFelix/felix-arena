use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use tokio::time::{Instant, MissedTickBehavior};
use tracing::{info, warn};

use felix_arena_core::{Rules, Timing, World};

use crate::inputs::{Inbox, Players};
use crate::latency::Window;

/// 30 Hz.
pub(crate) const TICK: Duration = Duration::from_nanos(1_000_000_000 / 30);
const REPORT_EVERY: Duration = Duration::from_secs(5);
/// A commit still unanswered after this is counted as failed, so a hung
/// broker cannot stop the arena's clock or its reports.
const COMMIT_TIMEOUT: Duration = Duration::from_secs(1);
/// The tick record's header: epoch, flags, match and tick number.
const HEADER_LEN: usize = 12;

/// The stream state key a keyframe's commit writes, and the key a match's
/// first tick writes. Each value is the tick record's 12-byte header, and its
/// version is the tick's offset.
pub(crate) const KEYFRAME_KEY: &str = "keyframe";

pub(crate) fn match_key(number: u32) -> String {
    format!("match/{number}")
}

/// Step `arena`'s world on a 30 Hz timer forever with the inputs arriving in
/// `inbox`, handing each tick's record and the state keys it writes to
/// `commit`, which answers with the tick's log offset.
///
/// A commit finishes before the next tick starts, so ticks land in order. A
/// tick that is due while a commit is still running is skipped rather than
/// made up later, so a slow commit never causes a burst of ticks.
pub(crate) async fn run<C, F>(
    arena: String,
    epoch: u16,
    rules: Rules,
    inbox: Arc<Mutex<Inbox>>,
    mut commit: C,
) where
    C: FnMut(Vec<u8>, Vec<(String, Vec<u8>)>) -> F,
    F: Future<Output = Result<u64>>,
{
    let mut timer = tokio::time::interval(TICK);
    timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut world = World::with_rules(0, rules);
    let mut players = Players::default();
    let mut last_due: Option<Instant> = None;
    let mut previous_commit: Option<Duration> = None;
    let mut report = Report::new(Instant::now());
    // The match whose start is committed. A start whose commit failed or
    // timed out is written again with the next tick; a timed-out commit may
    // have landed, so the key can end up a tick late, never missing.
    let mut started_match: Option<u32> = None;
    loop {
        let due = timer.tick().await;
        if let Some(last) = last_due {
            let periods = (due - last).as_nanos() / TICK.as_nanos();
            report.missed += u64::try_from(periods.saturating_sub(1)).unwrap_or(u64::MAX);
        }
        last_due = Some(due);

        let received = {
            let mut inbox = inbox
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            report.refused += std::mem::take(&mut inbox.refused);
            std::mem::take(&mut inbox.received)
        };
        report.inputs += received.len() as u64;
        let controls = players.update(&mut world, received, Instant::now());
        world.step(|slot| controls[usize::from(slot)]);
        let tick = world.snapshot(epoch);
        let started = Instant::now();
        let timing = Timing {
            commit_start_us: unix_micros(),
            step_us: micros(started - due),
            previous_commit_us: previous_commit.map_or(0, micros),
        };
        let record = tick.encode(Some(&timing));
        let header = record[..HEADER_LEN].to_vec();
        let mut keys = Vec::new();
        if tick.is_keyframe() {
            keys.push((KEYFRAME_KEY.to_owned(), header.clone()));
        }
        if started_match != Some(tick.match_number) {
            keys.push((match_key(tick.match_number), header));
        }
        let answer = tokio::time::timeout(COMMIT_TIMEOUT, commit(record, keys))
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("no answer within {COMMIT_TIMEOUT:?}")));
        previous_commit = None;
        match answer {
            Ok(offset) => {
                let took = started.elapsed();
                report.latency.record(took);
                report.offset = Some(offset);
                previous_commit = Some(took);
                started_match = Some(tick.match_number);
                // Readers compare this hash with their own decoding of the tick.
                if tick.is_keyframe() {
                    info!(arena = %arena, epoch, tick = tick.tick, hash = %format!("{:016x}", tick.hash()), offset, "keyframe");
                }
            }
            Err(err) => {
                report.failed += 1;
                warn!(arena = %arena, tick = tick.tick, error = %format!("{err:#}"), "tick commit failed");
            }
        }

        let now = Instant::now();
        if now.duration_since(report.since) >= REPORT_EVERY {
            report.log(&arena, now);
        }
    }
}

fn micros(duration: Duration) -> u32 {
    u32::try_from(duration.as_micros()).unwrap_or(u32::MAX)
}

/// Microseconds since the Unix epoch on this host's clock, which the gateway
/// and the browser compare their own times against.
fn unix_micros() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_micros()).unwrap_or(u64::MAX)
        })
}

/// What one arena did since the last report.
struct Report {
    since: Instant,
    latency: Window,
    missed: u64,
    failed: u64,
    offset: Option<u64>,
    inputs: u64,
    refused: u64,
}

impl Report {
    fn new(since: Instant) -> Self {
        Self {
            since,
            latency: Window::default(),
            missed: 0,
            failed: 0,
            offset: None,
            inputs: 0,
            refused: 0,
        }
    }

    fn log(&mut self, arena: &str, now: Instant) {
        let seconds = now.duration_since(self.since).as_secs_f64();
        let committed = self.latency.len();
        let hz = (committed as f64 / seconds * 10.0).round() / 10.0;
        let ms = |d: Duration| (d.as_secs_f64() * 1e5).round() / 100.0;
        match self.latency.take_summary() {
            Some(summary) => info!(
                arena,
                committed,
                hz,
                p50_ms = ms(summary.p50),
                p99_ms = ms(summary.p99),
                max_ms = ms(summary.max),
                missed = self.missed,
                failed = self.failed,
                offset = self.offset,
                inputs = self.inputs,
                inputs_refused = self.refused,
                "ticks committed"
            ),
            None => warn!(
                arena,
                missed = self.missed,
                failed = self.failed,
                "no ticks committed"
            ),
        }
        *self = Self::new(now);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio::time::Instant;

    use felix_arena_core::{Rules, Tick, Timing};

    use super::{KEYFRAME_KEY, TICK, run};

    /// What the tests read back from a record.
    #[derive(Clone, Copy)]
    struct Header {
        epoch: u16,
        keyframe: bool,
        timed: bool,
        tick: u32,
    }

    fn header(record: &[u8]) -> Header {
        let (tick, timing) = Tick::decode(record).unwrap();
        Header {
            epoch: tick.epoch,
            keyframe: tick.is_keyframe(),
            timed: timing.is_some(),
            tick: tick.tick,
        }
    }

    /// Runs an arena for `length` of paused time, where the commit of tick
    /// `n` takes `latency(n)`, and returns each commit's tick and start.
    async fn commits(
        length: Duration,
        latency: impl Fn(u32) -> Duration + Send + 'static,
    ) -> Vec<(Header, Instant)> {
        keyed_commits(length, move |tick| Ok(latency(tick)))
            .await
            .into_iter()
            .map(|(header, at, _)| (header, at))
            .collect()
    }

    /// As [`commits`], with the state keys each commit wrote; `answer(n)`
    /// failing fails tick `n`'s commit.
    async fn keyed_commits(
        length: Duration,
        answer: impl Fn(u32) -> Result<Duration, ()> + Send + 'static,
    ) -> Vec<(Header, Instant, Vec<(String, Vec<u8>)>)> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let arena = tokio::spawn(run(
            "a".into(),
            1,
            Rules::default(),
            Arc::default(),
            move |record: Vec<u8>, keys: Vec<(String, Vec<u8>)>| {
                let header = header(&record);
                assert_eq!(Timing::of(&record).is_some(), header.timed);
                for (_, value) in &keys {
                    assert_eq!(value[..], record[..12]);
                }
                log.lock().unwrap().push((header, Instant::now(), keys));
                let answer = answer(header.tick);
                async move {
                    let wait = answer.map_err(|()| anyhow::anyhow!("refused"))?;
                    tokio::time::sleep(wait).await;
                    Ok(u64::from(header.tick))
                }
            },
        ));
        tokio::time::sleep(length).await;
        arena.abort();
        seen.lock().unwrap().clone()
    }

    #[tokio::test(start_paused = true)]
    async fn commits_thirty_ticks_a_second_in_order() {
        let seen = commits(Duration::from_secs(1), |_| Duration::from_millis(2)).await;
        assert_eq!(seen.len(), 30);
        for (i, (header, _)) in seen.iter().enumerate() {
            assert_eq!(header.tick, i as u32 + 1);
            assert!(header.timed);
            assert_eq!(header.epoch, 1);
            assert_eq!(header.keyframe, (i + 1) % 30 == 0);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_keyframe_writes_its_key_and_a_match_start_writes_its_own() {
        let seen = keyed_commits(Duration::from_secs(2), |_| Ok(Duration::from_millis(2))).await;
        assert_eq!(seen.len(), 60);
        for (header, _, keys) in &seen {
            let mut expected = Vec::new();
            if header.keyframe {
                expected.push(KEYFRAME_KEY.to_owned());
            }
            if header.tick == 1 {
                expected.push("match/0".to_owned());
            }
            let names: Vec<String> = keys.iter().map(|(name, _)| name.clone()).collect();
            assert_eq!(names, expected, "tick {}", header.tick);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_match_start_whose_commit_failed_is_written_again() {
        let seen = keyed_commits(Duration::from_millis(200), |tick| {
            if tick == 1 {
                Err(())
            } else {
                Ok(Duration::from_millis(2))
            }
        })
        .await;
        let names = |i: usize| -> Vec<&str> { seen[i].2.iter().map(|(n, _)| n.as_str()).collect() };
        assert_eq!(names(0), ["match/0"]);
        assert_eq!(names(1), ["match/0"]);
        assert!(names(2).is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn slow_commit_skips_ticks_instead_of_bursting() {
        let seen = commits(Duration::from_secs(1), |tick| {
            Duration::from_millis(if tick == 4 { 200 } else { 2 })
        })
        .await;
        // The 200 ms commit swallows about six ticks, which are not made up.
        assert!((23..=25).contains(&seen.len()), "{} commits", seen.len());
        let starts: Vec<Instant> = seen.iter().map(|(_, at)| *at).collect();
        let late = starts
            .iter()
            .position(|at| *at - starts[3] >= TICK)
            .unwrap();
        // One tick runs as soon as the slow commit ends; after that the timer
        // is back on its period.
        for pair in starts[late + 1..].windows(2) {
            assert!(pair[1] - pair[0] >= TICK - Duration::from_millis(1));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn hung_commit_times_out_and_the_clock_goes_on() {
        let seen = commits(Duration::from_secs(3), |tick| {
            Duration::from_secs(if tick == 1 { 3600 } else { 0 })
        })
        .await;
        assert!(seen.len() > 30, "{} commits", seen.len());
    }

    #[tokio::test(start_paused = true)]
    async fn next_tick_waits_for_the_commit() {
        let seen = commits(Duration::from_millis(500), |_| Duration::from_millis(50)).await;
        for pair in seen.windows(2) {
            assert!(pair[1].1 - pair[0].1 >= Duration::from_millis(50));
        }
    }
}
