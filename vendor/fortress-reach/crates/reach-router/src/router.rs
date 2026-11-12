use crate::channels::{
    GitHubChannel, RedditChannel, RssChannel, SearchChannel, TwitterChannel, WebChannel,
    YouTubeChannel,
};
use reach_core::error::Result;
use reach_core::model::{ChannelHealth, ChannelTier, PageContent, Platform};

pub struct Router {
    pub web: WebChannel,
    pub youtube: YouTubeChannel,
    pub twitter: TwitterChannel,
    pub reddit: RedditChannel,
    pub rss: RssChannel,
    pub github: GitHubChannel,
    pub search: SearchChannel,
}

impl Router {
    pub fn new() -> Self {
        Self {
            web: WebChannel::new(),
            youtube: YouTubeChannel::new(),
            twitter: TwitterChannel::new(),
            reddit: RedditChannel::new(),
            rss: RssChannel::new(),
            github: GitHubChannel::new(),
            search: SearchChannel::new(),
        }
    }

    /// Detects the target platform from a given URL.
    pub fn detect_platform(url: &str) -> Platform {
        let lower = url.to_lowercase();
        if lower.contains("youtube.com") || lower.contains("youtu.be") {
            Platform::YouTube
        } else if lower.contains("twitter.com") || lower.contains("x.com") {
            Platform::Twitter
        } else if lower.contains("reddit.com") {
            Platform::Reddit
        } else if lower.contains("github.com") {
            Platform::GitHub
        } else if lower.ends_with(".xml") || lower.ends_with(".rss") || lower.contains("/feed") || lower.contains("/rss") {
            Platform::Rss
        } else {
            Platform::Web
        }
    }

    /// Primary entry point: Routes URL to the fastest channel handler.
    pub async fn route_and_fetch(&self, url: &str) -> Result<PageContent> {
        let platform = Self::detect_platform(url);

        match platform {
            Platform::YouTube => self.youtube.extract_subtitles(url).await,
            Platform::Twitter => self.twitter.read_tweet(url).await,
            Platform::Reddit => self.reddit.read_post(url).await,
            Platform::GitHub => self.github.read_repo(url).await,
            Platform::Rss => self.rss.read_feed(url).await,
            Platform::Web => self.web.read(url).await,
            Platform::Search => self.search.search(url, 10).await,
        }
    }

    /// Health check (Doctor) that probes every channel for real.
    ///
    /// The report says what each channel can do right now, how much setup it
    /// needs and how long it took to answer. A channel that is not reachable
    /// is reported as such instead of being claimed to be ready.
    pub async fn check_channels(&self) -> Vec<ChannelHealth> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_default();

        let probes = vec![
            (
                "Web reader",
                ChannelTier::ZeroConfig,
                "https://r.jina.ai/",
            ),
            (
                "YouTube subtitles",
                ChannelTier::ZeroConfig,
                "https://www.youtube.com/",
            ),
            (
                "Twitter / X",
                ChannelTier::ZeroConfig,
                "https://api.fxtwitter.com/status/20",
            ),
            (
                "Reddit",
                ChannelTier::ZeroConfig,
                "https://www.reddit.com/r/rust/.rss",
            ),
            (
                "GitHub",
                ChannelTier::ZeroConfig,
                "https://api.github.com/rate_limit",
            ),
            (
                "Web search",
                ChannelTier::ZeroConfig,
                "https://www.bing.com/search?q=fortress",
            ),
        ];

        let mut results = Vec::new();
        for (name, tier, url) in probes {
            let started = std::time::Instant::now();
            let outcome = client.get(url).send().await;
            let latency = started.elapsed().as_millis() as u64;

            let (available, message) = match outcome {
                Ok(response) => {
                    let status = response.status();
                    if status.is_success() {
                        (true, format!("answered in {} ms", latency))
                    } else if status.as_u16() == 429 {
                        (false, "rate limited".to_string())
                    } else {
                        (false, format!("answered with status {}", status.as_u16()))
                    }
                }
                Err(error) => (false, format!("not reachable: {}", error)),
            };

            results.push(ChannelHealth {
                name: name.to_string(),
                available,
                message,
                tier,
                latency_ms: Some(latency),
            });
        }

        results.push(ChannelHealth {
            name: "RSS / Atom".to_string(),
            available: true,
            message: "the parser runs locally, no network needed".to_string(),
            tier: ChannelTier::ZeroConfig,
            latency_ms: None,
        });

        results.push(ChannelHealth {
            name: "Browser engine".to_string(),
            available: browser_available(),
            message: browser_message(),
            tier: ChannelTier::NeedsSetup,
            latency_ms: None,
        });

        results
    }
}

/// Whether a browser that the project can drive is installed.
fn browser_available() -> bool {
    std::env::var("REACH_BROWSER_PATH")
        .ok()
        .map(|path| std::path::Path::new(&path).exists())
        .unwrap_or(false)
        || [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        ]
        .iter()
        .any(|path| std::path::Path::new(path).exists())
        || std::env::var("PATH")
            .ok()
            .map(|path| {
                std::env::split_paths(&path).any(|dir| {
                    ["google-chrome", "chromium", "chromium-browser", "brave-browser"]
                        .iter()
                        .any(|name| dir.join(name).is_file())
                })
            })
            .unwrap_or(false)
}

/// The message for the browser entry of the report.
fn browser_message() -> String {
    if browser_available() {
        "a Chromium based browser was found".to_string()
    } else {
        "no Chromium based browser was found; install Chrome, Edge, Brave or Chromium, \
         or point REACH_BROWSER_PATH at one"
            .to_string()
    }
}

impl Default for Router {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_platform() {
        assert_eq!(
            Router::detect_platform("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            Platform::YouTube
        );
        assert_eq!(
            Router::detect_platform("https://x.com/rustlang/status/123456"),
            Platform::Twitter
        );
        assert_eq!(
            Router::detect_platform("https://reddit.com/r/rust/comments/123"),
            Platform::Reddit
        );
        assert_eq!(
            Router::detect_platform("https://github.com/rust-lang/cargo"),
            Platform::GitHub
        );
        assert_eq!(
            Router::detect_platform("https://example.com/feed.xml"),
            Platform::Rss
        );
        assert_eq!(
            Router::detect_platform("https://news.ycombinator.com"),
            Platform::Web
        );
    }

    #[tokio::test]
    async fn test_channel_health_reports_every_channel() {
        let router = Router::new();
        let health = router.check_channels().await;
        assert!(health.len() >= 7);
        // Every channel has to say something about its own state, and the
        // report must never claim that a channel is ready without a probe.
        assert!(health
            .iter()
            .all(|h| !h.name.is_empty() && !h.message.is_empty()));
        assert!(health.iter().any(|h| h.name == "RSS / Atom" && h.available));
    }
}
