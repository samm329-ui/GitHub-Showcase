use reach_core::error::{ReachError, Result};
use reach_core::model::{PageContent, Platform};
use reqwest::Client;
use std::time::Duration;

pub struct WebChannel {
    client: Client,
}

impl WebChannel {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { client }
    }

    /// Fetches the given URL via Jina Reader for clean Markdown extraction.
    /// Falls back to direct HTTP fetch with our local parser if Jina fails.
    pub async fn read(&self, target_url: &str) -> Result<PageContent> {
        let jina_url = format!("https://r.jina.ai/{}", target_url);

        let res = self
            .client
            .get(&jina_url)
            .header("Accept", "text/plain")
            .send()
            .await;

        match res {
            Ok(response) if response.status().is_success() => {
                let text = response
                    .text()
                    .await
                    .map_err(|e| ReachError::Network(e.to_string()))?;

                if crate::parser::is_bot_challenge(&text) {
                    let mut page = PageContent::new(target_url, text, Platform::Web);
                    page.requires_stealth = true;
                    return Ok(page);
                }

                Ok(PageContent::new(target_url, text, Platform::Web))
            }
            _ => {
                // Fallback: Direct HTTP request
                self.read_direct(target_url).await
            }
        }
    }

    /// Direct fetch fallback if the reader proxy is unavailable.
    pub async fn read_direct(&self, target_url: &str) -> Result<PageContent> {
        let response = self
            .client
            .get(target_url)
            .send()
            .await
            .map_err(|e| ReachError::Network(format!("Direct fetch failed: {}", e)))?;

        let body = response
            .text()
            .await
            .map_err(|e| ReachError::Network(e.to_string()))?;

        if crate::parser::is_bot_challenge(&body) {
            let mut page = PageContent::new(target_url, body, Platform::Web);
            page.requires_stealth = true;
            return Ok(page);
        }

        let markdown = crate::parser::html_to_markdown(&body);
        Ok(PageContent::new(target_url, markdown, Platform::Web))
    }
}

impl Default for WebChannel {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_web_channel_instantiation() {
        let channel = WebChannel::new();
        assert!(channel.client.get("https://example.com").build().is_ok());
    }
}
