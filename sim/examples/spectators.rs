//! Holds many spectators on one arena's tick stream and reports what each
//! received, for the spectator fanout check (`web/scripts/fanout.ts`).
//!
//! Every spectator is its own Felix client with its own connection, as it is
//! in the gateway, where a connection carries one token. They all read the live
//! tail, and print one summary line.
//!
//! Settings, from the environment: `SPECTATORS_COUNT` (default 100),
//! `SPECTATORS_SECONDS` (30), `SPECTATORS_ARENA` (`alpha`),
//! `SPECTATORS_TENANT` (`arena`), `SPECTATORS_NAMESPACE` (`default`),
//! `SPECTATORS_FELIX_BROKERS` (`127.0.0.1:5000`),
//! `SPECTATORS_FELIX_SERVER_NAME` (`localhost`), `SPECTATORS_FELIX_CA_FILE`
//! and `SPECTATORS_FELIX_TOKEN_FILE`, the last of which is required.
//!
//! It prints `subscribed <n>` once every spectator is reading, counts ticks
//! for `SPECTATORS_SECONDS` from then, and exits non-zero when one could not
//! subscribe or saw under 90% of the ticks the sim commits in that time.

use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use felix_arena_core::Tick;
use felix_client::{ClientConfig, Client, ClusterSubscription};
use tokio::task::JoinSet;
use tokio::time::Instant;

/// The sim commits this many ticks a second.
const TICK_HZ: u64 = 30;
/// Connecting and subscribing must finish within this.
const JOIN_TIMEOUT: Duration = Duration::from_secs(60);
/// Connections being set up at once. A hundred QUIC handshakes in the same
/// instant are enough to time out on a busy host.
const HANDSHAKES: usize = 10;
/// A spectator must see this share of the ticks committed while it read.
const MIN_SHARE: f64 = 0.9;

