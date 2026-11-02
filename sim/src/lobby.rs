use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use felix_arena_core::Phase;
use felix_arena_core::world::MAX_CRAFTS;
use felix_client::{CacheWatchFilter, CacheWatchItem, ClusterClient};
use tracing::warn;

/// The lobby cache: one entry per arena, which lapses when its sim stops.
pub(crate) const LOBBY_CACHE: &str = "arena.lobby";
const LOBBY_TTL: Duration = Duration::from_secs(10);
/// Well inside the TTL, so one lost write does not drop an arena from the lobby.
const LOBBY_EVERY: Duration = Duration::from_secs(3);

/// Where an arena's match is, as the lobby shows it. The arena loop writes it each tick.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Status {
    pub(crate) match_number: u32,
    pub(crate) phase: Option<Phase>,
    /// Ticks left in the phase.
    pub(crate) left: u16,
    pub(crate) scores: [u16; 2],
    pub(crate) players: usize,
}

/// Who has a member key in an arena's member cache: each browser session
/// writes `play:<name>` or `watch:<name>` under its session key.
#[derive(Debug, Default)]
pub(crate) struct Members {
    /// Each key's role and when it expires, in Unix milliseconds (0 for never).
    entries: HashMap<String, (Role, u64)>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    Play,
    Watch,
}

impl Members {
    pub(crate) fn apply(&mut self, key: String, value: Option<&[u8]>, expires_at_ms: u64) {
        let role = value.and_then(|value| match value.split(|b| *b == b':').next()? {
            b"play" => Some(Role::Play),
            b"watch" => Some(Role::Watch),
            _ => None,
        });
        match role {
            Some(role) => {
                self.entries.insert(key, (role, expires_at_ms));
            }
            None => {
                self.entries.remove(&key);
            }
        }
    }

    /// Sessions watching at `now_ms`. An entry past its TTL is not counted
    /// even before its expiry reaches the watch.
    pub(crate) fn spectators(&self, now_ms: u64) -> usize {
        self.entries
            .values()
            .filter(|(role, expires)| *role == Role::Watch && (*expires == 0 || *expires > now_ms))
            .count()
    }

    fn clear(&mut self) {
        self.entries.clear();
    }
}

/// The lobby entry for an arena, as JSON.
pub(crate) fn entry(status: &Status, spectators: usize) -> String {
    let phase = match status.phase {
        Some(Phase::Warmup) | None => "warmup",
        Some(Phase::Playing) => "playing",
        Some(Phase::Results) => "results",
    };
    format!(
        r#"{{"match":{},"phase":"{phase}","seconds":{},"scores":[{},{}],"players":{},"capacity":{MAX_CRAFTS},"spectators":{spectators}}}"#,
        status.match_number,
        status.left.div_ceil(30),
        status.scores[0],
        status.scores[1],
        status.players,
    )
}

/// Keep `members` in step with the arena's member cache, watching it again
/// whenever the watch ends.
pub(crate) async fn watch_members(
    client: Arc<ClusterClient>,
    tenant: String,
    namespace: String,
    cache: String,
    members: Arc<Mutex<Members>>,
) {
    loop {
        let watch = client
            .watch_cache_retained(
                &tenant,
                &namespace,
                &cache,
                CacheWatchFilter::Prefix(String::new()),
            )
            .await;
        match watch {
            Ok(mut watch) => {
                // A retained watch starts with every entry again.
                lock(&members).clear();
                while let Some(item) = watch.recv().await {
                    let CacheWatchItem::Change(change) = item else {
                        break;
                    };
                    lock(&members).apply(
                        change.key,
                        change.value.as_deref(),
                        change.expires_at_millis,
                    );
                }
            }
            Err(err) => warn!(cache, error = %format!("{err:#}"), "cannot watch the members"),
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Write `arena`'s lobby entry every few seconds, with a TTL, so the lobby
/// lists exactly the arenas whose sims are running.
pub(crate) async fn publish(
    client: Arc<ClusterClient>,
    tenant: String,
    namespace: String,
    arena: String,
    status: Arc<Mutex<Status>>,
    members: Arc<Mutex<Members>>,
) {
    let ttl = u64::try_from(LOBBY_TTL.as_millis()).unwrap_or(u64::MAX);
    let mut timer = tokio::time::interval(LOBBY_EVERY);
    loop {
        timer.tick().await;
        let status = *lock(&status);
        // The first tick has not run yet: there is nothing true to list.
        if status.phase.is_none() {
            continue;
        }
        let spectators = lock(&members).spectators(unix_millis());
        let value = entry(&status, spectators).into_bytes();
        if let Err(err) = client
            .cache_put(
                &tenant,
                &namespace,
                LOBBY_CACHE,
                &arena,
                value.into(),
                Some(ttl),
            )
            .await
        {
            warn!(arena, error = %format!("{err:#}"), "lobby entry not written");
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use felix_arena_core::Phase;

    use super::{Members, Status, entry};

    #[test]
    fn counts_watchers_until_they_leave_or_lapse() {
        let mut members = Members::default();
        members.apply("a".into(), Some(b"watch:cleo"), 2_000);
        members.apply("b".into(), Some(b"play:ana"), 2_000);
        members.apply("c".into(), Some(b"watch:cleo"), 0);
        members.apply("d".into(), Some(b"nonsense"), 0);
        assert_eq!(members.spectators(1_000), 2);
        assert_eq!(
            members.spectators(2_000),
            1,
            "a lapsed entry is not counted"
        );
        members.apply("c".into(), None, 0);
        assert_eq!(members.spectators(1_000), 1);
    }

    #[test]
    fn an_entry_is_the_arenas_status_as_json() {
        let status = Status {
            match_number: 3,
            phase: Some(Phase::Playing),
            left: 61,
            scores: [4, 2],
            players: 4,
        };
        assert_eq!(
            entry(&status, 1),
            r#"{"match":3,"phase":"playing","seconds":3,"scores":[4,2],"players":4,"capacity":8,"spectators":1}"#
        );
    }
}
