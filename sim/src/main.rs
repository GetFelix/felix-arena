//! The simulation: the authority for each arena. For now it commits an empty
//! tick to each arena's tick stream at 30 Hz and logs how long the commits
//! take.

mod arena;
mod config;
mod latency;
mod tick;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use felix_client::{ClientConfig, ClusterClient, CommitOp};
use tokio::task::JoinSet;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

use crate::config::Config;

/// Until the sim keeps an epoch counter, every run is epoch 0.
const EPOCH: u16 = 0;

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
        arenas.spawn(arena::run(arena.clone(), EPOCH, move |record| {
            let (client, tenant, namespace, stream) = (
                Arc::clone(&client),
                tenant.clone(),
                namespace.clone(),
                stream.clone(),
            );
            async move {
                let ops = vec![CommitOp::publish(stream.as_str(), record)];
                let receipt = client
                    .commit(&tenant, &namespace, stream.as_bytes(), ops)
                    .await?;
                Ok(receipt.offset)
            }
        }));
    }
    // An arena's loop only ends by panicking.
    if let Some(Err(err)) = arenas.join_next().await {
        return Err(err).context("an arena stopped");
    }
    Ok(())
}

/// Connect to Felix, retrying until a broker answers: in a fresh deployment
/// the sim can start before the brokers do.
async fn connect(config: &Config) -> Result<ClusterClient> {
    let token = std::fs::read_to_string(&config.token_file)
        .with_context(|| format!("read {}", config.token_file.display()))?;
    let roots = config
        .ca_file
        .as_ref()
        .map(felix_client::root_store_from_pem_file)
        .transpose()?
        .map(Arc::new);
    let mut attempt = 0u32;
    loop {
        let mut client_config = ClientConfig::optimized_defaults(felix_client::quic_client_config(
            roots.clone(),
            true,
        )?);
        client_config.auth_tenant_id = Some(config.tenant.clone());
        client_config.auth_token = Some(token.trim().to_owned());
        // The defaults open many connections per pool, sized for throughput.
        // The sim sends 30 small commits a second per arena.
        client_config.publish_conn_pool = 1;
        client_config.event_conn_pool = 1;
        client_config.cache_conn_pool = 1;
        let result = match resolve(&config.brokers).await {
            Ok(seeds) => ClusterClient::connect(&seeds, &config.server_name, client_config).await,
            Err(err) => Err(err),
        };
        match result {
            Ok(client) => return Ok(client),
            Err(err) if attempt < 60 => {
                attempt += 1;
                warn!(error = %format!("{err:#}"), attempt, "Felix is not reachable yet");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(err) => return Err(err).context("connect to Felix"),
        }
    }
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
