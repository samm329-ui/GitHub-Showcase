use crate::jsonrpc::JsonRpcHandler;
use axum::{
    body::Bytes,
    extract::{Query, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    middleware::{from_fn, Next},
    response::sse::{Event, KeepAlive, Sse},
    response::{IntoResponse, Json, Response},
    routing::get,
    Router as AxumRouter,
};
use futures_util::{stream, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

/// The channel the server uses to push messages to the connected clients.
pub type EventSender = broadcast::Sender<Value>;

#[derive(Clone)]
pub struct ServerState {
    pub handler: Arc<JsonRpcHandler>,
    /// Server initiated messages, for example log records.
    pub events: EventSender,
}

impl ServerState {
    /// Creates a state with a fresh event channel.
    pub fn new(handler: Arc<JsonRpcHandler>) -> Self {
        let (events, _) = broadcast::channel(256);
        Self { handler, events }
    }
}

#[derive(Deserialize, Default)]
pub struct MessageQuery {
    #[serde(alias = "sessionId")]
    pub session_id: Option<String>,
}

pub struct McpServer {
    state: ServerState,
    port: u16,
    host: String,
}

impl McpServer {
    pub fn new(handler: Arc<JsonRpcHandler>, host: impl Into<String>, port: u16) -> Self {
        Self {
            state: ServerState::new(handler),
            host: host.into(),
            port,
        }
    }

    /// Builds the Axum router supporting both SSE and Streamable HTTP transports.
    pub fn build_router(state: ServerState) -> AxumRouter {
        let cors = build_cors_layer();

        AxumRouter::new()
            .route("/", get(unified_get_handler).post(messages_handler))
            .route("/sse", get(sse_handler).post(messages_handler))
            .route("/mcp", get(unified_get_handler).post(messages_handler))
            .route("/messages", get(unified_get_handler).post(messages_handler))
            .route("/health", get(health_handler).post(health_handler))
            .layer(from_fn(log_request))
            .layer(cors)
            .with_state(state)
    }

    /// The channel that carries server initiated messages.
    pub fn events(&self) -> EventSender {
        self.state.events.clone()
    }

    /// Starts the HTTP / SSE server in the background.
    pub async fn start(&self) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let app = Self::build_router(self.state.clone());
        let addr: SocketAddr = format!("{}:{}", self.host, self.port).parse()?;
        info!("Fortress-Reach MCP Server listening on http://{}", addr);

        let listener = tokio::net::TcpListener::bind(addr).await?;
        axum::serve(listener, app).await?;
        Ok(())
    }
}

/// The cross origin policy.
///
/// A desktop assistant connects without a browser origin, and a browser based
/// assistant needs the origin it is served from. The list of allowed origins
/// can therefore be set with `REACH_ALLOWED_ORIGINS`; when it is not set, any
/// origin is allowed, which is what a locally installed assistant needs.
fn build_cors_layer() -> CorsLayer {
    let allowed = std::env::var("REACH_ALLOWED_ORIGINS").ok().filter(|v| !v.is_empty());

    match allowed {
        Some(list) => {
            let origins: Vec<HeaderValue> = list
                .split(',')
                .map(|origin| origin.trim())
                .filter(|origin| !origin.is_empty())
                .filter_map(|origin| HeaderValue::from_str(origin).ok())
                .collect();
            CorsLayer::new()
                .allow_origin(origins)
                .allow_methods(Any)
                .allow_headers(Any)
        }
        None => CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any),
    }
}

/// Request logging middleware for full observability
async fn log_request(req: axum::extract::Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().to_string();
    let timestamp = chrono::Local::now().format("%H:%M:%S");

    println!("[{}] INCOMING HTTP {} {}", timestamp, method, path);

    let res = next.run(req).await;
    println!("[{}] HTTP {} {} -> {}", timestamp, method, path, res.status());
    info!("HTTP {} {} -> {}", method, path, res.status());
    res
}

