use std::future::Future;
use std::time::Duration;

use anyhow::Result;
use tokio::time::{Instant, MissedTickBehavior};
use tracing::{info, warn};

use crate::latency::Window;
use crate::tick::{Header, Timing, record};

/// 30 Hz.
pub(crate) const TICK: Duration = Duration::from_nanos(1_000_000_000 / 30);
/// Every 30th tick is a keyframe.
const KEYFRAME_EVERY: u32 = 30;
const REPORT_EVERY: Duration = Duration::from_secs(5);
/// A commit still unanswered after this is counted as failed, so a hung
/// broker cannot stop the arena's clock or its reports.
const COMMIT_TIMEOUT: Duration = Duration::from_secs(1);

/// Step `arena` on a 30 Hz timer forever, handing each tick's record to
/// `commit`, which answers with the tick's log offset.
///
/// A commit finishes before the next tick starts, so ticks land in order. A
/// tick that is due while a commit is still running is skipped rather than
/// made up later, so a slow commit never causes a burst of ticks.
pub(crate) async fn run<C, F>(arena: String, epoch: u16, mut commit: C)
where
    C: FnMut(Vec<u8>) -> F,
    F: Future<Output = Result<u64>>,
{
    let mut timer = tokio::time::interval(TICK);
    timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut tick: u32 = 0;
    let mut last_due: Option<Instant> = None;
    let mut previous_commit: Option<Duration> = None;
    let mut report = Report::new(Instant::now());
    loop {
        let due = timer.tick().await;
        if let Some(last) = last_due {
            let periods = (due - last).as_nanos() / TICK.as_nanos();
            report.missed += u64::try_from(periods.saturating_sub(1)).unwrap_or(u64::MAX);
        }
        last_due = Some(due);

        let header = Header {
            epoch,
            keyframe: tick.is_multiple_of(KEYFRAME_EVERY),
            timed: true,
            match_number: 0,
            tick,
        };
        let started = Instant::now();
        let timing = Timing {
            commit_start_us: unix_micros(),
            step_us: micros(started - due),
            previous_commit_us: previous_commit.map_or(0, micros),
        };
        let answer = tokio::time::timeout(COMMIT_TIMEOUT, commit(record(&header, Some(&timing))))
            .await
            .unwrap_or_else(|_| Err(anyhow::anyhow!("no answer within {COMMIT_TIMEOUT:?}")));
        previous_commit = None;
        match answer {
            Ok(offset) => {
                let took = started.elapsed();
                report.latency.record(took);
                report.offset = Some(offset);
                previous_commit = Some(took);
            }
            Err(err) => {
                report.failed += 1;
                warn!(arena = %arena, tick, error = %format!("{err:#}"), "tick commit failed");
            }
        }
        // A failed tick's number is not reused: it may have landed anyway,
        // and a gap is easier for a reader to handle than a repeat.
        tick = tick.wrapping_add(1);

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
}

impl Report {
    fn new(since: Instant) -> Self {
        Self {
            since,
            latency: Window::default(),
            missed: 0,
            failed: 0,
            offset: None,
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

    use super::{TICK, run};
    use crate::tick::Header;

    /// Runs an arena for `length` of paused time, where the commit of tick
    /// `n` takes `latency(n)`, and returns each commit's tick and start.
    async fn commits(
        length: Duration,
        latency: impl Fn(u32) -> Duration + Send + 'static,
    ) -> Vec<(Header, Instant)> {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&seen);
        let arena = tokio::spawn(run("a".into(), 1, move |record: Vec<u8>| {
            let header = Header::decode(&record).unwrap();
            log.lock().unwrap().push((header, Instant::now()));
            let wait = latency(header.tick);
            async move {
                tokio::time::sleep(wait).await;
                Ok(u64::from(header.tick))
            }
        }));
        tokio::time::sleep(length).await;
        arena.abort();
        seen.lock().unwrap().clone()
    }

    #[tokio::test(start_paused = true)]
    async fn commits_thirty_ticks_a_second_in_order() {
        let seen = commits(Duration::from_secs(1), |_| Duration::from_millis(2)).await;
        assert_eq!(seen.len(), 30);
        for (i, (header, _)) in seen.iter().enumerate() {
            assert_eq!(header.tick, i as u32);
            assert!(header.timed);
            assert_eq!(header.epoch, 1);
            assert_eq!(header.keyframe, i % 30 == 0);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn slow_commit_skips_ticks_instead_of_bursting() {
        let seen = commits(Duration::from_secs(1), |tick| {
            Duration::from_millis(if tick == 3 { 200 } else { 2 })
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
            Duration::from_secs(if tick == 0 { 3600 } else { 0 })
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
