use reach_browser::BrowserController;
use reach_core::config::AppConfig;
use reach_router::Router;
use reach_server::{JsonRpcHandler, McpServer, TunnelManager};
use std::sync::Arc;
use std::time::Duration;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Initialize logging
    let _ = tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer())
        .try_init();

    let config = AppConfig::from_env();
    println!("============================================================");
    println!("       Fortress-Reach Remote MCP Server (Development)       ");
    println!("============================================================");
    println!("  Local Server: http://{}:{}", config.server_host, config.server_port);
    println!("  SSE Endpoint: http://{}:{}/sse", config.server_host, config.server_port);
    println!("  Health Check: http://{}:{}/health", config.server_host, config.server_port);
    println!(
        "  Browser:      {}",
        config.browser_path.clone().unwrap_or_else(|| "the one on this machine".to_string())
    );
    println!(
        "  Profile:      {}",
        if config.apply_profile { "applied" } else { "not applied (raw browser)" }
    );
    println!("------------------------------------------------------------");

    let router = Arc::new(Router::new());
    let browser = Arc::new(
        BrowserController::new(config.cdp_host.clone(), config.cdp_port)
            .with_browser_path(config.browser_path.as_deref())?
            .with_profile_enabled(config.apply_profile),
    );
    let handler = Arc::new(JsonRpcHandler::new(router, browser));
    let server = McpServer::new(handler, &config.server_host, config.server_port);
    let tunnel_manager = TunnelManager::new();

    // Start Cloudflare Quick Tunnel if enabled
    if config.enable_cloudflared_tunnel {
        println!("Starting Cloudflare Quick Tunnel...");
        tunnel_manager.start_tunnel(config.server_port);
        {
            let manager_clone = tunnel_manager.clone();
            tokio::spawn(async move {
                for _ in 0..30 {
                    tokio::time::sleep(Duration::from_millis(1000)).await;
                    if let Some(url) = manager_clone.get_public_url().await {
                        println!("============================================================");
                        println!("  CLOUDFLARE TUNNEL ONLINE!");
                        println!("  Public MCP SSE URL: {}/sse", url);
                        println!("  Use this URL in Claude (Mobile/Web -> Add Custom Connector)");
                        println!("============================================================");
                        break;
                    }
                }
            });
        }
    }

    info!("Starting MCP HTTP Server...");
    server.start().await?;

    Ok(())
}
