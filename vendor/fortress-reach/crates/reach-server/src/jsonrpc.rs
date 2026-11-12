use crate::tools::get_mcp_tools;
use reach_browser::BrowserController;
use reach_core::model::ToolCallResponse;
use reach_router::Router;
use serde_json::{json, Value};
use std::sync::Arc;

pub struct JsonRpcHandler {
    router: Arc<Router>,
    browser: Arc<BrowserController>,
}

impl JsonRpcHandler {
    pub fn new(router: Arc<Router>, browser: Arc<BrowserController>) -> Self {
        Self { router, browser }
    }

    /// Handles an incoming JSON-RPC 2.0 request or notification and produces a response.
    pub async fn handle_message(&self, payload: &Value) -> Option<Value> {
        let id = payload.get("id").cloned();
        let method = payload.get("method").and_then(|m| m.as_str()).unwrap_or("");
        let params = payload.get("params").cloned().unwrap_or(Value::Null);

        match method {
            "initialize" => {
                let result = json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {
                        "tools": { "listChanged": false },
                        "resources": { "subscribe": false, "listChanged": false },
                        "logging": {}
                    },
                    "serverInfo": {
                        "name": "Fortress-Reach",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "instructions": "Fortress-Reach reads public web pages and drives a real browser \
                     through the DevTools protocol. Use read_page for a normal page, \
                     fetch_protected_page when a page is behind a challenge, and the channel tools \
                     for YouTube, Reddit, GitHub, feeds, tweets and search."
                });
                Some(Self::success_response(id, result))
            }
            "ping" => Some(Self::success_response(id, json!({}))),
            "notifications/initialized" => None,
            "notifications/cancelled" => None,
            "notifications/progress" => None,
            "logging/setLevel" => Some(Self::success_response(id, json!({}))),
            "resources/list" => {
                let result = json!({ "resources": self.resources() });
                Some(Self::success_response(id, result))
            }
            "resources/read" => {
                let uri = params.get("uri").and_then(|u| u.as_str()).unwrap_or("");
                match self.read_resource(uri).await {
                    Some(contents) => {
                        let result = json!({ "contents": contents });
                        Some(Self::success_response(id, result))
                    }
                    None => Some(Self::error_response(
                        id,
                        -32602,
                        &format!("Resource '{}' was not found", uri),
                    )),
                }
            }
            "tools/list" => {
                let tools = get_mcp_tools();
                let result = json!({ "tools": tools });
                Some(Self::success_response(id, result))
            }
            "tools/call" => {
                let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let args = params.get("arguments").cloned().unwrap_or(json!({}));
                
                let timestamp = chrono::Local::now().format("%H:%M:%S");
                println!("============================================================");
                println!("[{}] [MCP TOOL CALL] Tool: '{}'", timestamp, name);
                println!("[{}] [ARGS] {}", timestamp, args);
                println!("------------------------------------------------------------");

                let response = self.execute_tool(name, &args).await;

                let status_tag = if response.is_error { "[FAILED]" } else { "[SUCCESS]" };
                println!(
                    "[{}] [MCP RESPONSE] {} for '{}'",
                    chrono::Local::now().format("%H:%M:%S"),
                    status_tag,
                    name
                );
                println!("============================================================\n");

                Some(Self::success_response(id, json!(response)))
            }
            _ => {
                Some(Self::error_response(
                    id,
                    -32601,
                    &format!("Method '{}' not found", method),
                ))
            }
        }
    }

    /// The resources the server offers.
    ///
    /// A resource is a piece of text that the client can read without
    /// calling a tool. The list describes the environment the session is
    /// running in.
    fn resources(&self) -> Vec<Value> {
        vec![
            json!({
                "uri": "fortress-reach://about",
                "name": "About Fortress-Reach",
                "description": "What this server does and how to use it.",
                "mimeType": "text/plain"
            }),
            json!({
                "uri": "fortress-reach://tools",
                "name": "Tool list",
                "description": "Every tool this server offers, with its parameters.",
                "mimeType": "text/plain"
            }),
            json!({
                "uri": "fortress-reach://environment",
                "name": "Environment profile",
                "description": "The environment the browser session presents.",
                "mimeType": "application/json"
            }),
        ]
    }

    /// Reads one resource.
    async fn read_resource(&self, uri: &str) -> Option<Vec<Value>> {
        let text = match uri {
            "fortress-reach://about" => {
                "Fortress-Reach is a Model Context Protocol server that reads public web pages \
                 and drives a real browser through the DevTools protocol.\n\n\
                 Use read_page for a normal page. Use fetch_protected_page when a page is behind \
                 a challenge, and detect_waf when you need to know what is in front of a page. \
                 The channel tools cover YouTube subtitles, Reddit posts, GitHub repositories, \
                 feeds, tweets and web search. The browser tools cover reading, extraction, \
                 crawling, capturing, interaction and session state."
                    .to_string()
            }
            "fortress-reach://tools" => {
                let mut text = String::new();
                for tool in get_mcp_tools() {
                    text.push_str(&format!(
                        "{}: {}\n\n{}\n\n",
                        tool.name,
                        tool.description,
                        serde_json::to_string_pretty(&tool.input_schema)
                            .unwrap_or_else(|_| "{}".to_string())
                    ));
                }
                text
            }
            "fortress-reach://environment" => {
                let profile = self.browser.profile().await;
                match profile {
                    Some(profile) => serde_json::to_string_pretty(profile.as_ref())
                        .unwrap_or_else(|_| "{}".to_string()),
                    None => "{}".to_string(),
                }
            }
            _ => return None,
        };

        Some(vec![json!({
            "uri": uri,
            "mimeType": if uri.ends_with("environment") { "application/json" } else { "text/plain" },
            "text": text
        })])
    }

    /// Executes the specified tool using the intelligent router and stealth browser.
    pub async fn execute_tool(&self, name: &str, args: &Value) -> ToolCallResponse {
        match name {
            // ----------------------------------------------------------------
            // 1. Core Protected Page & Retrieval (Fortress Stealth)
            // ----------------------------------------------------------------
            "fetch_protected_page" => {
                let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
                if url.is_empty() {
                    return ToolCallResponse::error("Missing 'url' parameter.");
                }

                match self.browser.fetch_protected_page(url).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Stealth fetch error: {}", e)),
                }
            }
            "read_page" => {
                let url_opt = args.get("url").and_then(|u| u.as_str());
                if let Some(url) = url_opt {
                    // Try fast path via router first
                    match self.router.route_and_fetch(url).await {
                        Ok(page) => {
                            if page.requires_stealth {
                                match self.browser.read_page(Some(url)).await {
                                    Ok(val) => ToolCallResponse::text(val.get("markdown").and_then(|m| m.as_str()).unwrap_or("").to_string()),
                                    Err(e) => ToolCallResponse::error(format!("Stealth read failed: {}", e)),
                                }
                            } else {
                                ToolCallResponse::text(page.content)
                            }
                        }
                        Err(_) => {
                            // Fallback to browser
                            match self.browser.read_page(Some(url)).await {
                                Ok(val) => ToolCallResponse::text(val.get("markdown").and_then(|m| m.as_str()).unwrap_or("").to_string()),
                                Err(e) => ToolCallResponse::error(format!("Read failed: {}", e)),
                            }
                        }
                    }
                } else {
                    // Read current active page
                    match self.browser.read_page(None).await {
                        Ok(val) => ToolCallResponse::text(val.get("markdown").and_then(|m| m.as_str()).unwrap_or("").to_string()),
                        Err(e) => ToolCallResponse::error(format!("Read current page failed: {}", e)),
                    }
                }
            }
            "get_page_html" => {
                let url_opt = args.get("url").and_then(|u| u.as_str());
                match self.browser.get_page_html(url_opt).await {
                    Ok(val) => ToolCallResponse::text(val.get("html").and_then(|h| h.as_str()).unwrap_or("").to_string()),
                    Err(e) => ToolCallResponse::error(format!("Get HTML failed: {}", e)),
                }
            }
            "detect_waf" => {
                let url_opt = args.get("url").and_then(|u| u.as_str());
                match self.browser.detect_waf(url_opt).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Detect WAF failed: {}", e)),
                }
            }
            "detect_captcha" => {
                let url_opt = args.get("url").and_then(|u| u.as_str());
                match self.browser.detect_captcha(url_opt).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Detect captcha error: {}", e)),
                }
            }

            // ----------------------------------------------------------------
            // 2. Structured Extraction & Site Crawling
            // ----------------------------------------------------------------
            "extract_page" => {
                let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
                let schema = args.get("schema");
                if url.is_empty() {
                    return ToolCallResponse::error("Missing 'url' parameter.");
                }
                match self.browser.extract_page(url, schema).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Extract page failed: {}", e)),
                }
            }
            "extract_document" => {
                let source = args.get("source").and_then(|s| s.as_str()).unwrap_or("");
                if source.is_empty() {
                    return ToolCallResponse::error("Missing 'source' parameter.");
                }
                match self.browser.read_page(Some(source)).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Extract document error: {}", e)),
                }
            }
            "crawl_site" => {
                let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
                let depth = args.get("depth").and_then(|d| d.as_u64()).unwrap_or(2) as u32;
                let max_pages = args.get("max_pages").and_then(|m| m.as_u64()).unwrap_or(20) as usize;
                if url.is_empty() {
                    return ToolCallResponse::error("Missing 'url' parameter.");
                }
                match self.browser.crawl_site(url, depth, max_pages).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Crawl site failed: {}", e)),
                }
            }
            "recon_site_apis" => {
                let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
                let duration = args.get("duration").and_then(|d| d.as_f64()).unwrap_or(10.0);
                if url.is_empty() {
                    return ToolCallResponse::error("Missing 'url' parameter.");
                }
                match self.browser.recon_site_apis(url, duration).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Recon site APIs error: {}", e)),
                }
            }

            // ----------------------------------------------------------------
            // 3. Human Cadence Interactive Actions
            // ----------------------------------------------------------------
            "page_elements" => {
                let url_opt = args.get("url").and_then(|u| u.as_str());
                match self.browser.page_elements(url_opt).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Page elements error: {}", e)),
                }
            }
            "click_button" => {
                let text = args.get("text").and_then(|t| t.as_str()).unwrap_or("");
                let url_opt = args.get("url").and_then(|u| u.as_str());
                if text.is_empty() {
                    return ToolCallResponse::error("Missing 'text' parameter.");
                }
                match self.browser.click_button(text, url_opt).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Click button error: {}", e)),
                }
            }
            "fill_field" => {
                let field = args.get("field").and_then(|f| f.as_str()).unwrap_or("");
                let value = args.get("value").and_then(|v| v.as_str()).unwrap_or("");
                let submit = args.get("submit").and_then(|s| s.as_bool()).unwrap_or(false);
                let url_opt = args.get("url").and_then(|u| u.as_str());
                if field.is_empty() {
                    return ToolCallResponse::error("Missing 'field' parameter.");
                }
                match self.browser.fill_field(field, value, submit, url_opt).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Fill field error: {}", e)),
                }
            }
            "press_key" => {
                let key = args.get("key").and_then(|k| k.as_str()).unwrap_or("Enter");
                match self.browser.press_key(key).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Press key error: {}", e)),
                }
            }
            "wait_for" => {
                let selector = args.get("selector").and_then(|s| s.as_str()).unwrap_or("");
                let timeout_ms = args.get("timeout_ms").and_then(|t| t.as_u64()).unwrap_or(10000);
                let url_opt = args.get("url").and_then(|u| u.as_str());
                if selector.is_empty() {
                    return ToolCallResponse::error("Missing 'selector' parameter.");
                }
                match self.browser.wait_for(selector, timeout_ms, url_opt).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Wait for error: {}", e)),
                }
            }
            "current_page" => {
                match self.browser.current_page().await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Current page error: {}", e)),
                }
            }

            // ----------------------------------------------------------------
            // 4. Capture, Media, Files, & Session State
            // ----------------------------------------------------------------
            "screenshot_page" => {
                let url_opt = args.get("url").and_then(|u| u.as_str());
                let path_opt = args.get("path").and_then(|p| p.as_str());
                match self.browser.screenshot_page(url_opt, path_opt).await {
                    Ok(val) => {
                        if let Some(b64) = val.get("png_base64").and_then(|b| b.as_str()) {
                            ToolCallResponse::text(format!("data:image/png;base64,{}", b64))
                        } else {
                            ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default())
                        }
                    }
                    Err(e) => ToolCallResponse::error(format!("Screenshot error: {}", e)),
                }
            }
            "save_page" => {
                let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
                let path = args.get("path").and_then(|p| p.as_str()).unwrap_or("saved_page.html");
                let format = args.get("format").and_then(|f| f.as_str()).unwrap_or("html");
                if url.is_empty() {
                    return ToolCallResponse::error("Missing 'url' parameter.");
                }
                match self.browser.save_page(url, path, format).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Save page error: {}", e)),
                }
            }
            "download_file" => {
                let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
                let filename = args.get("filename").and_then(|f| f.as_str()).unwrap_or("download.bin");
                if url.is_empty() {
                    return ToolCallResponse::error("Missing 'url' parameter.");
                }
                match self.browser.save_page(url, filename, "html").await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Download file error: {}", e)),
                }
            }
            "get_cookies" => {
                let url_opt = args.get("url").and_then(|u| u.as_str());
                match self.browser.get_cookies(url_opt).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Get cookies error: {}", e)),
                }
            }
            "save_profile" => {
                let name = args.get("name").and_then(|n| n.as_str()).unwrap_or("session");
                match self.browser.save_profile(name).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Save profile error: {}", e)),
                }
            }
            "load_profile" => {
                let name = args.get("name").and_then(|n| n.as_str()).unwrap_or("session");
                match self.browser.load_profile(name).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Load profile error: {}", e)),
                }
            }
            "list_tabs" => {
                match self.browser.list_tabs().await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("List tabs error: {}", e)),
                }
            }
            "close_tab" => {
                let index = args.get("index").and_then(|i| i.as_u64()).unwrap_or(0) as usize;
                match self.browser.close_tab(index).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Close tab error: {}", e)),
                }
            }

            // ----------------------------------------------------------------
            // 5. Multi-Step Workflows & Engine Bridges
            // ----------------------------------------------------------------
            "run_browser_task" => {
                let task = args.get("task").and_then(|t| t.as_str()).unwrap_or("");
                let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
                let params = args.get("params");
                if task.is_empty() || url.is_empty() {
                    return ToolCallResponse::error("Missing 'task' or 'url' parameter.");
                }
                match self.browser.run_browser_task(task, url, params).await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Run browser task error: {}", e)),
                }
            }
            "list_browser_tasks" => {
                let tasks = self.browser.list_browser_tasks();
                ToolCallResponse::text(serde_json::to_string_pretty(&tasks).unwrap_or_default())
            }
            "get_egress_info" => {
                match self.browser.get_egress_info().await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Get egress info error: {}", e)),
                }
            }
            "get_stealth_cdp_endpoint" => {
                match self.browser.get_stealth_cdp_endpoint().await {
                    Ok(val) => ToolCallResponse::text(serde_json::to_string_pretty(&val).unwrap_or_default()),
                    Err(e) => ToolCallResponse::error(format!("Get stealth CDP endpoint error: {}", e)),
                }
            }
            "evaluate_js" => {
                let expr = args.get("expression").and_then(|e| e.as_str()).unwrap_or("");
                let url_opt = args.get("url").and_then(|u| u.as_str());
                if expr.is_empty() {
                    return ToolCallResponse::error("Missing 'expression' parameter.");
                }
                match self.browser.evaluate_js(expr, url_opt).await {
                    Ok(val) => ToolCallResponse::text(val.to_string()),
                    Err(e) => ToolCallResponse::error(format!("Evaluate error: {}", e)),
                }
            }
            "search_web" => {
                let query = args.get("query").and_then(|q| q.as_str()).unwrap_or("");
                let count = args.get("count").and_then(|c| c.as_u64()).unwrap_or(10) as usize;
                if query.is_empty() {
                    return ToolCallResponse::error("Missing 'query' parameter.");
                }

                match self.router.search.search(query, count).await {
                    Ok(page) => ToolCallResponse::text(page.content),
                    Err(e) => ToolCallResponse::error(format!("Search failed: {}", e)),
                }
            }

            // ----------------------------------------------------------------
            // 6. Agent-Reach Fast-Path Multi-Platform Channels
            // ----------------------------------------------------------------
            "get_youtube_transcript" => {
                let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
                if url.is_empty() {
                    return ToolCallResponse::error("Missing 'url' parameter.");
                }

                match self.router.youtube.extract_subtitles(url).await {
                    Ok(page) => ToolCallResponse::text(page.content),
                    Err(e) => ToolCallResponse::error(format!("YouTube error: {}", e)),
                }
            }
            "read_tweet" => {
                let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
                match self.router.twitter.read_tweet(url).await {
                    Ok(page) if page.requires_stealth => {
                        match self.browser.fetch_protected_page_content(url).await {
                            Ok(sp) => ToolCallResponse::text(sp.content),
                            Err(e) => ToolCallResponse::error(format!("Twitter fetch error: {}", e)),
                        }
                    }
                    Ok(page) => ToolCallResponse::text(page.content),
                    Err(e) => ToolCallResponse::error(format!("Twitter error: {}", e)),
                }
            }
            "read_reddit" => {
                let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
                match self.router.reddit.read_post(url).await {
                    Ok(page) if page.requires_stealth => {
                        match self.browser.fetch_protected_page_content(url).await {
                            Ok(sp) => ToolCallResponse::text(sp.content),
                            Err(e) => ToolCallResponse::error(format!("Reddit fetch error: {}", e)),
                        }
                    }
                    Ok(page) => ToolCallResponse::text(page.content),
                    Err(e) => ToolCallResponse::error(format!("Reddit error: {}", e)),
                }
            }
            "read_rss" => {
                let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
                match self.router.rss.read_feed(url).await {
                    Ok(page) => ToolCallResponse::text(page.content),
                    Err(e) => ToolCallResponse::error(format!("RSS error: {}", e)),
                }
            }
            "read_github" => {
                let url = args.get("url").and_then(|u| u.as_str()).unwrap_or("");
                match self.router.github.read_repo(url).await {
                    Ok(page) => ToolCallResponse::text(page.content),
                    Err(e) => ToolCallResponse::error(format!("GitHub error: {}", e)),
                }
            }
            "doctor_status" => {
                let health = self.router.check_channels().await;
                let mut report = String::from("# Fortress-Reach Health & Readiness Report\n\n");
                report.push_str("## Channels\n\n");
                report.push_str("Every line below comes from a probe that was actually made.\n\n");
                for h in health {
                    let badge = if h.available { "ready" } else { "unavailable" };
                    report.push_str(&format!(
                        "* **{}** ({}): {} - {}\n",
                        h.name,
                        h.tier.label(),
                        badge,
                        h.message
                    ));
                }
                report.push_str("\n## Browser engine\n\n");
                let is_running = self.browser.launcher().is_running().await;
                let state_str = if is_running {
                    "running"
                } else {
                    "standby, it starts on demand"
                };
                report.push_str(&format!("* **State**: {}\n", state_str));
                report.push_str(&format!(
                    "* **CDP endpoint**: {}:{}\n",
                    self.browser.launcher().host(),
                    self.browser.launcher().port()
                ));
                report.push_str(&format!(
                    "* **Browser**: {:?}\n",
                    reach_browser::BrowserLauncher::find_browser_executable()
                ));
                if let Some(profile) = self.browser.profile().await {
                    report.push_str(&format!(
                        "* **Environment profile**: {} ({}, {}, {} cores, {} GB)\n",
                        profile.id,
                        profile.country,
                        profile.platform.client_hint_platform(),
                        profile.hardware.hardware_concurrency,
                        profile.hardware.device_memory
                    ));
                } else {
                    report.push_str("* **Environment profile**: not created yet\n");
                }
                report.push_str(&format!(
                    "* **MCP tools**: {}\n",
                    crate::tools::get_mcp_tools().len()
                ));
                ToolCallResponse::text(report)
            }
            _ => ToolCallResponse::error(format!("Tool '{}' is not recognized.", name)),
        }
    }

    fn success_response(id: Option<Value>, result: Value) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id.unwrap_or(Value::Null),
            "result": result
        })
    }

    fn error_response(id: Option<Value>, code: i64, message: &str) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id.unwrap_or(Value::Null),
            "error": {
                "code": code,
                "message": message
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_initialize_handshake() {
        let router = Arc::new(Router::new());
        let browser = Arc::new(BrowserController::new("127.0.0.1", 9222));
        let handler = JsonRpcHandler::new(router, browser);

        let req = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {}
        });

        let res = handler.handle_message(&req).await.unwrap();
        assert_eq!(res["jsonrpc"], "2.0");
        assert_eq!(res["id"], 1);
        assert_eq!(res["result"]["serverInfo"]["name"], "Fortress-Reach");
    }

    #[tokio::test]
    async fn test_tools_list_call() {
        let router = Arc::new(Router::new());
        let browser = Arc::new(BrowserController::new("127.0.0.1", 9222));
        let handler = JsonRpcHandler::new(router, browser);

        let req = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list",
            "params": {}
        });

        let res = handler.handle_message(&req).await.unwrap();
        assert_eq!(res["id"], 2);
        assert!(res["result"]["tools"].as_array().unwrap().len() >= 30);
    }
}
