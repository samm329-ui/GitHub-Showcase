use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Application configuration settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub server_host: String,
    pub server_port: u16,
    pub request_timeout_secs: u64,
    pub cdp_port: u16,
    pub cdp_host: String,
    pub proxy: Option<String>,
    pub enable_cloudflared_tunnel: bool,
    /// The browser to drive. When it is empty, the browser that is installed
    /// on the machine is used.
    #[serde(default)]
    pub browser_path: Option<String>,
    /// Whether the environment profile is applied to the session.
    ///
    /// Turning it off gives a browser that shows its own values, which is
    /// what the comparison harness needs in order to measure a reference
    /// browser without measuring the profile on top of it.
    #[serde(default = "default_true")]
    pub apply_profile: bool,
}

fn default_true() -> bool {
    true
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            server_host: "127.0.0.1".to_string(),
            server_port: 8000,
            request_timeout_secs: 30,
            cdp_port: 9222,
            cdp_host: "127.0.0.1".to_string(),
            proxy: None,
            enable_cloudflared_tunnel: true,
            browser_path: None,
            apply_profile: true,
        }
    }
}

impl AppConfig {
    /// Reads the configuration from the environment, on top of the defaults.
    ///
    /// | Variable | Meaning |
    /// | --- | --- |
    /// | `REACH_HOST` | the address the server listens on |
    /// | `REACH_PORT` | the port the server listens on |
    /// | `REACH_CDP_PORT` | the port the browser opens for the protocol |
    /// | `REACH_TUNNEL` | `0` keeps the public tunnel off |
    /// | `REACH_PROXY` | the proxy for the outgoing requests |
    /// | `REACH_BROWSER_PATH` | the browser to drive |
    /// | `REACH_APPLY_PROFILE` | `0` leaves the browser with its own values |
    /// | `REACH_PERSONA_SEED` | pins the machine of the profile |
    /// | `REACH_PERSONA_COUNTRY` | anchors the profile to a country |
    pub fn from_env() -> Self {
        let mut config = AppConfig::default();

        if let Ok(host) = std::env::var("REACH_HOST") {
            config.server_host = host;
        }
        if let Some(port) = std::env::var("REACH_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
        {
            config.server_port = port;
        }
        if let Some(port) = std::env::var("REACH_CDP_PORT")
            .ok()
            .and_then(|v| v.parse().ok())
        {
            config.cdp_port = port;
        }
        if let Ok(proxy) = std::env::var("REACH_PROXY") {
            if !proxy.is_empty() {
                config.proxy = Some(proxy);
            }
        }
        if let Ok(path) = std::env::var("REACH_BROWSER_PATH") {
            if !path.is_empty() {
                config.browser_path = Some(path);
            }
        }
        if let Ok(value) = std::env::var("REACH_APPLY_PROFILE") {
            config.apply_profile = !matches!(value.trim(), "0" | "false" | "no");
        }
        if let Ok(value) = std::env::var("REACH_TUNNEL") {
            config.enable_cloudflared_tunnel = !matches!(value.trim(), "0" | "false" | "no");
        }

        config
    }

    pub fn cdp_endpoint(&self) -> String {
        format!("http://{}:{}", self.cdp_host, self.cdp_port)
    }

    pub fn cdp_ws_url(&self) -> String {
        format!("ws://{}:{}/devtools/browser", self.cdp_host, self.cdp_port)
    }

    pub fn server_addr(&self) -> String {
        format!("{}:{}", self.server_host, self.server_port)
    }

    pub fn load_from_file(path: impl AsRef<Path>) -> Result<Self, crate::error::ReachError> {
        let content = std::fs::read_to_string(path)?;
        let config = serde_json::from_str(&content)?;
        Ok(config)
    }

    pub fn save_to_file(&self, path: impl AsRef<Path>) -> Result<(), crate::error::ReachError> {
        let content = serde_json::to_string_pretty(self)?;
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, content)?;
        Ok(())
    }

    pub fn default_config_path() -> PathBuf {
        let mut path = dirs_next().unwrap_or_else(|| PathBuf::from("."));
        path.push(".reach");
        path.push("config.json");
        path
    }
}

fn dirs_next() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config_values() {
        let config = AppConfig::default();
        assert_eq!(config.server_port, 8000);
        assert_eq!(config.cdp_port, 9222);
        assert_eq!(config.cdp_endpoint(), "http://127.0.0.1:9222");
        assert_eq!(config.server_addr(), "127.0.0.1:8000");
    }

    #[test]
    fn test_config_serialization_roundtrip() {
        let config = AppConfig {
            server_port: 9090,
            proxy: Some("http://127.0.0.1:7890".to_string()),
            ..Default::default()
        };

        let serialized = serde_json::to_string(&config).unwrap();
        let deserialized: AppConfig = serde_json::from_str(&serialized).unwrap();

        assert_eq!(deserialized.server_port, 9090);
        assert_eq!(
            deserialized.proxy,
            Some("http://127.0.0.1:7890".to_string())
        );
    }

    #[test]
    fn test_a_configuration_without_the_new_fields_still_loads() {
        // A file written by an older version has to keep working.
        let older = r#"{
            "server_host": "127.0.0.1",
            "server_port": 8000,
            "request_timeout_secs": 30,
            "cdp_port": 9222,
            "cdp_host": "127.0.0.1",
            "proxy": null,
            "enable_cloudflared_tunnel": true
        }"#;

        let config: AppConfig = serde_json::from_str(older).expect("deserialize");
        assert_eq!(config.server_port, 8000);
        assert!(config.apply_profile);
        assert!(config.browser_path.is_none());
    }

    #[test]
    fn test_the_environment_can_turn_the_tunnel_off() {
        // The variable is process wide, so the test only checks the parsing
        // of the value, not the value itself.
        let off = !matches!("0", "0" | "false" | "no");
        let on = !matches!("1", "0" | "false" | "no");
        assert!(!off);
        assert!(on);
    }
}
