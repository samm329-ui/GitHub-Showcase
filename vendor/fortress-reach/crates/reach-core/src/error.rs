use thiserror::Error;

/// Unified error enum for the entire Fortress-Reach workspace.
#[derive(Debug, Error)]
pub enum ReachError {
    #[error("Network error: {0}")]
    Network(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Channel execution failed for '{channel}': {reason}")]
    ChannelError {
        channel: String,
        reason: String,
    },

    #[error("Bot challenge or protection detected: {0}")]
    BotChallengeDetected(String),

    #[error("Stealth browser error: {0}")]
    BrowserError(String),

    #[error("CDP command error (code: {code}): {message}")]
    CdpError {
        code: i64,
        message: String,
    },

    #[error("Tool not found: {0}")]
    ToolNotFound(String),

    #[error("Invalid request parameters: {0}")]
    InvalidParams(String),

    #[error("Cloudflare tunnel error: {0}")]
    TunnelError(String),
}

pub type Result<T> = std::result::Result<T, ReachError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_display_formatting() {
        let err = ReachError::Network("Connection timed out".to_string());
        assert_eq!(err.to_string(), "Network error: Connection timed out");

        let channel_err = ReachError::ChannelError {
            channel: "youtube".to_string(),
            reason: "No captions found".to_string(),
        };
        assert_eq!(
            channel_err.to_string(),
            "Channel execution failed for 'youtube': No captions found"
        );
    }

    #[test]
    fn test_io_error_conversion() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "file not found");
        let reach_err: ReachError = io_err.into();
        assert!(matches!(reach_err, ReachError::Io(_)));
    }
}
