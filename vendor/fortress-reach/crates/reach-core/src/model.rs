use serde::{Deserialize, Serialize};

/// Supported platform channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Web,
    YouTube,
    Twitter,
    Reddit,
    Rss,
    GitHub,
    Search,
}

impl Platform {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Web => "web",
            Self::YouTube => "youtube",
            Self::Twitter => "twitter",
            Self::Reddit => "reddit",
            Self::Rss => "rss",
            Self::GitHub => "github",
            Self::Search => "search",
        }
    }
}

/// Standardized result representing extracted webpage or channel content.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PageContent {
    pub url: String,
    pub title: Option<String>,
    pub content: String,
    pub platform: Platform,
    pub requires_stealth: bool,
}

impl PageContent {
    pub fn new(url: impl Into<String>, content: impl Into<String>, platform: Platform) -> Self {
        Self {
            url: url.into(),
            title: None,
            content: content.into(),
            platform,
            requires_stealth: false,
        }
    }
}

/// How much setup a channel needs before it can be used.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChannelTier {
    /// Works without any account, key or extra program.
    #[default]
    ZeroConfig,
    /// Needs a free account, a key or a login.
    NeedsAccount,
    /// Needs a separate program or a longer setup.
    NeedsSetup,
}

impl ChannelTier {
    /// A short label for the report.
    pub fn label(self) -> &'static str {
        match self {
            ChannelTier::ZeroConfig => "no setup",
            ChannelTier::NeedsAccount => "account or key",
            ChannelTier::NeedsSetup => "extra setup",
        }
    }
}

/// Channel health and readiness report.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChannelHealth {
    pub name: String,
    pub available: bool,
    pub message: String,
    /// How much setup the channel needs.
    #[serde(default)]
    pub tier: ChannelTier,
    /// The round trip time of the probe, when one was made.
    #[serde(default)]
    pub latency_ms: Option<u64>,
}

/// Tool call specification compatible with the Model Context Protocol (MCP).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: serde_json::Value,
}

/// Incoming tool execution request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRequest {
    pub name: String,
    #[serde(default)]
    pub arguments: serde_json::Value,
}

/// Tool execution response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallResponse {
    pub content: Vec<ToolResponseContent>,
    #[serde(rename = "isError", default)]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ToolResponseContent {
    Text { text: String },
}

impl ToolCallResponse {
    pub fn text(content: impl Into<String>) -> Self {
        Self {
            content: vec![ToolResponseContent::Text {
                text: content.into(),
            }],
            is_error: false,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            content: vec![ToolResponseContent::Text {
                text: message.into(),
            }],
            is_error: true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_platform_serialization() {
        let platform = Platform::YouTube;
        let json = serde_json::to_string(&platform).unwrap();
        assert_eq!(json, "\"youtube\"");

        let deserialized: Platform = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized, Platform::YouTube);
    }

    #[test]
    fn test_page_content_builder() {
        let page = PageContent::new(
            "https://example.com",
            "# Example Title\n\nContent here.",
            Platform::Web,
        );
        assert_eq!(page.url, "https://example.com");
        assert_eq!(page.platform, Platform::Web);
        assert!(!page.requires_stealth);
    }

    #[test]
    fn test_tool_call_response_helpers() {
        let success = ToolCallResponse::text("Extracted markdown");
        assert!(!success.is_error);
        let ToolResponseContent::Text { text } = &success.content[0];
        assert_eq!(text, "Extracted markdown");

        let failure = ToolCallResponse::error("Rate limit exceeded");
        assert!(failure.is_error);
    }
}