fn setting(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn number(name: &str, default: u64) -> Result<u64> {
    match setting(name) {
        Some(value) => value
            .trim()
            .parse()
            .with_context(|| format!("{name}: {value:?} is not a number")),
        None => Ok(default),
    }
}

struct Settings {
    count: u64,
    seconds: u64,
    arena: String,
    tenant: String,
    namespace: String,
    brokers: Vec<SocketAddr>,
    server_name: String,
    ca_file: Option<String>,
    token: String,
}

impl Settings {
    async fn from_env() -> Result<Self> {
        let token_file = setting("SPECTATORS_FELIX_TOKEN_FILE")
            .context("SPECTATORS_FELIX_TOKEN_FILE is required")?;
        let token = std::fs::read_to_string(&token_file)
            .with_context(|| format!("read {token_file}"))?
            .trim()
            .to_owned();
        let mut brokers = Vec::new();
        let list = setting("SPECTATORS_FELIX_BROKERS").unwrap_or_else(|| "127.0.0.1:5000".into());
        for broker in list.split(',').map(str::trim).filter(|b| !b.is_empty()) {
            brokers.extend(
                tokio::net::lookup_host(broker)
                    .await
                    .with_context(|| format!("resolve {broker}"))?,
            );
        }
        Ok(Self {
            count: number("SPECTATORS_COUNT", 100)?,
            seconds: number("SPECTATORS_SECONDS", 30)?,
            arena: setting("SPECTATORS_ARENA").unwrap_or_else(|| "alpha".into()),
            tenant: setting("SPECTATORS_TENANT").unwrap_or_else(|| "arena".into()),
            namespace: setting("SPECTATORS_NAMESPACE").unwrap_or_else(|| "default".into()),
            brokers,
            server_name: setting("SPECTATORS_FELIX_SERVER_NAME")
                .unwrap_or_else(|| "localhost".into()),
            ca_file: setting("SPECTATORS_FELIX_CA_FILE"),
            token,
        })
    }
}

/// What one spectator saw.
#[derive(Default)]
struct Seen {
    ticks: u64,
    /// Offsets that jumped without the broker saying why: ticks dropped.
    dropped: u64,
    undecodable: u64,
}

/// A spectator subscribed to the tail, and the client that keeps it open.
struct Spectator {
    _client: Arc<Client>,
    subscription: ClusterSubscription,
}

async fn join(settings: &Settings) -> Result<Spectator> {
    let roots = settings
        .ca_file
        .as_ref()
        .map(felix_client::root_store_from_pem_file)
        .transpose()?
        .map(Arc::new);
    let mut config =
        ClientConfig::optimized_defaults(felix_client::quic_client_config(roots, true)?);
    config.auth_tenant_id = Some(settings.tenant.clone());
    config.auth_token = Some(settings.token.clone());
    let client = Arc::new(
        Client::connect(&settings.brokers, &settings.server_name, config)
            .await
            .context("connect")?,
    );
    let stream = format!("arena.ticks.{}", settings.arena);
    let subscription = client
        .subscribe(&settings.tenant, &settings.namespace, &stream)
        .await
        .context("subscribe")?;
    Ok(Spectator {
        _client: client,
        subscription,
    })
}

/// Reads the tail from the moment it joined, so a spectator that joins early
/// is not left with a full queue, and counts only what arrives once `window`
/// is set, for `seconds`.
async fn read(
    mut spectator: Spectator,
    window: Arc<OnceLock<Instant>>,
    seconds: u64,
) -> Result<Seen> {
    let mut seen = Seen::default();
    let mut last = None;
    loop {
        let now = Instant::now();
        let start = window.get().copied();
        if start.is_some_and(|start| now >= start + Duration::from_secs(seconds)) {
            return Ok(seen);
        }
        // Ticks come 30 times a second; the timeout only lets a stalled
        // stream notice that the window has closed.
        let Ok(event) =
            tokio::time::timeout(Duration::from_secs(1), spectator.subscription.next_event()).await
        else {
            continue;
        };
        let Some(event) = event.context("read")? else {
            bail!("the subscription ended");
        };
        if let Some(offset) = event.offset {
            if let Some(last) = last
                && start.is_some()
            {
                seen.dropped += offset.saturating_sub(last + 1 + event.skipped_before);
            }
            last = Some(offset);
        }
        if start.is_none() {
            continue;
        }
        if Tick::decode(&event.payload).is_none() {
            seen.undecodable += 1;
        }
        seen.ticks += 1;
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let settings = Arc::new(Settings::from_env().await?);
    let window = Arc::new(OnceLock::new());
    let handshakes = Arc::new(tokio::sync::Semaphore::new(HANDSHAKES));
    let (joined, mut joins) = tokio::sync::mpsc::channel(settings.count.max(1) as usize);
    let mut reading = JoinSet::new();
    for _ in 0..settings.count {
        let (settings, window, joined, handshakes) = (
            Arc::clone(&settings),
            Arc::clone(&window),
            joined.clone(),
            Arc::clone(&handshakes),
        );
        reading.spawn(async move {
            let spectator = match handshakes.acquire().await {
                Ok(_slot) => tokio::time::timeout(JOIN_TIMEOUT, join(&settings))
                    .await
                    .context("joining timed out")
                    .and_then(|joined| joined),
                Err(err) => Err(err.into()),
            };
            let spectator = match spectator {
                Ok(spectator) => spectator,
                Err(err) => {
                    let _ = joined.send(Err(format!("{err:#}"))).await;
                    return Err(err);
                }
            };
            let _ = joined.send(Ok(())).await;
            read(spectator, window, settings.seconds).await
        });
    }
    drop(joined);
    for _ in 0..settings.count {
        match joins.recv().await {
            Some(Ok(())) => {}
            Some(Err(err)) => bail!("a spectator could not join: {err}"),
            None => bail!("the spectators stopped before they all joined"),
        }
    }
    println!("subscribed {}", settings.count);
    let started = Instant::now();
    let _ = window.set(started);

    let mut all = Vec::new();
    while let Some(done) = reading.join_next().await {
        all.push(done.context("a spectator panicked")??);
    }
    let wanted = (settings.seconds * TICK_HZ) as f64 * MIN_SHARE;
    let fewest = all.iter().map(|s| s.ticks).min().unwrap_or(0);
    let most = all.iter().map(|s| s.ticks).max().unwrap_or(0);
    let dropped: u64 = all.iter().map(|s| s.dropped).sum();
    let undecodable: u64 = all.iter().map(|s| s.undecodable).sum();
    println!(
        "{} spectators read {:.0} s: {fewest} to {most} ticks each, {dropped} dropped, {undecodable} undecodable",
        all.len(),
        started.elapsed().as_secs_f64(),
    );
    if (fewest as f64) < wanted || undecodable > 0 {
        bail!(
            "a spectator saw {fewest} ticks, wanted at least {wanted:.0}, or a tick did not decode"
        );
    }
    Ok(())
}
