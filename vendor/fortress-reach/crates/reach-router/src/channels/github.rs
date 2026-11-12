use reach_core::error::{ReachError, Result};
use reach_core::model::{PageContent, Platform};
use regex::Regex;
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

pub struct GitHubChannel {
    client: Client,
}

impl GitHubChannel {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("Fortress-Reach/0.1.0")
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { client }
    }

    /// Extracts owner and repo from a GitHub URL.
    pub fn parse_github_url(url: &str) -> Option<(String, String)> {
        let re = Regex::new(r"github\.com/([a-zA-Z0-9_-]+)/([a-zA-Z0-9_.-]+)").ok()?;
        let caps = re.captures(url)?;
        let owner = caps.get(1)?.as_str().to_string();
        let repo = caps.get(2)?.as_str().trim_end_matches(".git").to_string();
        Some((owner, repo))
    }

    /// Reads repository metadata and README.
    pub async fn read_repo(&self, url: &str) -> Result<PageContent> {
        let (owner, repo) = Self::parse_github_url(url).ok_or_else(|| {
            ReachError::ChannelError {
                channel: "github".to_string(),
                reason: format!("Could not parse owner and repo from: {}", url),
            }
        })?;

        let repo_api = format!("https://api.github.com/repos/{}/{}", owner, repo);
        let resp = self
            .client
            .get(&repo_api)
            .header("Accept", "application/vnd.github.v3+json")
            .send()
            .await
            .map_err(|e| ReachError::Network(e.to_string()))?;

        if !resp.status().is_success() {
            // Fallback: Use Jina Reader
            let jina_url = format!("https://r.jina.ai/{}", url);
            let text = self
                .client
                .get(&jina_url)
                .send()
                .await
                .map_err(|e| ReachError::Network(e.to_string()))?
                .text()
                .await
                .map_err(|e| ReachError::Network(e.to_string()))?;

            return Ok(PageContent::new(url, text, Platform::GitHub));
        }

        let json: Value = resp
            .json()
            .await
            .map_err(|e| ReachError::Network(e.to_string()))?;

        let full_name = json["full_name"].as_str().unwrap_or("Unknown");
        let description = json["description"].as_str().unwrap_or("No description");
        let stars = json["stargazers_count"].as_u64().unwrap_or(0);
        let forks = json["forks_count"].as_u64().unwrap_or(0);
        let open_issues = json["open_issues_count"].as_u64().unwrap_or(0);
        let license = json["license"]["spdx_id"].as_str().unwrap_or("None");

        let content = format!(
            "# Repository: {}\n\n{}\n\n**Stars:** ⭐ {} | **Forks:** 🍴 {} | **Issues:** ⚠️ {} | **License:** ⚖️ {}\n\n---\n*Extracted via GitHub API*",
            full_name, description, stars, forks, open_issues, license
        );

        let mut page = PageContent::new(url, content, Platform::GitHub);
        page.title = Some(full_name.to_string());
        Ok(page)
    }
}

impl Default for GitHubChannel {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_github_url() {
        assert_eq!(
            GitHubChannel::parse_github_url("https://github.com/rust-lang/rust"),
            Some(("rust-lang".to_string(), "rust".to_string()))
        );
        assert_eq!(
            GitHubChannel::parse_github_url("https://github.com/serde-rs/serde.git"),
            Some(("serde-rs".to_string(), "serde".to_string()))
        );
        assert_eq!(GitHubChannel::parse_github_url("https://google.com"), None);
    }
}
