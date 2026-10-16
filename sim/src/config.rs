use std::path::PathBuf;

use anyhow::{Context, Result, bail};

/// The sim's settings, from `SIM_*` variables.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Config {
    /// `SIM_FELIX_BROKERS`: comma-separated `host:port` addresses. Default
    /// `127.0.0.1:5000`.
    pub(crate) brokers: Vec<String>,
    /// `SIM_FELIX_SERVER_NAME`: the name the broker's certificate is checked
    /// against. Default `localhost`.
    pub(crate) server_name: String,
    /// `SIM_FELIX_CA_FILE`: PEM certificates to trust for the broker. Unset
    /// means the platform's trust store.
    pub(crate) ca_file: Option<PathBuf>,
    /// `SIM_FELIX_TOKEN_FILE`: a file holding the sim's Felix token.
    pub(crate) token_file: PathBuf,
    /// `SIM_TENANT`. Default `arena`.
    pub(crate) tenant: String,
    /// `SIM_NAMESPACE`. Default `default`.
    pub(crate) namespace: String,
    /// `SIM_ARENAS`: the arenas this sim runs, separated by commas or spaces.
    pub(crate) arenas: Vec<String>,
}

impl Config {
    pub(crate) fn from_env() -> Result<Self> {
        Self::from_lookup(|name| std::env::var(name).ok().filter(|v| !v.trim().is_empty()))
    }

    fn from_lookup(var: impl Fn(&str) -> Option<String>) -> Result<Self> {
        let list = |value: String| -> Vec<String> {
            value
                .split([',', ' '])
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect()
        };
        let brokers = list(var("SIM_FELIX_BROKERS").unwrap_or_else(|| "127.0.0.1:5000".into()));
        let arenas = list(var("SIM_ARENAS").context("SIM_ARENAS is required")?);
        if arenas.is_empty() {
            bail!("SIM_ARENAS names no arena");
        }
        if let Some(bad) = arenas.iter().find(|arena| {
            !arena
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        }) {
            bail!("SIM_ARENAS: {bad:?} may use only letters, digits, '-' and '_'");
        }
        Ok(Self {
            brokers,
            server_name: var("SIM_FELIX_SERVER_NAME").unwrap_or_else(|| "localhost".into()),
            ca_file: var("SIM_FELIX_CA_FILE").map(PathBuf::from),
            token_file: var("SIM_FELIX_TOKEN_FILE")
                .context("SIM_FELIX_TOKEN_FILE is required")?
                .into(),
            tenant: var("SIM_TENANT").unwrap_or_else(|| "arena".into()),
            namespace: var("SIM_NAMESPACE").unwrap_or_else(|| "default".into()),
            arenas,
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::Config;

    fn config(vars: &[(&str, &str)]) -> anyhow::Result<Config> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|name| vars.get(name).cloned())
    }

    #[test]
    fn defaults() {
        let config = config(&[("SIM_ARENAS", "a, b"), ("SIM_FELIX_TOKEN_FILE", "/t")]).unwrap();
        assert_eq!(config.arenas, ["a", "b"]);
        assert_eq!(config.brokers, ["127.0.0.1:5000"]);
        assert_eq!(config.server_name, "localhost");
        assert_eq!(config.tenant, "arena");
        assert_eq!(config.namespace, "default");
        assert_eq!(config.ca_file, None);
    }

    #[test]
    fn requires_arenas_and_a_token() {
        assert!(config(&[("SIM_FELIX_TOKEN_FILE", "/t")]).is_err());
        assert!(config(&[("SIM_ARENAS", ","), ("SIM_FELIX_TOKEN_FILE", "/t")]).is_err());
        assert!(config(&[("SIM_ARENAS", "a")]).is_err());
    }

    #[test]
    fn refuses_an_arena_name_that_would_change_the_stream_name() {
        assert!(config(&[("SIM_ARENAS", "a.b"), ("SIM_FELIX_TOKEN_FILE", "/t")]).is_err());
    }
}
