use reach_core::error::{ReachError, Result};
use reach_core::model::{PageContent, Platform};
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

pub struct RedditChannel {
    client: Client,
}

impl RedditChannel {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { client }
    }

    /// Fetches a Reddit post and comments.
    pub async fn read_post(&self, url: &str) -> Result<PageContent> {
        // Strip trailing query params and ensure ending with .json
        let clean_url = url.split('?').next().unwrap_or(url).trim_end_matches('/');
        let json_url = format!("{}.json", clean_url);

        let res = self.client.get(&json_url).send().await;

        match res {
            Ok(response) if response.status().is_success() => {
                let text = response
                    .text()
                    .await
                    .map_err(|e| ReachError::Network(e.to_string()))?;

                if let Ok(json) = serde_json::from_str::<Value>(&text) {
                    if let Some(content) = Self::format_reddit_json(&json) {
                        return Ok(PageContent::new(url, content, Platform::Reddit));
                    }
                }

                // If JSON parsing failed, fallback to RSS or Jina
                self.read_via_rss_or_jina(url).await
            }
            _ => self.read_via_rss_or_jina(url).await,
        }
    }

    async fn read_via_rss_or_jina(&self, url: &str) -> Result<PageContent> {
        let clean_url = url.split('?').next().unwrap_or(url).trim_end_matches('/');
        let rss_url = format!("{}.rss", clean_url);
        if let Ok(resp) = self.client.get(&rss_url).send().await {
            if resp.status().is_success() {
                if let Ok(bytes) = resp.bytes().await {
                    if let Ok(feed) = feed_rs::parser::parse(&bytes[..]) {
                        let feed_title = feed
                            .title
                            .map(|t| t.content)
                            .unwrap_or_else(|| "Reddit Feed".to_string());
                        let mut output = format!("# {}\n\n**Source:** {}\n\n---\n", feed_title, url);
                        for entry in feed.entries.iter().take(15) {
                            let title = entry
                                .title
                                .as_ref()
                                .map(|t| t.content.clone())
                                .unwrap_or_else(|| "Post".to_string());
                            let link = entry.links.first().map(|l| l.href.clone()).unwrap_or_default();
                            let summary = entry
                                .summary
                                .as_ref()
                                .map(|s| s.content.clone())
                                .or_else(|| entry.content.as_ref().and_then(|c| c.body.clone()))
                                .unwrap_or_default();
                            let clean_summary = crate::parser::html_to_markdown(&summary);
                            output.push_str(&format!("### [{}]({})\n\n{}\n\n---\n", title, link, clean_summary));
                        }
                        if !output.is_empty() {
                            let mut page = PageContent::new(url, output, Platform::Reddit);
                            page.title = Some(feed_title);
                            return Ok(page);
                        }
                    }
                }
            }
        }

        self.read_via_jina(url).await
    }

    async fn read_via_jina(&self, url: &str) -> Result<PageContent> {
        let jina_url = format!("https://r.jina.ai/{}", url);
        let resp = self
            .client
            .get(&jina_url)
            .send()
            .await
            .map_err(|e| ReachError::Network(e.to_string()))?;

        let body = resp
            .text()
            .await
            .map_err(|e| ReachError::Network(e.to_string()))?;

        let is_blocked = body.contains("403 Forbidden") || body.contains("Attention Required");
        let mut page = PageContent::new(url, body, Platform::Reddit);
        page.requires_stealth = is_blocked;
        Ok(page)
    }

    fn format_reddit_json(json: &Value) -> Option<String> {
        let array = json.as_array()?;
        let post_data = array.first()?.get("data")?.get("children")?.get(0)?.get("data")?;

        let title = post_data.get("title")?.as_str()?;
        let author = post_data.get("author")?.as_str().unwrap_or("[deleted]");
        let selftext = post_data.get("selftext")?.as_str().unwrap_or("");
        let subreddit = post_data.get("subreddit_name_prefixed")?.as_str().unwrap_or("r/reddit");

        let mut output = format!("# {}\n\n**Subreddit:** {} | **Author:** u/{}\n\n{}\n\n---\n### Top Comments:\n\n", title, subreddit, author, selftext);

        // Extract comments if present
        if let Some(comments_listing) = array.get(1) {
            if let Some(children) = comments_listing.get("data").and_then(|d| d.get("children")).and_then(|c| c.as_array()) {
                for comment in children.iter().take(10) {
                    if let Some(data) = comment.get("data") {
                        if let (Some(c_author), Some(c_body)) = (data.get("author").and_then(|a| a.as_str()), data.get("body").and_then(|b| b.as_str())) {
                            output.push_str(&format!("**u/{}**: {}\n\n", c_author, c_body.trim()));
                        }
                    }
                }
            }
        }

        Some(output)
    }
}

impl Default for RedditChannel {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_reddit_json() {
        let sample = serde_json::json!([
            {
                "data": {
                    "children": [{
                        "data": {
                            "title": "Rust is blazing fast",
                            "author": "rustacean",
                            "selftext": "Benchmarks show amazing performance.",
                            "subreddit_name_prefixed": "r/rust"
                        }
                    }]
                }
            },
            {
                "data": {
                    "children": [{
                        "data": {
                            "author": "commenter1",
                            "body": "Totally agree with this!"
                        }
                    }]
                }
            }
        ]);

        let formatted = RedditChannel::format_reddit_json(&sample).unwrap();
        assert!(formatted.contains("Rust is blazing fast"));
        assert!(formatted.contains("commenter1"));
        assert!(formatted.contains("Totally agree with this!"));
    }
}