/// The event stream handler.
///
/// The stream starts with the endpoint event that tells the client where to
/// post its messages, and it stays open so that the server can push
/// messages to the client.
async fn sse_handler(State(state): State<ServerState>) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let session_id = new_session_id();
    let endpoint_url = format!("/messages?sessionId={}", session_id);
    let initial_event = Event::default().event("endpoint").data(endpoint_url);

    let receiver = state.events.subscribe();

    let live = stream::unfold(receiver, |mut receiver| async move {
        match receiver.recv().await {
            Ok(message) => Some((
                Ok::<Event, Infallible>(Event::default().event("message").data(message.to_string())),
                receiver,
            )),
            Err(_) => None,
        }
    });

    let stream = stream::once(async move { Ok::<Event, Infallible>(initial_event) }).chain(live);

    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

/// A session identifier for one client connection.
fn new_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}", nanos)
}

/// Unified GET handler: returns SSE stream if Accept header matches, otherwise server info JSON.
async fn unified_get_handler(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> impl IntoResponse {
    let accept = headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if accept.contains("text/event-stream") {
        sse_handler(State(state)).await.into_response()
    } else {
        Json(json!({
            "status": "ok",
            "service": "Fortress-Reach MCP Server",
            "version": env!("CARGO_PKG_VERSION"),
            "transports": ["sse", "streamable-http"],
            "endpoints": {
                "sse": "/sse",
                "messages": "/messages",
                "streamable_http": "/mcp"
            }
        }))
        .into_response()
    }
}

/// Robust JSON-RPC message handler for both Streamable HTTP and SSE POST routes.
async fn messages_handler(
    State(state): State<ServerState>,
    Query(query): Query<MessageQuery>,
    body: Bytes,
) -> impl IntoResponse {
    let session_id = query.session_id.unwrap_or_else(new_session_id);
    let mut resp_headers = HeaderMap::new();
    resp_headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Ok(val) = HeaderValue::from_str(&session_id) {
        resp_headers.insert(HeaderName::from_static("mcp-session-id"), val);
    }

    if body.is_empty() {
        return (
            resp_headers,
            Json(json!({
                "status": "ok",
                "service": "Fortress-Reach MCP Server",
                "version": env!("CARGO_PKG_VERSION")
            })),
        );
    }

    match serde_json::from_slice::<Value>(&body) {
        Ok(json_body) => {
            let response = state.handler.handle_message(&json_body).await;
            match response {
                Some(res) => (resp_headers, Json(res)),
                None => (resp_headers, Json(json!({"status": "acknowledged"}))),
            }
        }
        Err(_) => (
            resp_headers,
            Json(json!({
                "jsonrpc": "2.0",
                "error": {
                    "code": -32700,
                    "message": "Parse error: invalid JSON"
                }
            })),
        ),
    }
}

/// Simple health check endpoint.
async fn health_handler() -> impl IntoResponse {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/json"),
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        ],
        Json(json!({
            "status": "ok",
            "service": "Fortress-Reach MCP Server",
            "version": env!("CARGO_PKG_VERSION")
        })),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use reach_browser::BrowserController;
    use reach_router::Router;

    fn state() -> ServerState {
        let router = Arc::new(Router::new());
        let browser = Arc::new(BrowserController::new("127.0.0.1", 9222));
        let handler = Arc::new(JsonRpcHandler::new(router, browser));
        ServerState::new(handler)
    }

    #[tokio::test]
    async fn test_server_router_creation() {
        let _app = McpServer::build_router(state());
    }

    #[tokio::test]
    async fn test_session_ids_are_unique() {
        let first = new_session_id();
        let second = new_session_id();
        assert_ne!(first, second);
        assert!(!first.is_empty());
    }

    #[tokio::test]
    async fn test_events_can_be_published() {
        let state = state();
        let mut receiver = state.events.subscribe();
        state
            .events
            .send(json!({ "jsonrpc": "2.0", "method": "notifications/message" }))
            .expect("broadcast");
        let message = receiver.recv().await.expect("event");
        assert_eq!(message["method"], "notifications/message");
    }
}
