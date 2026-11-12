use reach_core::error::{ReachError, Result};
use reach_core::model::{PageContent, Platform};
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;
use url::Url;

pub struct TwitterChannel {
    client: Client,
}

impl TwitterChannel {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { client }
    }

    /// Reads a tweet or profile. First tries public syndication API, then Jina, then escalates to stealth browser.
    pub async fn read_tweet(&self, raw_url: &str) -> Result<PageContent> {
        // 1. Try public FXTwitter syndication API for bypass of login walls
        if let Some(parsed) = self.fetch_via_syndication(raw_url).await {
            return Ok(PageContent::new(raw_url, parsed, Platform::Twitter));
        }

        // 2. Fallback to Jina Reader
        let jina_url = format!("https://r.jina.ai/{}", raw_url);
        let resp = self.client.get(&jina_url).send().await;

        match resp {
            Ok(response) if response.status().is_success() => {
                let text = response
                    .text()
                    .await
                    .map_err(|e| ReachError::Network(e.to_string()))?;

                let lower = text.to_lowercase();
                if lower.contains("sign in to x")
                    || lower.contains("login to twitter")
                    || lower.contains("something went wrong")
                    || lower.contains("rate limit")
                {
                    let mut page = PageContent::new(raw_url, text, Platform::Twitter);
                    page.requires_stealth = true;
                    return Ok(page);
                }

                Ok(PageContent::new(raw_url, text, Platform::Twitter))
            }
            _ => {
                let mut page = PageContent::new(
                    raw_url,
                    "Twitter request requires stealth browser session.",
                    Platform::Twitter,
                );
                page.requires_stealth = true;
                Ok(page)
            }
        }
    }

    async fn fetch_via_syndication(&self, raw_url: &str) -> Option<String> {
        let parsed_url = Url::parse(raw_url).ok()?;
        let path = parsed_url.path();
        if path.is_empty() || path == "/" {
            return None;
        }

        let api_url = format!("https://api.fxtwitter.com{}", path);
        let resp = self.client.get(&api_url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }

        let data: Value = resp.json().await.ok()?;

        // Check if it's a tweet object
        if let Some(tweet) = data.get("tweet") {
            let author_name = tweet
                .get("author")
                .and_then(|a| a.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("Twitter User");
            let screen_name = tweet
                .get("author")
                .and_then(|a| a.get("screen_name"))
                .and_then(|v| v.as_str())
                .unwrap_or("user");
            let text = tweet.get("text").and_then(|v| v.as_str()).unwrap_or("");
            let likes = tweet.get("likes").and_then(|v| v.as_u64()).unwrap_or(0);
            let retweets = tweet.get("retweets").and_then(|v| v.as_u64()).unwrap_or(0);
            let replies = tweet.get("replies").and_then(|v| v.as_u64()).unwrap_or(0);
            let views = tweet.get("views").and_then(|v| v.as_u64()).unwrap_or(0);
            let created_at = tweet.get("created_at").and_then(|v| v.as_str()).unwrap_or("");

            let md = format!(
                "# Tweet by {} (@{})\n\n> {}\n\n**Likes:** {} | **Retweets:** {} | **Replies:** {} | **Views:** {}\n**Date:** {}\n**Source:** {}\n\n---\n*Extracted via Twitter Syndication Channel*",
                author_name, screen_name, text, likes, retweets, replies, views, created_at, raw_url
            );
            return Some(md);
        }

        // Check if it's a user profile object
        if let Some(user) = data.get("user") {
            let name = user.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let screen_name = user
                .get("screen_name")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let bio = user
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("No bio provided.");
            let followers = user.get("followers").and_then(|v| v.as_u64()).unwrap_or(0);
            let following = user.get("following").and_then(|v| v.as_u64()).unwrap_or(0);
            let likes = user.get("likes").and_then(|v| v.as_u64()).unwrap_or(0);
            let tweets = user.get("tweets").and_then(|v| v.as_u64()).unwrap_or(0);
            let joined = user.get("joined").and_then(|v| v.as_str()).unwrap_or("");

            let md = format!(
                "# Twitter/X Profile: {} (@{})\n\n**Bio:** {}\n\n**Followers:** {} | **Following:** {} | **Likes:** {} | **Tweets:** {}\n**Joined:** {}\n**Link:** [{}]({})\n\n---\n*Extracted via Twitter Syndication Channel*",
                name, screen_name, bio, followers, following, likes, tweets, joined, raw_url, raw_url
            );
            return Some(md);
        }

        None
    }
}

impl Default for TwitterChannel {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_twitter_channel_instantiation() {
        let channel = TwitterChannel::new();
        assert!(channel.client.get("https://x.com").build().is_ok());
    }
}
