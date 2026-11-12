pub mod channels;
pub mod parser;
pub mod router;

pub use router::Router;

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_router_exports() {
        let router = Router::new();
        let health = router.check_channels().await;
        assert!(!health.is_empty());
    }
}
