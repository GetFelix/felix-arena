//! The simulation: the authority for each arena. It reads each arena's input
//! stream, steps its world through `felix-arena-core` at 30 Hz, commits every
//! tick to the arena's tick stream and logs how long the commits take.

mod arena;
mod config;
mod inputs;
mod latency;
mod lobby;
mod recovery;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use felix_client::{ClientConfig, Client, CommitOp};
use tokio::task::JoinSet;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::recovery::Recovered;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_ansi(std::io::IsTerminal::is_terminal(&std::io::stderr()))
        .with_writer(std::io::stderr)
        .init();

    let config = Config::from_env()?;
    let client = Arc::new(connect(&config).await?);
    info!(
        tenant = %config.tenant,
        arenas = %config.arenas.join(","),
        "connected to Felix"
    );

    let mut arenas = JoinSet::new();
    for arena in &config.arenas {
        let stream = format!("arena.ticks.{arena}");
        let (client, tenant, namespace) = (
            Arc::clone(&client),
            config.tenant.clone(),
            config.namespace.clone(),
        );
        let recovered = recover(&client, &config, arena).await;
        let inbox = Arc::default();
        let status = Arc::default();
        let members = Arc::default();
        tokio::spawn(lobby::watch_members(
            Arc::clone(&client),
            config.tenant.clone(),
            config.namespace.clone(),
            format!("arena.members.{arena}"),
            Arc::clone(&members),
        ));
        tokio::spawn(lobby::publish(
            Arc::clone(&client),
            config.tenant.clone(),
            config.namespace.clone(),
            arena.clone(),
            Arc::clone(&status),
            members,
        ));
        tokio::spawn(inputs::follow(
            Arc::clone(&client),
            config.tenant.clone(),
            config.namespace.clone(),
            format!("arena.input.{arena}"),
            Arc::clone(&inbox),
        ));
        arenas.spawn(arena::run(
            arena.clone(),
            recovered.epoch,
            recovered.world,
            config.rules,
            inbox,
            status,
            move |record, keys: Vec<(String, Vec<u8>)>| {
                let (client, tenant, namespace, stream) = (
                    Arc::clone(&client),
                    tenant.clone(),
                    namespace.clone(),
                    stream.clone(),
                );
                async move {
                    let mut ops = vec![CommitOp::publish(stream.as_str(), record)];
                    ops.extend(
                        keys.into_iter()
                            .map(|(key, value)| CommitOp::put(stream.as_str(), key, value)),
                    );
                    let receipt = client
                        .commit(&tenant, &namespace, stream.as_bytes(), ops)
                        .await?;
                    Ok(receipt.offset)
                }
            },
        ));
    }
    // An arena's loop only ends by panicking.
    if let Some(Err(err)) = arenas.join_next().await {
        return Err(err).context("an arena stopped");
    }
    Ok(())
}

/// Where `arena` left off, asked again until the log answers: starting over
/// on a failed read would write a low epoch that readers ignore.
async fn recover(client: &Client, config: &Config, arena: &str) -> Recovered {
    loop {
        match recovery::load(
            client,
            &config.tenant,
            &config.namespace,
            arena,
            config.rules,
        )
        .await
        {
            Ok(recovered) => return recovered,
            Err(err) => {
                warn!(arena, error = %format!("{err:#}"), "cannot read the log to recover");
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

/// Connect to Felix, retrying until a broker answers: in a fresh deployment
/// the sim can start before the brokers do, or before the broker has written
/// the certificate it is checked against.
async fn connect(config: &Config) -> Result<Client> {
    let mut attempt = 0u32;
    loop {
        match try_connect(config).await {
            Ok(client) => return Ok(client),
            Err(err) => {
                attempt += 1;
                warn!(error = %format!("{err:#}"), attempt, "Felix is not reachable yet");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }
}

async fn try_connect(config: &Config) -> Result<Client> {
    let token = std::fs::read_to_string(&config.token_file)
        .with_context(|| format!("read {}", config.token_file.display()))?;
    let roots = config
        .ca_file
        .as_ref()
        .map(felix_client::root_store_from_pem_file)
        .transpose()?
        .map(Arc::new);
    let mut client_config =
        ClientConfig::optimized_defaults(felix_client::quic_client_config(roots, true)?);
    client_config.auth_tenant_id = Some(config.tenant.clone());
    client_config.auth_token = Some(token.trim().to_owned());
    // Who published each input, which must match the gateway's stamp.
    client_config.publishers = true;
    let seeds = resolve(&config.brokers).await?;
    Client::connect(&seeds, &config.server_name, client_config).await
}

async fn resolve(brokers: &[String]) -> Result<Vec<SocketAddr>> {
    let mut addrs = Vec::new();
    for broker in brokers {
        addrs.extend(
            tokio::net::lookup_host(broker)
                .await
                .with_context(|| format!("resolve {broker}"))?,
        );
    }
    Ok(addrs)
}
