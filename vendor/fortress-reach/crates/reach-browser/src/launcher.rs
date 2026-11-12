use reach_core::error::{ReachError, Result};
use reach_persona::PersonaProfile;
use reqwest::Client;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::time::Duration;

use crate::fingerprint;
use crate::provider::BrowserProvider;

/// Launches and keeps track of the browser process.
pub struct BrowserLauncher {
    port: u16,
    host: String,
}

impl BrowserLauncher {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self { port, host: host.into() }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    /// Checks if a Chromium CDP endpoint is already running and reachable.
    pub async fn is_running(&self) -> bool {
        let version_url = format!("http://{}:{}/json/version", self.host, self.port);
        let client = Client::builder()
            .timeout(Duration::from_millis(1500))
            .build()
            .unwrap_or_else(|_| Client::new());

        match client.get(&version_url).send().await {
            Ok(response) => response.status().is_success(),
            Err(_) => false,
        }
    }

    /// Retrieves the WebSocket debugger URL from the running CDP instance.
    pub async fn get_ws_debugger_url(&self) -> Result<String> {
        let version_url = format!("http://{}:{}/json/version", self.host, self.port);
        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| Client::new());

        let res = client
            .get(&version_url)
            .send()
            .await
            .map_err(|e| ReachError::BrowserError(format!("Could not reach CDP version endpoint: {}", e)))?;

        let json: Value = res
            .json()
            .await
            .map_err(|e| ReachError::BrowserError(format!("Invalid CDP version JSON: {}", e)))?;

        json.get("webSocketDebuggerUrl")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| {
                ReachError::BrowserError("Missing webSocketDebuggerUrl in CDP version response".to_string())
            })
    }

    /// Retrieves a Page target WebSocket URL from the running CDP instance.
    pub async fn get_page_ws_debugger_url(&self) -> Result<String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| Client::new());

        // 1. Try /json/list to find an existing page target
        let list_url = format!("http://{}:{}/json/list", self.host, self.port);
        if let Ok(res) = client.get(&list_url).send().await {
            if let Ok(targets) = res.json::<Vec<Value>>().await {
                for target in targets {
                    if target.get("type").and_then(|t| t.as_str()) == Some("page") {
                        if let Some(ws) = target.get("webSocketDebuggerUrl").and_then(|u| u.as_str()) {
                            return Ok(ws.to_string());
                        }
                    }
                }
            }
        }

        // 2. If no page target exists, create a new tab via /json/new
        let new_url = format!("http://{}:{}/json/new?about:blank", self.host, self.port);
        if let Ok(res) = client.put(&new_url).send().await {
            if let Ok(target) = res.json::<Value>().await {
                if let Some(ws) = target.get("webSocketDebuggerUrl").and_then(|u| u.as_str()) {
                    return Ok(ws.to_string());
                }
            }
        }

        // 3. Fall back to the browser level endpoint.
        self.get_ws_debugger_url().await
    }

    /// The browser executable that would be used.
    pub fn find_browser_executable() -> Option<PathBuf> {
        BrowserProvider::resolve(None)
            .ok()
            .map(|provider| provider.executable().to_path_buf())
    }

    /// The profile directory used for the session.
    pub fn profile_directory(&self) -> PathBuf {
        std::env::temp_dir().join(format!("reach_profile_{}", self.port))
    }

    /// Launches the browser process.
    ///
    /// The switches come from the environment profile, so the browser starts
    /// out with the right window size, language and network policy already in
    /// place, before the first request is made.
    pub fn launch(
        &self,
        headless: bool,
        profile: &PersonaProfile,
        provider: &BrowserProvider,
    ) -> Result<Child> {
        let plan = fingerprint::build_plan(profile, provider);

        let user_data_dir = self.profile_directory();
        let _ = std::fs::create_dir_all(&user_data_dir);

        let mut cmd = Command::new(provider.executable());
        cmd.arg(format!("--remote-debugging-port={}", self.port))
            .arg(format!("--user-data-dir={}", user_data_dir.display()));

        for switch in &plan.cli_switches {
            cmd.arg(switch);
        }

        if headless {
            cmd.arg("--headless=new");
        }

        cmd.arg("about:blank");

        let child = cmd
            .spawn()
            .map_err(|e| ReachError::BrowserError(format!("Failed to spawn browser process: {}", e)))?;

        Ok(child)
    }

    /// Stops the browser process tree.
    pub fn stop(&self, child: &mut Child) {
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &child.id().to_string()])
                .output();
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
}

/// Reads the browser version from a running browser.
pub async fn browser_version(ws_url: &str) -> Result<(u32, String)> {
    let client = crate::cdp::CdpClient::new(ws_url);
    client.connect().await?;
    let result = client.call("Browser.getVersion", serde_json::json!({})).await?;
    let product = result
        .get("product")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ReachError::BrowserError("The browser did not report a version".to_string()))?;

    let version = product
        .split('/')
        .nth(1)
        .ok_or_else(|| ReachError::BrowserError(format!("Unexpected version string {}", product)))?
        .to_string();

    let major = version
        .split('.')
        .next()
        .and_then(|m| m.parse::<u32>().ok())
        .unwrap_or(155);

    Ok((major, version))
}

/// Whether a path points at a file.
pub fn is_file(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;
    use reach_persona::{GeneratorConfig, PersonaGenerator};

    fn profile() -> PersonaProfile {
        PersonaGenerator::new(GeneratorConfig {
            seed: Some(11),
            country: Some("US".to_string()),
            browser_major: 155,
            browser_full_version: "155.0.0.0".to_string(),
            noise_secret: Some(3),
        })
        .generate()
    }

    #[test]
    fn test_launcher_instantiation() {
        let launcher = BrowserLauncher::new("127.0.0.1", 9222);
        assert_eq!(launcher.port(), 9222);
        assert_eq!(launcher.host(), "127.0.0.1");
    }

    #[test]
    fn test_profile_directory_is_stable() {
        let launcher = BrowserLauncher::new("127.0.0.1", 9333);
        assert_eq!(launcher.profile_directory(), launcher.profile_directory());
        assert!(launcher
            .profile_directory()
            .to_string_lossy()
            .contains("reach_profile_9333"));
    }

    #[tokio::test]
    async fn test_is_running_is_false_for_an_unused_port() {
        let launcher = BrowserLauncher::new("127.0.0.1", 59321);
        assert!(!launcher.is_running().await);
    }

    #[test]
    fn test_launch_does_not_panic_without_a_browser() {
        // The function must report a clear error rather than panic when no
        // browser is installed.
        let launcher = BrowserLauncher::new("127.0.0.1", 9222);
        if BrowserProvider::resolve(None).is_err() {
            let provider = BrowserProvider {
                executable: PathBuf::from("chrome.exe"),
                label: "chrome.exe".to_string(),
                supports_persona_switches: false,
                known_switches: std::collections::HashSet::new(),
            };
            let result = launcher.launch(true, &profile(), &provider);
            assert!(result.is_err());
        }
    }
}
