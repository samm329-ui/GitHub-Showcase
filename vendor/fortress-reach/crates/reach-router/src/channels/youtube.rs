use reach_core::error::{ReachError, Result};
use reach_core::model::{PageContent, Platform};
use regex::Regex;
use reqwest::Client;
use std::time::Duration;

pub struct YouTubeChannel {
    client: Client,
}

impl YouTubeChannel {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { client }
    }

    /// Extracts the 11-character YouTube video ID from various URL formats.
    pub fn extract_video_id(url: &str) -> Option<String> {
        let patterns = [
            r"(?:v=|\/v\/|youtu\.be\/|\/embed\/|\/shorts\/)([a-zA-Z0-9_-]{11})",
            r"^([a-zA-Z0-9_-]{11})$",
        ];

        for pattern in patterns {
            let re = Regex::new(pattern).ok()?;
            if let Some(caps) = re.captures(url) {
                if let Some(id) = caps.get(1) {
                    return Some(id.as_str().to_string());
                }
            }
        }
        None
    }

    /// Extracts subtitles and video transcript without downloading the video file.
    pub async fn extract_subtitles(&self, url: &str) -> Result<PageContent> {
        let video_id = Self::extract_video_id(url).ok_or_else(|| {
            ReachError::ChannelError {
                channel: "youtube".to_string(),
                reason: format!("Could not parse valid YouTube video ID from: {}", url),
            }
        })?;

        let watch_url = format!("https://www.youtube.com/watch?v={}", video_id);
        let html = self
            .client
            .get(&watch_url)
            .header("Accept-Language", "en-US,en;q=0.9")
            .send()
            .await
            .map_err(|e| ReachError::Network(e.to_string()))?
            .text()
            .await
            .map_err(|e| ReachError::Network(e.to_string()))?;

        // Extract title
        let title_re = Regex::new(r#"<title>(.*?)</title>"#).unwrap();
        let title = title_re
            .captures(&html)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().replace(" - YouTube", ""))
            .unwrap_or_else(|| format!("YouTube Video ({})", video_id));

        // Look for captionTracks in the player response
        let caption_url_re = Regex::new(r#""captionTracks":\[\{"baseUrl":"([^"]+)""#).unwrap();
        if let Some(caps) = caption_url_re.captures(&html) {
            if let Some(base_url_match) = caps.get(1) {
                let caption_url = base_url_match
                    .as_str()
                    .replace(r"\u0026", "&")
                    .replace(r"\/", "/");

                let transcript_xml = self
                    .client
                    .get(&caption_url)
                    .send()
                    .await
                    .map_err(|e| ReachError::Network(e.to_string()))?
                    .text()
                    .await
                    .map_err(|e| ReachError::Network(e.to_string()))?;

                let clean_transcript = Self::parse_xml_transcript(&transcript_xml);
                let content = format!(
                    "# {}\n\n**Video ID:** {}\n**URL:** {}\n\n## Transcript:\n\n{}",
                    title, video_id, watch_url, clean_transcript
                );

                let mut page = PageContent::new(url, content, Platform::YouTube);
                page.title = Some(title);
                return Ok(page);
            }
        }

        // If no captions were found, return metadata
        let content = format!(
            "# {}\n\n**Video ID:** {}\n**URL:** {}\n\n*(No auto-generated or manual captions available for this video)*",
            title, video_id, watch_url
        );
        let mut page = PageContent::new(url, content, Platform::YouTube);
        page.title = Some(title);
        Ok(page)
    }

    /// Parses YouTube TimedText XML subtitle nodes into clean text.
    pub fn parse_xml_transcript(xml: &str) -> String {
        let text_re = Regex::new(r#"(?s)<text[^>]*>(.*?)</text>"#).unwrap();
        let mut transcript = String::new();

        for cap in text_re.captures_iter(xml) {
            if let Some(t) = cap.get(1) {
                let decoded = t
                    .as_str()
                    .replace("&amp;", "&")
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                    .replace("&quot;", "\"")
                    .replace("&#39;", "'")
                    .replace("\n", " ");
                let trimmed = decoded.trim();
                if !trimmed.is_empty() {
                    transcript.push_str(trimmed);
                    transcript.push('\n');
                }
            }
        }

        if transcript.is_empty() {
            "Transcript text was empty.".to_string()
        } else {
            transcript
        }
    }
}

impl Default for YouTubeChannel {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_video_id_formats() {
        assert_eq!(
            YouTubeChannel::extract_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            YouTubeChannel::extract_video_id("https://youtu.be/dQw4w9WgXcQ?t=42"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            YouTubeChannel::extract_video_id("https://www.youtube.com/shorts/dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(
            YouTubeChannel::extract_video_id("dQw4w9WgXcQ"),
            Some("dQw4w9WgXcQ".to_string())
        );
        assert_eq!(YouTubeChannel::extract_video_id("invalid-link"), None);
    }

    #[test]
    fn test_parse_xml_transcript() {
        let xml = r#"
            <transcript>
                <text start="0.0" dur="2.0">Hello &amp; welcome</text>
                <text start="2.0" dur="3.0">to this demonstration!</text>
            </transcript>
        "#;
        let parsed = YouTubeChannel::parse_xml_transcript(xml);
        assert!(parsed.contains("Hello & welcome"));
        assert!(parsed.contains("to this demonstration!"));
    }
}
