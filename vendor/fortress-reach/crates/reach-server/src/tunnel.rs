use regex::Regex;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, RwLock};
use tracing::{error, info};

#[derive(Clone)]
pub struct TunnelManager {
    public_url: Arc<RwLock<Option<String>>>,
    /// The tunnel process, kept so that it can be supervised and stopped.
    process: Arc<Mutex<Option<Child>>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            public_url: Arc::new(RwLock::new(None)),
            process: Arc::new(Mutex::new(None)),
        }
    }

    /// Returns the currently active public Cloudflare Tunnel URL synchronously, if connected.
    pub fn get_public_url_sync(&self) -> Option<String> {
        let guard = self.public_url.read().ok()?;
        guard.clone()
    }

    /// Returns the currently active public Cloudflare Tunnel URL, if connected.
    pub async fn get_public_url(&self) -> Option<String> {
        self.get_public_url_sync()
    }

    /// Whether the tunnel process is still running.
    pub fn is_running(&self) -> bool {
        let mut guard = match self.process.lock() {
            Ok(guard) => guard,
            Err(_) => return false,
        };
        match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    }

    /// Stops the tunnel process.
    pub fn stop(&self) {
        if let Ok(mut guard) = self.process.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }

    /// Spawns `cloudflared` in a background thread and watches for the assigned URL.
    pub fn start_tunnel(&self, local_port: u16) -> Option<Child> {
        self.start_tunnel_with_token(local_port, None, None)
    }

    /// Spawns `cloudflared` with optional named token or custom domain for persistent tunneling.
    pub fn start_tunnel_with_token(
        &self,
        local_port: u16,
        token: Option<&str>,
        permanent_domain: Option<&str>,
    ) -> Option<Child> {
        let cloudflared_bin = Self::find_cloudflared_executable().unwrap_or_else(|| "cloudflared".to_string());

        let mut cmd = Command::new(&cloudflared_bin);
        let has_token = token.map(|t| !t.trim().is_empty()).unwrap_or(false);

        if let Some(tok) = token.filter(|t| !t.trim().is_empty()) {
            info!("Starting persistent Cloudflare Tunnel with dedicated token.");
            cmd.args(["tunnel", "run", "--token", tok.trim()]);
        } else {
            cmd.args(["tunnel", "--url", &format!("http://127.0.0.1:{}", local_port)]);
        }

        let mut child = match cmd
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(e) => {
                error!("Could not launch cloudflared: {}. Please ensure cloudflared is installed.", e);
                return None;
            }
        };

        let stderr = child.stderr.take();
        let public_url_store = self.public_url.clone();
        let fallback_permanent = permanent_domain.map(|s| s.to_string());

        if has_token {
            if let Some(domain) = fallback_permanent.clone() {
                let formatted = if domain.starts_with("http") { domain } else { format!("https://{}", domain) };
                if let Ok(mut guard) = public_url_store.write() {
                    *guard = Some(formatted);
                }
            }
        }

        // Spawn a background thread to read stderr output for the assigned URL
        if let Some(err_stream) = stderr {
            std::thread::spawn(move || {
                let reader = BufReader::new(err_stream);
                let re = Regex::new(r"https://[a-zA-Z0-9-.]+\.(trycloudflare\.com|[a-zA-Z0-9-.]+)").unwrap();

                for line_result in reader.lines() {
                    let Ok(line) = line_result else { continue };
                    if let Some(mat) = re.find(&line) {
                        let url = mat.as_str().to_string();
                        info!("Assigned Cloudflare Tunnel URL: {}", url);
                        if let Ok(mut guard) = public_url_store.write() {
                            *guard = Some(url);
                        }
                        break;
                    }
                }

                if let Some(domain) = fallback_permanent {
                    if let Ok(mut guard) = public_url_store.write() {
                        if guard.is_none() {
                            let formatted = if domain.starts_with("http") { domain } else { format!("https://{}", domain) };
                            *guard = Some(formatted);
                        }
                    }
                }
            });
        }

        // Keep the handle, so that the process can be stopped later instead of
        // being left behind without a supervisor.
        if let Ok(mut guard) = self.process.lock() {
            *guard = Some(child);
        }

        None
    }

    /// Locates the `cloudflared` binary on Windows or Unix systems.
    pub fn find_cloudflared_executable() -> Option<String> {
        #[cfg(target_os = "windows")]
        {
            let candidates = [
                r"C:\Program Files\cloudflared\cloudflared.exe",
                r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
                r"C:\cloudflared\cloudflared.exe",
            ];

            for path in candidates {
                if std::path::Path::new(path).exists() {
                    return Some(path.to_string());
                }
            }

            // Check using Windows 'where.exe'
            if let Ok(output) = Command::new("where").arg("cloudflared").output() {
                if output.status.success() {
                    if let Ok(text) = String::from_utf8(output.stdout) {
                        if let Some(first_line) = text.lines().next() {
                            return Some(first_line.trim().to_string());
                        }
                    }
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(output) = Command::new("which").arg("cloudflared").output() {
                if output.status.success() {
                    if let Ok(text) = String::from_utf8(output.stdout) {
                        return Some(text.trim().to_string());
                    }
                }
            }
        }

        None
    }
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_tunnel_manager_state() {
        let manager = TunnelManager::new();
        assert_eq!(manager.get_public_url().await, None);

        {
            let mut guard = manager.public_url.write().unwrap();
            *guard = Some("https://test-subdomain.trycloudflare.com".to_string());
        }

        assert_eq!(
            manager.get_public_url().await,
            Some("https://test-subdomain.trycloudflare.com".to_string())
        );
    }

    #[test]
    fn test_regex_url_matching() {
        let line = "2026-10-21T09:30:00Z INF +--------------------------------------------------------+";
        let line2 = "2026-10-21T09:30:00Z INF |  https://happy-cat-1234.trycloudflare.com            |";
        let re = Regex::new(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com").unwrap();

        assert!(!re.is_match(line));
        assert!(re.is_match(line2));
        assert_eq!(
            re.find(line2).unwrap().as_str(),
            "https://happy-cat-1234.trycloudflare.com"
        );
    }
}
