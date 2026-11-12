use futures_util::{SinkExt, StreamExt};
use reach_core::error::{ReachError, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio_tungstenite::connect_async;

/// Default time a single CDP command may take.
const DEFAULT_COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// A protocol event pushed by the browser.
#[derive(Clone, Debug)]
pub struct CdpEvent {
    /// The CDP method name, for example `Page.loadEventFired`.
    pub method: String,
    /// The event payload.
    pub params: Value,
    /// The session the event belongs to, for flat sessions.
    pub session_id: Option<String>,
}

/// A Chrome DevTools Protocol client.
///
/// The client connects to the browser level endpoint and talks to it with
/// flat sessions, so that several pages can be driven at the same time. Every
/// command is answered by a future that is resolved by the reader task, and
/// every event is fanned out to the subscribers.
pub struct CdpClient {
    ws_url: String,
    tx: Arc<Mutex<Option<mpsc::UnboundedSender<WsMessage>>>>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value>>>>>,
    events: broadcast::Sender<CdpEvent>,
    connected: Arc<AtomicBool>,
    timeout: Duration,
}

/// Outgoing frame.
enum WsMessage {
    Text(String),
}

impl CdpClient {
    pub fn new(ws_url: impl Into<String>) -> Self {
        Self {
            ws_url: ws_url.into(),
            tx: Arc::new(Mutex::new(None)),
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            events: broadcast::channel(512).0,
            connected: Arc::new(AtomicBool::new(false)),
            timeout: DEFAULT_COMMAND_TIMEOUT,
        }
    }

    /// Overrides the per command timeout.
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The endpoint this client talks to.
    pub fn ws_url(&self) -> &str {
        &self.ws_url
    }

    /// Whether the transport is currently open.
    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::SeqCst)
    }

    /// Subscribes to protocol events.
    pub fn subscribe(&self) -> broadcast::Receiver<CdpEvent> {
        self.events.subscribe()
    }

    /// Connects to the endpoint if it is not connected yet.
    pub async fn connect(&self) -> Result<()> {
        if self.is_connected() {
            return Ok(());
        }

        let (ws, _) = connect_async(&self.ws_url)
            .await
            .map_err(|e| ReachError::BrowserError(format!("Failed to connect to CDP: {}", e)))?;

        let (mut sink, mut stream) = ws.split();
        let (tx, mut rx) = mpsc::unbounded_channel::<WsMessage>();
        *self.tx.lock().await = Some(tx);

        // Writer task.
        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                let frame = match message {
                    WsMessage::Text(text) => {
                        tokio_tungstenite::tungstenite::Message::Text(text)
                    }
                };
                if sink.send(frame).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        // Reader task.
        let pending = self.pending.clone();
        let events = self.events.clone();
        let connected = self.connected.clone();
        connected.store(true, Ordering::SeqCst);

        tokio::spawn(async move {
            while let Some(frame) = stream.next().await {
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(_) => break,
                };
                let text = match frame {
                    tokio_tungstenite::tungstenite::Message::Text(text) => text,
                    tokio_tungstenite::tungstenite::Message::Binary(bytes) => {
                        match String::from_utf8(bytes.to_vec()) {
                            Ok(text) => text,
                            Err(_) => continue,
                        }
                    }
                    _ => continue,
                };

                let Ok(message) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };

                if let Some(id) = message.get("id").and_then(|v| v.as_u64()) {
                    let waiter = {
                        let mut guard = pending.lock().await;
                        guard.remove(&id)
                    };
                    if let Some(waiter) = waiter {
                        let result = match message.get("error") {
                            Some(error) => {
                                let code = error.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
                                let text = error
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("Unknown CDP error");
                                Err(ReachError::CdpError {
                                    code,
                                    message: text.to_string(),
                                })
                            }
                            None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = waiter.send(result);
                    }
                    continue;
                }

                if let Some(method) = message.get("method").and_then(|m| m.as_str()) {
                    let _ = events.send(CdpEvent {
                        method: method.to_string(),
                        params: message.get("params").cloned().unwrap_or(Value::Null),
                        session_id: message
                            .get("sessionId")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string()),
                    });
                }
            }
            connected.store(false, Ordering::SeqCst);
        });

        Ok(())
    }

    /// Sends a browser level command and waits for the matching response.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        self.send(None, method, params).await
    }

    /// Sends a command to a flat session and waits for the matching response.
    pub async fn call_session(&self, session_id: &str, method: &str, params: Value) -> Result<Value> {
        self.send(Some(session_id.to_string()), method, params).await
    }

    /// Sends a command and ignores the outcome.
    pub async fn call_best_effort(
        &self,
        session_id: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        match session_id {
            Some(session) => self.call_session(session, method, params).await,
            None => self.call(method, params).await,
        }
    }

    async fn send(&self, session_id: Option<String>, method: &str, params: Value) -> Result<Value> {
        self.connect().await?;

        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let mut request = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        if let Some(session) = &session_id {
            request["sessionId"] = Value::String(session.clone());
        }

        let (waiter, receiver) = oneshot::channel();
        {
            let mut guard = self.pending.lock().await;
            guard.insert(id, waiter);
        }

        let frame = WsMessage::Text(request.to_string());
        let sender = self.tx.lock().await.clone();
        let sent = match sender {
            Some(sender) => sender.send(frame).is_ok(),
            None => false,
        };
        if !sent {
            let mut guard = self.pending.lock().await;
            guard.remove(&id);
            return Err(ReachError::BrowserError(
                "The CDP transport is closed".to_string(),
            ));
        }

        match tokio::time::timeout(self.timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(ReachError::BrowserError(format!(
                "The CDP channel for {} was dropped",
                method
            ))),
            Err(_) => {
                let mut guard = self.pending.lock().await;
                guard.remove(&id);
                Err(ReachError::BrowserError(format!(
                    "The CDP command {} timed out after {:?}",
                    method, self.timeout
                )))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_instantiation() {
        let client = CdpClient::new("ws://127.0.0.1:9222/devtools/browser");
        assert_eq!(client.ws_url(), "ws://127.0.0.1:9222/devtools/browser");
        assert_eq!(client.next_id.load(Ordering::SeqCst), 1);
        assert!(!client.is_connected());
    }

    #[tokio::test]
    async fn test_call_to_a_dead_endpoint_fails_cleanly() {
        let client = CdpClient::new("ws://127.0.0.1:59999/devtools/browser")
            .with_timeout(Duration::from_millis(400));
        let result = client.call("Browser.getVersion", json!({})).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_events_are_broadcast() {
        let client = CdpClient::new("ws://127.0.0.1:59999/devtools/browser");
        let mut receiver = client.subscribe();
        let sender = client.events.clone();
        sender
            .send(CdpEvent {
                method: "Page.loadEventFired".to_string(),
                params: json!({}),
                session_id: None,
            })
            .expect("broadcast");
        let event = receiver.recv().await.expect("event");
        assert_eq!(event.method, "Page.loadEventFired");
    }
}
