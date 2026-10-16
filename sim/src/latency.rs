use std::time::Duration;

/// Commit latencies over one reporting window.
#[derive(Default)]
pub(crate) struct Window {
    samples: Vec<Duration>,
}

impl Window {
    pub(crate) fn record(&mut self, latency: Duration) {
        self.samples.push(latency);
    }

    pub(crate) fn len(&self) -> usize {
        self.samples.len()
    }

    /// p50, p99 and max by nearest rank, or `None` for an empty window.
    /// Empties the window.
    pub(crate) fn take_summary(&mut self) -> Option<Summary> {
        if self.samples.is_empty() {
            return None;
        }
        self.samples.sort_unstable();
        let rank = |p: f64| {
            let n = self.samples.len();
            let index = ((p * n as f64).ceil() as usize).clamp(1, n) - 1;
            self.samples[index]
        };
        let summary = Summary {
            p50: rank(0.50),
            p99: rank(0.99),
            max: *self.samples.last()?,
        };
        self.samples.clear();
        Some(summary)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Summary {
    pub(crate) p50: Duration,
    pub(crate) p99: Duration,
    pub(crate) max: Duration,
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{Summary, Window};

    #[test]
    fn nearest_rank_percentiles() {
        let mut window = Window::default();
        for ms in (1..=100).rev() {
            window.record(Duration::from_millis(ms));
        }
        assert_eq!(
            window.take_summary(),
            Some(Summary {
                p50: Duration::from_millis(50),
                p99: Duration::from_millis(99),
                max: Duration::from_millis(100),
            })
        );
        assert_eq!(window.len(), 0);
        assert_eq!(window.take_summary(), None);
    }

    #[test]
    fn one_sample_is_every_percentile() {
        let mut window = Window::default();
        window.record(Duration::from_millis(4));
        let summary = window.take_summary().unwrap();
        assert_eq!((summary.p50, summary.p99), (summary.max, summary.max));
    }
}
