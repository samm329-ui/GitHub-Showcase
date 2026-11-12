use reach_core::error::{ReachError, Result};
use reach_core::model::{PageContent, Platform};
use reqwest::Client;
use std::time::Duration;

pub struct RssChannel {
    client: Client,
}

impl RssChannel {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("Fortress-Reach/0.1.0")
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { client }
    }

    /// Fetches and parses an RSS or Atom feed into clean Markdown.
    pub async fn read_feed(&self, url: &str) -> Result<PageContent> {
        let res = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| ReachError::Network(e.to_string()))?;

        let bytes = res
            .bytes()
            .await
            .map_err(|e| ReachError::Network(e.to_string()))?;

        let feed = feed_rs::parser::parse(&bytes[..])
            .map_err(|e| ReachError::ChannelError {
                channel: "rss".to_string(),
                reason: format!("Failed to parse RSS/Atom feed: {}", e),
            })?;

        let feed_title = feed
            .title
            .map(|t| t.content)
            .unwrap_or_else(|| "RSS Feed".to_string());

        let mut output = format!("# {}\n\n**Feed URL:** {}\n\n---\n", feed_title, url);

        for entry in feed.entries.iter().take(20) {
            let title = entry
                .title
                .as_ref()
                .map(|t| t.content.clone())
                .unwrap_or_else(|| "Untitled".to_string());

            let link = entry
                .links
                .first()
                .map(|l| l.href.clone())
                .unwrap_or_default();

            let summary = entry
                .summary
                .as_ref()
                .map(|s| s.content.clone())
                .or_else(|| entry.content.as_ref().and_then(|c| c.body.clone()))
                .unwrap_or_default();

            let clean_summary = crate::parser::html_to_markdown(&summary);

            output.push_str(&format!("### [{}]({})\n\n{}\n\n---\n", title, link, clean_summary));
        }

        let mut page = PageContent::new(url, output, Platform::Rss);
        page.title = Some(feed_title);
        Ok(page)
    }
}

impl Default for RssChannel {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_rss_xml_parsing() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
        <rss version="2.0">
            <channel>
                <title>Rust Blog</title>
                <link>https://blog.rust-lang.org</link>
                <item>
                    <title>Announcing Rust 1.98</title>
                    <link>https://blog.rust-lang.org/2026/rust-1-98.html</link>
                    <description>Rust 1.98 brings exciting new features.</description>
                </item>
            </channel>
        </rss>"#;

        let feed = feed_rs::parser::parse(xml.as_bytes()).unwrap();
        assert_eq!(feed.title.unwrap().content, "Rust Blog");
        assert_eq!(feed.entries.len(), 1);
        assert_eq!(feed.entries[0].title.as_ref().unwrap().content, "Announcing Rust 1.98");
    }
}
