use crate::cdp::CdpClient;
use crate::fingerprint;
use crate::launcher::{browser_version, BrowserLauncher};
use crate::provider::BrowserProvider;
use crate::stealth::{detect_captcha, detect_waf};
use reach_core::error::{ReachError, Result};
use reach_core::model::{PageContent, Platform};
use reach_persona::{GeneratorConfig, PersonaGenerator, PersonaProfile};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::process::Child;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout};

/// How long the controller waits for a page to finish loading.
const LOAD_TIMEOUT: Duration = Duration::from_secs(30);

/// Drives the browser.
///
/// A session owns one browser process and one flat protocol session per page.
/// Every page is created with the environment profile applied, so the page
/// looks the same as the machine the profile describes.
pub struct BrowserController {
    launcher: BrowserLauncher,
    client: Arc<Mutex<Option<Arc<CdpClient>>>>,
    profile: Arc<Mutex<Option<Arc<PersonaProfile>>>>,
    current: Arc<Mutex<Option<String>>>,
    child: Arc<Mutex<Option<Child>>>,
    provider: Arc<Mutex<Option<BrowserProvider>>>,
    /// The pages the environment profile has already been installed on.
    applied: Arc<Mutex<std::collections::HashSet<String>>>,
    /// Whether the environment profile is applied to the session.
    profile_enabled: bool,
}

impl BrowserController {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            launcher: BrowserLauncher::new(host, port),
            client: Arc::new(Mutex::new(None)),
            profile: Arc::new(Mutex::new(None)),
            current: Arc::new(Mutex::new(None)),
            child: Arc::new(Mutex::new(None)),
            provider: Arc::new(Mutex::new(None)),
            applied: Arc::new(Mutex::new(std::collections::HashSet::new())),
            profile_enabled: true,
        }
    }

    /// Uses a specific browser instead of the one found on the host.
    pub fn with_provider(mut self, provider: BrowserProvider) -> Self {
        self.provider = Arc::new(Mutex::new(Some(provider)));
        self
    }

    /// Uses the browser at the given path.
    pub fn with_browser_path(self, path: Option<&str>) -> Result<Self> {
        let Some(path) = path else {
            return Ok(self);
        };
        let provider = BrowserProvider::from_path(std::path::PathBuf::from(path))?;
        Ok(self.with_provider(provider))
    }

    /// Leaves the browser with its own values.
    ///
    /// This is what the comparison harness needs in order to measure a
    /// reference browser without measuring the profile on top of it.
    pub fn with_profile_enabled(mut self, enabled: bool) -> Self {
        self.profile_enabled = enabled;
        self
    }

    pub fn launcher(&self) -> &BrowserLauncher {
        &self.launcher
    }

    /// The profile in use, if the browser is running.
    pub async fn profile(&self) -> Option<Arc<PersonaProfile>> {
        self.profile.lock().await.clone()
    }

    /* ------------------------------------------------------------------ */
    /* Session management                                                   */
    /* ------------------------------------------------------------------ */

    /// Makes sure the browser runs and the protocol client is connected.
    async fn ensure_browser(&self) -> Result<Arc<CdpClient>> {
        if let Some(client) = self.client.lock().await.clone() {
            if client.is_connected() {
                return Ok(client);
            }
        }

        if !self.launcher.is_running().await {
            self.launch_browser().await?;
        }

        let ws_url = self.launcher.get_ws_debugger_url().await?;
        let client = Arc::new(CdpClient::new(ws_url));
        client.connect().await?;

        // The version the browser reports decides the user agent, so the
        // profile is only final once the browser has answered.
        let (major, full) = browser_version(client.ws_url())
            .await
            .unwrap_or((155, "155.0.0.0".to_string()));

        let seed = self.configured_seed();
        let country = self.configured_country();

        let profile = PersonaGenerator::new(GeneratorConfig {
            seed,
            country,
            browser_major: major,
            browser_full_version: full,
            noise_secret: Some(reach_persona::random_seed()),
        })
        .generate();

        *self.profile.lock().await = Some(Arc::new(profile));
        *self.client.lock().await = Some(client.clone());

        Ok(client)
    }

    async fn launch_browser(&self) -> Result<()> {
        let provider = self.resolve_provider().await?;

        // The flags only depend on the display, the locale and the network
        // policy, so a first profile is enough to start the browser.
        let provisional = PersonaGenerator::new(GeneratorConfig {
            seed: self.configured_seed(),
            country: self.configured_country(),
            ..GeneratorConfig::default()
        })
        .generate();

        let child = self.launcher.launch(true, &provisional, &provider)?;
        *self.child.lock().await = Some(child);

        for _ in 0..50 {
            sleep(Duration::from_millis(200)).await;
            if self.launcher.is_running().await {
                return Ok(());
            }
        }

        Err(ReachError::BrowserError(
            "The browser did not open its debugging port in time".to_string(),
        ))
    }

    async fn resolve_provider(&self) -> Result<BrowserProvider> {
        if let Some(provider) = self.provider.lock().await.clone() {
            return Ok(provider);
        }
        let provider = BrowserProvider::resolve(None)?;
        *self.provider.lock().await = Some(provider.clone());
        Ok(provider)
    }

    fn configured_seed(&self) -> Option<u64> {
        std::env::var("REACH_PERSONA_SEED")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
    }

    fn configured_country(&self) -> Option<String> {
        std::env::var("REACH_PERSONA_COUNTRY")
            .ok()
            .map(|value| value.trim().to_uppercase())
            .filter(|value| value.len() == 2)
    }

    /// Creates a page with the environment profile applied.
    async fn open_page(&self, url: Option<&str>) -> Result<(Arc<CdpClient>, String)> {
        let client = self.ensure_browser().await?;
        let profile = self
            .profile
            .lock()
            .await
            .clone()
            .ok_or_else(|| ReachError::BrowserError("The environment profile is not ready".to_string()))?;

        // The page is reused, so that a session does not leave a tab behind
        // for every call.
        let session_id = match self.current.lock().await.clone() {
            Some(session_id) => session_id,
            None => self.create_session(&client, &profile).await?,
        };

        // The profile is installed once per page. Installing it again would
        // add a second copy of the script to the same page.
        self.ensure_profile(&client, &session_id, &profile).await?;

        // The script is installed for new documents, so the document has to
        // be loaded once for the script to run in it.
        self.navigate(&client, &session_id, url.unwrap_or("about:blank"))
            .await?;

        *self.current.lock().await = Some(session_id.clone());

        Ok((client, session_id))
    }

    /// Applies the environment profile to a page session.
    async fn apply_profile(
        &self,
        client: &CdpClient,
        session_id: &str,
        profile: &PersonaProfile,
    ) -> Result<()> {
        if !self.profile_enabled {
            return Ok(());
        }
        fingerprint::apply_to_session(client, session_id, profile).await
    }

    /// Navigates and waits until the document has loaded.
    async fn navigate(&self, client: &CdpClient, session_id: &str, url: &str) -> Result<()> {
        let mut events = client.subscribe();
        client
            .call_session(session_id, "Page.navigate", json!({ "url": url }))
            .await
            .map_err(|e| ReachError::BrowserError(format!("Navigation failed: {}", e)))?;

        let deadline = tokio::time::Instant::now() + LOAD_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match timeout(remaining, events.recv()).await {
                Ok(Ok(event)) => {
                    if event.method == "Page.loadEventFired"
                        && event.session_id.as_deref() == Some(session_id)
                    {
                        break;
                    }
                }
                Ok(Err(_)) => break,
                Err(_) => break,
            }
        }

        // Give the page a moment to settle its own scripts.
        sleep(Duration::from_millis(350)).await;
        Ok(())
    }

    /// Runs an expression in a page and returns the value.
    async fn evaluate(&self, client: &CdpClient, session_id: &str, expression: &str) -> Result<Value> {
        let result = client
            .call_session(
                session_id,
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                }),
            )
            .await?;

        if let Some(details) = result.get("exceptionDetails") {
            let message = details
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("The expression failed");
            return Err(ReachError::BrowserError(message.to_string()));
        }

        Ok(result
            .get("result")
            .and_then(|r| r.get("value"))
            .cloned()
            .unwrap_or(Value::Null))
    }

    /// Runs an expression in a page, in the current page when no url is given.
    async fn evaluate_on(&self, expression: &str, url: Option<&str>) -> Result<Value> {
        let (client, session) = match url {
            Some(url) => self.open_page(Some(url)).await?,
            None => self.current_session().await?,
        };
        self.evaluate(&client, &session, expression).await
    }

    /// The page that is currently in focus.
    async fn current_session(&self) -> Result<(Arc<CdpClient>, String)> {
        let client = self.ensure_browser().await?;
        if let Some(session) = self.current.lock().await.clone() {
            return Ok((client, session));
        }
        self.open_page(None).await
    }

    /* ------------------------------------------------------------------ */
    /* Reading                                                             */
    /* ------------------------------------------------------------------ */

    /// Fetches a page and reports what the page looked like.
    pub async fn fetch_protected_page(&self, url: &str) -> Result<Value> {
        let (client, session) = self.open_page(Some(url)).await?;

        let expression = r#"(() => ({
            title: document.title || "",
            html: document.documentElement ? document.documentElement.outerHTML : "",
            text: document.body ? (document.body.innerText || "") : ""
        }))()"#;

        let value = self.evaluate(&client, &session, expression).await?;
        let title = value.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let html = value.get("html").and_then(|h| h.as_str()).unwrap_or("");
        let text = value.get("text").and_then(|t| t.as_str()).unwrap_or("");

        let waf_info = detect_waf(html, title, None);
        let is_blocked = waf_info
            .get("challenged")
            .and_then(|c| c.as_bool())
            .unwrap_or(false);

        let truncated: String = text.chars().take(20000).collect();

        Ok(json!({
            "url": url,
            "status": if is_blocked { "blocked" } else { "ok" },
            "http_status": 200,
            "blocked": is_blocked,
            "waf": waf_info,
            "title": title,
            "text": truncated
        }))
    }

    /// Fetches a page for the router.
    pub async fn fetch_protected_page_content(&self, url: &str) -> Result<PageContent> {
        let data = self.fetch_protected_page(url).await?;
        let text = data.get("text").and_then(|t| t.as_str()).unwrap_or("");
        let title = data
            .get("title")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string());

        let mut page = PageContent::new(url, text, Platform::Web);
        page.title = title;
        page.requires_stealth = false;
        Ok(page)
    }

    /// Extracts the structured content of a page.
    ///
    /// The schema is a map of field names to either a selector description or
    /// a plain name. A selector description looks like
    /// `{"selector": "h1", "attribute": "text"}`.
    pub async fn extract_page(&self, url: &str, schema: Option<&Value>) -> Result<Value> {
        let (client, session) = self.open_page(Some(url)).await?;

        let expression = match schema {
            Some(schema) => {
                let schema_json = schema.to_string();
                format!(
                    r#"(() => {{
                        const schema = {schema_json};
                        const fields = schema && schema.fields ? schema.fields : schema;
                        const structured = {{}};
                        for (const [name, spec] of Object.entries(fields || {{}})) {{
                            if (spec && typeof spec === 'object' && spec.selector) {{
                                const el = document.querySelector(spec.selector);
                                if (!el) {{ structured[name] = null; continue; }}
                                if (spec.attribute && spec.attribute !== 'text') {{
                                    structured[name] = el.getAttribute(spec.attribute);
                                }} else {{
                                    structured[name] = (el.innerText || el.textContent || '').trim();
                                }}
                                continue;
                            }}
                            const lower = String(name).toLowerCase();
                            if (lower === 'title') structured[name] = document.title;
                            else if (lower === 'url') structured[name] = location.href;
                            else if (lower === 'description') {{
                                const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
                                structured[name] = meta ? (meta.getAttribute('content') || '') : '';
                            }} else if (lower === 'text' || lower === 'content' || lower === 'body') {{
                                structured[name] = document.body ? document.body.innerText : '';
                            }} else if (lower === 'price') {{
                                const el = document.querySelector('[itemprop="price"], .price, .product-price');
                                structured[name] = el ? (el.innerText || '').trim() : null;
                            }} else {{
                                structured[name] = null;
                            }}
                        }}
                        return {{ structured: structured }};
                    }})()"#
                )
            }
            None => "({ structured: {} })".to_string(),
        };

        let structured_value = self.evaluate(&client, &session, &expression).await?;
        let structured = structured_value
            .get("structured")
            .cloned()
            .unwrap_or(json!({}));

        let content_expression = r#"(() => {
            const meta = {};
            document.querySelectorAll('meta').forEach(m => {
                const name = m.getAttribute('name') || m.getAttribute('property');
                const value = m.getAttribute('content');
                if (name && value) meta[name] = value;
            });

            const jsonLd = [];
            document.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
                try { jsonLd.push(JSON.parse(s.innerText)); } catch (e) {}
            });

            const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
                .slice(0, 40)
                .map(h => ({ level: Number(h.tagName.slice(1)), text: (h.innerText || '').trim() }));

            const links = Array.from(document.querySelectorAll('a[href]'))
                .slice(0, 100)
                .map(a => ({ text: (a.innerText || '').trim(), href: a.href }));

            return {
                title: document.title,
                description: meta['description'] || meta['og:description'] || '',
                metadata: meta,
                jsonLd: jsonLd,
                headings: headings,
                links: links,
                text: document.body ? document.body.innerText : ''
            };
        })()"#;

        let value = self.evaluate(&client, &session, content_expression).await?;

        let mut response = json!({
            "url": url,
            "title": value.get("title").unwrap_or(&json!("")),
            "description": value.get("description").unwrap_or(&json!("")),
            "metadata": value.get("metadata").unwrap_or(&json!({})),
            "json_ld": value.get("jsonLd").unwrap_or(&json!([])),
            "headings": value.get("headings").unwrap_or(&json!([])),
            "links": value.get("links").unwrap_or(&json!([])),
            "markdown": value.get("text").and_then(|t| t.as_str()).unwrap_or("")
        });

        if let Some(schema) = schema {
            response["structured"] = json!({
                "applied_schema": schema,
                "extracted": structured
            });
        }

        Ok(response)
    }

    /// Identifies the protection in front of a page.
    pub async fn detect_waf(&self, url: Option<&str>) -> Result<Value> {
        let (client, session) = self.open_page(url).await?;
        let expression = r#"({ title: document.title, html: document.documentElement ? document.documentElement.outerHTML : "" })"#;
        let value = self.evaluate(&client, &session, expression).await?;
        let title = value.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let html = value.get("html").and_then(|h| h.as_str()).unwrap_or("");
        Ok(detect_waf(html, title, None))
    }

    /// Reports whether a page shows a challenge.
    ///
    /// The tool only reports. Solving a challenge needs a human, and the
    /// report is what an assistant needs to decide what to do next.
    pub async fn detect_captcha(&self, url: Option<&str>) -> Result<Value> {
        let (client, session) = self.open_page(url).await?;
        let expression = r#"(document.documentElement ? document.documentElement.outerHTML : "")"#;
        let html = self
            .evaluate(&client, &session, expression)
            .await?
            .as_str()
            .unwrap_or("")
            .to_string();

        let captcha_info = detect_captcha(&html);
        let detected = captcha_info
            .get("detected")
            .and_then(|d| d.as_bool())
            .unwrap_or(false);

        Ok(json!({
            "detected": detected,
            "kind": captcha_info.get("kind").unwrap_or(&json!("none")),
            "requires_human": detected,
            "note": if detected {
                "A challenge was detected. It has to be completed in the browser before the page can be read."
            } else {
                "No challenge was detected."
            }
        }))
    }

    /// Reads a page as markdown.
    pub async fn read_page(&self, url: Option<&str>) -> Result<Value> {
        let (client, session) = self.open_page(url).await?;
        let expression = r#"({ url: window.location.href, title: document.title, html: document.documentElement ? document.documentElement.outerHTML : "" })"#;
        let value = self.evaluate(&client, &session, expression).await?;
        let current_url = value.get("url").and_then(|u| u.as_str()).unwrap_or("");
        let title = value.get("title").and_then(|t| t.as_str()).unwrap_or("");
        let html = value.get("html").and_then(|h| h.as_str()).unwrap_or("");
        let markdown = reach_router::parser::html_to_markdown(html);
        let truncated: String = markdown.chars().take(40000).collect();

        Ok(json!({
            "url": current_url,
            "title": title,
            "markdown": truncated
        }))
    }

    /// Returns the raw markup of a page.
    pub async fn get_page_html(&self, url: Option<&str>) -> Result<Value> {
        let (client, session) = self.open_page(url).await?;
        let expression = r#"({ url: window.location.href, html: document.documentElement ? document.documentElement.outerHTML : "" })"#;
        let value = self.evaluate(&client, &session, expression).await?;
        let current_url = value.get("url").and_then(|u| u.as_str()).unwrap_or("");
        let html = value.get("html").and_then(|h| h.as_str()).unwrap_or("");
        let truncated: String = html.chars().take(80000).collect();

        Ok(json!({
            "url": current_url,
            "html": truncated
        }))
    }

    /// Maps the interactive parts of a page.
    pub async fn page_elements(&self, url: Option<&str>) -> Result<Value> {
        let (client, session) = self.open_page(url).await?;
        let expression = r#"(() => {
            const buttons = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], [role="button"]'))
                .slice(0, 30)
                .map(el => ({ text: (el.innerText || el.value || "").trim(), id: el.id || null, disabled: !!el.disabled }));
            const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), textarea, select'))
                .slice(0, 30)
                .map(el => ({ name: el.name || null, placeholder: el.placeholder || null, type: el.type || "text", id: el.id || null }));
            const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 30)
                .map(el => ({ text: (el.innerText || "").trim(), href: el.href }));
            const headings = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 20)
                .map(el => ({ tag: el.tagName.toLowerCase(), text: (el.innerText || "").trim() }));
            return { buttons, inputs, links, headings };
        })()"#;
        self.evaluate(&client, &session, expression).await
    }

    /* ------------------------------------------------------------------ */
    /* Interaction                                                         */
    /* ------------------------------------------------------------------ */

    /// Clicks an element with a trusted mouse event.
    pub async fn click_button(&self, text_or_selector: &str, url: Option<&str>) -> Result<Value> {
        let (client, session) = self.open_page(url).await?;

        let target = serde_json::to_string(text_or_selector).unwrap_or_else(|_| "\"\"".to_string());
        let finder = format!(
            r#"(() => {{
                const wanted = {target};
                let el = null;
                try {{ el = document.querySelector(wanted); }} catch (e) {{ el = null; }}
                if (!el) {{
                    const candidates = Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"], span, div'));
                    el = candidates.find(e => (e.innerText || e.value || "").trim().toLowerCase().includes(wanted.toLowerCase()));
                }}
                if (!el) return {{ found: false }};
                el.scrollIntoView({{ block: 'center', inline: 'center' }});
                const rect = el.getBoundingClientRect();
                return {{
                    found: true,
                    text: (el.innerText || el.value || "").trim(),
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2
                }};
            }})()"#
        );

        let located = self.evaluate(&client, &session, &finder).await?;
        if !located.get("found").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Ok(json!({ "status": "error", "clicked": false, "error": "Element not found" }));
        }

        let x = located.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let y = located.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let label = located.get("text").and_then(|v| v.as_str()).unwrap_or("");

        // A short approach path, then the press and the release. The events
        // are delivered by the browser itself, so the page sees trusted input.
        for step in 1..=4 {
            let ratio = step as f64 / 4.0;
            client
                .call_session(
                    &session,
                    "Input.dispatchMouseEvent",
                    json!({
                        "type": "mouseMoved",
                        "x": x * ratio,
                        "y": y * ratio,
                        "button": "none",
                        "buttons": 0
                    }),
                )
                .await?;
            sleep(Duration::from_millis(24)).await;
        }

        client
            .call_session(
                &session,
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseMoved",
                    "x": x,
                    "y": y,
                    "button": "none",
                    "buttons": 0
                }),
            )
            .await?;

        client
            .call_session(
                &session,
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mousePressed",
                    "x": x,
                    "y": y,
                    "button": "left",
                    "buttons": 1,
                    "clickCount": 1
                }),
            )
            .await?;

        sleep(Duration::from_millis(48)).await;

        client
            .call_session(
                &session,
                "Input.dispatchMouseEvent",
                json!({
                    "type": "mouseReleased",
                    "x": x,
                    "y": y,
                    "button": "left",
                    "buttons": 0,
                    "clickCount": 1
                }),
            )
            .await?;

        sleep(Duration::from_millis(400)).await;

        Ok(json!({
            "status": "ok",
            "clicked": true,
            "text": label,
            "trusted": true
        }))
    }

    /// Types into a field with trusted input.
    pub async fn fill_field(
        &self,
        field: &str,
        value: &str,
        submit: bool,
        url: Option<&str>,
    ) -> Result<Value> {
        let (client, session) = self.open_page(url).await?;

        let field_json = serde_json::to_string(field).unwrap_or_else(|_| "\"\"".to_string());
        let focus = format!(
            r#"(() => {{
                const wanted = {field_json};
                let el = null;
                try {{ el = document.querySelector(wanted); }} catch (e) {{ el = null; }}
                if (!el) {{
                    const inputs = Array.from(document.querySelectorAll('input, textarea'));
                    el = inputs.find(i =>
                        (i.placeholder && i.placeholder.toLowerCase().includes(wanted.toLowerCase())) ||
                        (i.name && i.name.toLowerCase().includes(wanted.toLowerCase())) ||
                        (i.id && i.id.toLowerCase().includes(wanted.toLowerCase()))
                    );
                }}
                if (!el) return {{ found: false }};
                el.focus();
                if (el.value) el.value = '';
                return {{ found: true, tag: el.tagName.toLowerCase() }};
            }})()"#
        );

        let located = self.evaluate(&client, &session, &focus).await?;
        if !located.get("found").and_then(|v| v.as_bool()).unwrap_or(false) {
            return Ok(json!({ "status": "error", "filled": false, "error": "Input field not found" }));
        }

        client
            .call_session(
                &session,
                "Input.insertText",
                json!({ "text": value }),
            )
            .await?;

        // The page has to learn about the change.
        self.evaluate(
            &client,
            &session,
            "(() => { const el = document.activeElement; if (el) { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()",
        )
        .await?;

        if submit {
            self.press_key_in(&client, &session, "Enter").await?;
        }

        Ok(json!({
            "status": "ok",
            "filled": true,
            "field": field,
            "trusted": true
        }))
    }

    /// Sends a key press.
    pub async fn press_key(&self, key: &str) -> Result<Value> {
        let (client, session) = self.current_session().await?;
        self.press_key_in(&client, &session, key).await
    }

    async fn press_key_in(&self, client: &CdpClient, session: &str, key: &str) -> Result<Value> {
        let (code, key_code, text) = key_details(key);

        client
            .call_session(
                session,
                "Input.dispatchKeyEvent",
                json!({
                    "type": if text.is_some() { "keyDown" } else { "rawKeyDown" },
                    "key": key,
                    "code": code,
                    "windowsVirtualKeyCode": key_code,
                    "nativeVirtualKeyCode": key_code,
                    "text": text
                }),
            )
            .await?;

        client
            .call_session(
                session,
                "Input.dispatchKeyEvent",
                json!({
                    "type": "keyUp",
                    "key": key,
                    "code": code,
                    "windowsVirtualKeyCode": key_code,
                    "nativeVirtualKeyCode": key_code
                }),
            )
            .await?;

        Ok(json!({ "status": "ok", "key": key, "trusted": true }))
    }

    /// Waits for a selector to appear.
    pub async fn wait_for(&self, selector: &str, timeout_ms: u64, url: Option<&str>) -> Result<Value> {
        let (client, session) = self.open_page(url).await?;
        let selector_json = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".to_string());
        let check = format!("!!document.querySelector({})", selector_json);

        let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let value = self.evaluate(&client, &session, &check).await?;
            if value.as_bool() == Some(true) {
                return Ok(json!({ "status": "ok", "found": true, "selector": selector }));
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            sleep(Duration::from_millis(200)).await;
        }

        Ok(json!({ "status": "timeout", "found": false, "selector": selector }))
    }

    /// Reports the page that is open.
    pub async fn current_page(&self) -> Result<Value> {
        let (client, session) = self.current_session().await?;
        self.evaluate(
            &client,
            &session,
            "({ url: window.location.href, title: document.title })",
        )
        .await
    }

    /* ------------------------------------------------------------------ */
    /* Capture and files                                                   */
    /* ------------------------------------------------------------------ */

    /// Captures a screenshot.
    pub async fn screenshot_page(&self, url: Option<&str>, path: Option<&str>) -> Result<Value> {
        let (client, session) = self.open_page(url).await?;

        let result = client
            .call_session(
                &session,
                "Page.captureScreenshot",
                json!({ "format": "png", "captureBeyondViewport": true }),
            )
            .await?;

        let encoded = result.get("data").and_then(|d| d.as_str()).unwrap_or("");
        let bytes = decode_base64(encoded)?;

        if let Some(save_path) = path {
            if let Some(parent) = std::path::Path::new(save_path).parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(save_path, &bytes)
                .map_err(|e| ReachError::BrowserError(format!("Could not write the screenshot: {}", e)))?;
            return Ok(json!({ "status": "ok", "path": save_path, "bytes": bytes.len() }));
        }

        Ok(json!({ "status": "ok", "png_base64": encoded }))
    }

    /// Exports a page as a file.
    pub async fn save_page(&self, url: &str, path: &str, format: &str) -> Result<Value> {
        let (client, session) = self.open_page(Some(url)).await?;

        if let Some(parent) = std::path::Path::new(path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }

        match format.to_lowercase().as_str() {
            "pdf" => {
                let result = client
                    .call_session(
                        &session,
                        "Page.printToPDF",
                        json!({
                            "printBackground": true,
                            "transferMode": "ReturnAsBase64"
                        }),
                    )
                    .await?;
                let encoded = result.get("data").and_then(|d| d.as_str()).unwrap_or("");
                let bytes = decode_base64(encoded)?;
                std::fs::write(path, &bytes)
                    .map_err(|e| ReachError::BrowserError(format!("Could not write the file: {}", e)))?;
            }
            "text" | "markdown" => {
                let text = self
                    .evaluate(&client, &session, "document.body ? document.body.innerText : ''")
                    .await?
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                std::fs::write(path, text)
                    .map_err(|e| ReachError::BrowserError(format!("Could not write the file: {}", e)))?;
            }
            "screenshot" | "png" => {
                let result = client
                    .call_session(
                        &session,
                        "Page.captureScreenshot",
                        json!({ "format": "png", "captureBeyondViewport": true }),
                    )
                    .await?;
                let encoded = result.get("data").and_then(|d| d.as_str()).unwrap_or("");
                let bytes = decode_base64(encoded)?;
                std::fs::write(path, &bytes)
                    .map_err(|e| ReachError::BrowserError(format!("Could not write the file: {}", e)))?;
            }
            _ => {
                let html = self
                    .evaluate(
                        &client,
                        &session,
                        "document.documentElement ? document.documentElement.outerHTML : ''",
                    )
                    .await?
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                std::fs::write(path, html)
                    .map_err(|e| ReachError::BrowserError(format!("Could not write the file: {}", e)))?;
            }
        }

        Ok(json!({ "status": "ok", "path": path, "format": format }))
    }

    /// Downloads a file through the browser session.
    pub async fn download_file(&self, url: &str, filename: &str) -> Result<Value> {
        let target = std::path::PathBuf::from(filename);
        let directory = target
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::path::PathBuf::from("."));
        std::fs::create_dir_all(&directory)
            .map_err(|e| ReachError::BrowserError(format!("Could not create the folder: {}", e)))?;

        let (client, session) = self.open_page(Some("about:blank")).await?;

        client
            .call(
                "Browser.setDownloadBehavior",
                json!({
                    "behavior": "allow",
                    "downloadPath": directory.to_string_lossy(),
                    "eventsEnabled": true
                }),
            )
            .await?;

        let mut events = client.subscribe();
        client
            .call_session(&session, "Page.navigate", json!({ "url": url }))
            .await
            .map_err(|e| ReachError::BrowserError(format!("Navigation failed: {}", e)))?;

        let mut suggested: Option<String> = None;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
        while tokio::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match timeout(remaining, events.recv()).await {
                Ok(Ok(event)) => {
                    if event.method == "Browser.downloadWillBegin" {
                        suggested = event
                            .params
                            .get("suggestedFilename")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string());
                    }
                    if event.method == "Browser.downloadProgress"
                        && event.params.get("state").and_then(|v| v.as_str()) == Some("completed")
                    {
                        break;
                    }
                }
                Ok(Err(_)) => break,
                Err(_) => break,
            }
        }

        // The browser writes the file under its own name; move it to the
        // name the caller asked for.
        let produced = match &suggested {
            Some(name) => directory.join(name),
            None => match newest_file(&directory) {
                Some(path) => path,
                None => {
                    return Ok(json!({
                        "status": "error",
                        "error": "The browser did not report a download"
                    }))
                }
            },
        };

        if produced != target && produced.exists() {
            let _ = std::fs::rename(&produced, &target);
        }

        Ok(json!({
            "status": "ok",
            "path": target.to_string_lossy(),
            "bytes": std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0)
        }))
    }

    /* ------------------------------------------------------------------ */
    /* Session state                                                       */
    /* ------------------------------------------------------------------ */

    /// Returns the cookies of the session.
    pub async fn get_cookies(&self, url: Option<&str>) -> Result<Value> {
        let (client, session) = self.open_page(url).await?;
        let params = match url {
            Some(url) => json!({ "urls": [url] }),
            None => json!({}),
        };
        let result = client
            .call_session(&session, "Network.getCookies", params)
            .await?;
        Ok(result.get("cookies").cloned().unwrap_or(json!([])))
    }

    /// Stores the session cookies.
    pub async fn save_profile(&self, name: &str) -> Result<Value> {
        let cookies = self.get_cookies(None).await?;
        let directory = profile_directory();
        std::fs::create_dir_all(&directory)
            .map_err(|e| ReachError::BrowserError(format!("Could not create the profile folder: {}", e)))?;
        let path = directory.join(format!("{}.json", sanitize(name)));

        let data = json!({ "name": name, "cookies": cookies });
        std::fs::write(&path, data.to_string())
            .map_err(|e| ReachError::BrowserError(format!("Could not write the profile: {}", e)))?;

        Ok(json!({
            "status": "ok",
            "profile": name,
            "path": path.to_string_lossy()
        }))
    }

    /// Restores a stored session.
    pub async fn load_profile(&self, name: &str) -> Result<Value> {
        let path = profile_directory().join(format!("{}.json", sanitize(name)));
        if !path.exists() {
            return Ok(json!({
                "status": "error",
                "error": format!("Profile '{}' was not found", name)
            }));
        }

        let raw = std::fs::read_to_string(&path)
            .map_err(|e| ReachError::BrowserError(format!("Could not read the profile: {}", e)))?;
        let value: Value = serde_json::from_str(&raw).unwrap_or(json!({}));

        let (client, session) = self.open_page(None).await?;
        client
            .call_session(&session, "Network.enable", json!({}))
            .await?;

        if let Some(cookies) = value.get("cookies").and_then(|c| c.as_array()) {
            if !cookies.is_empty() {
                let _ = client
                    .call_session(
                        &session,
                        "Network.setCookies",
                        json!({ "cookies": cookies }),
                    )
                    .await;
            }
        }

        Ok(json!({ "status": "ok", "loaded": name }))
    }

    /// Lists the open tabs.
    pub async fn list_tabs(&self) -> Result<Value> {
        let client = self.ensure_browser().await?;
        let result = client.call("Target.getTargets", json!({})).await?;
        let targets = result
            .get("targetInfos")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
                    .map(|t| {
                        json!({
                            "id": t.get("targetId").and_then(|v| v.as_str()).unwrap_or(""),
                            "title": t.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                            "url": t.get("url").and_then(|v| v.as_str()).unwrap_or(""),
                            "attached": t.get("attached").and_then(|v| v.as_bool()).unwrap_or(false)
                        })
                    })
                    .collect::<Vec<Value>>()
            })
            .unwrap_or_default();

        Ok(json!({ "tabs": targets }))
    }

    /// Closes a tab.
    pub async fn close_tab(&self, index: usize) -> Result<Value> {
        let client = self.ensure_browser().await?;
        let result = client.call("Target.getTargets", json!({})).await?;
        let pages: Vec<String> = result
            .get("targetInfos")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .filter(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
                    .filter_map(|t| {
                        t.get("targetId").and_then(|v| v.as_str()).map(|s| s.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();

        let Some(target_id) = pages.get(index).cloned() else {
            return Ok(json!({ "status": "error", "error": "Tab index out of range" }));
        };

        client
            .call("Target.closeTarget", json!({ "targetId": target_id }))
            .await?;

        Ok(json!({ "status": "ok", "closed_index": index }))
    }

    /* ------------------------------------------------------------------ */
    /* Analysis                                                            */
    /* ------------------------------------------------------------------ */

    /// Records the background requests a page makes.
    pub async fn recon_site_apis(&self, url: &str, duration_secs: f64) -> Result<Value> {
        let (client, session) = self.open_page(None).await?;
        let mut events = client.subscribe();

        client
            .call_session(&session, "Page.navigate", json!({ "url": url }))
            .await
            .map_err(|e| ReachError::BrowserError(format!("Navigation failed: {}", e)))?;

        let deadline = tokio::time::Instant::now() + Duration::from_secs_f64(duration_secs.clamp(2.0, 30.0));
        let mut endpoints: Vec<Value> = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();

        while tokio::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match timeout(remaining, events.recv()).await {
                Ok(Ok(event)) => {
                    if event.method != "Network.requestWillBeSent" {
                        continue;
                    }
                    if event.session_id.as_deref() != Some(session.as_str()) {
                        continue;
                    }
                    let request = event.params.get("request").cloned().unwrap_or(json!({}));
                    let kind = event
                        .params
                        .get("type")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if kind != "Fetch" && kind != "XHR" {
                        continue;
                    }
                    let request_url = request.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    if request_url.is_empty() || !seen.insert(request_url.to_string()) {
                        continue;
                    }
                    endpoints.push(json!({
                        "url": request_url,
                        "method": request.get("method").and_then(|v| v.as_str()).unwrap_or("GET"),
                        "type": kind,
                        "resource_type": event.params.get("type").and_then(|v| v.as_str()).unwrap_or("")
                    }));
                }
                Ok(Err(_)) => break,
                Err(_) => break,
            }
        }

        Ok(json!({
            "url": url,
            "duration_recorded": duration_secs,
            "total_calls": endpoints.len(),
            "api_endpoints": endpoints
        }))
    }

    /// Crawls a site through the internal links.
    pub async fn crawl_site(&self, url: &str, depth: u32, max_pages: usize) -> Result<Value> {
        let client = self.ensure_browser().await?;
        let profile = self.profile.lock().await.clone();
        let Some(profile) = profile else {
            return Err(ReachError::BrowserError(
                "The environment profile is not ready".to_string(),
            ));
        };

        let base_host = url::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(|s| s.to_string()))
            .unwrap_or_default();

        let mut visited: HashSet<String> = HashSet::new();
        let mut queue = vec![(url.to_string(), 0u32)];
        let mut documents: Vec<Value> = Vec::new();

        while let Some((current, current_depth)) = queue.pop() {
            if visited.contains(&current) || visited.len() >= max_pages || current_depth > depth {
                continue;
            }
            visited.insert(current.clone());

            let session = self.create_session(&client, &profile).await?;
            self.navigate(&client, &session, &current).await?;

            let expression = r#"(() => ({
                title: document.title,
                text: document.body ? document.body.innerText.slice(0, 5000) : "",
                links: Array.from(document.querySelectorAll('a[href]')).map(a => a.href).filter(h => h.startsWith('http')).slice(0, 60)
            }))()"#;
            let value = self.evaluate(&client, &session, expression).await?;

            documents.push(json!({
                "url": current,
                "title": value.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                "markdown": value.get("text").and_then(|v| v.as_str()).unwrap_or("")
            }));

            if current_depth < depth {
                if let Some(links) = value.get("links").and_then(|l| l.as_array()) {
                    for link in links {
                        let Some(link) = link.as_str() else { continue };
                        if let Ok(parsed) = url::Url::parse(link) {
                            if parsed.host_str() == Some(base_host.as_str())
                                && !visited.contains(link)
                            {
                                queue.push((link.to_string(), current_depth + 1));
                            }
                        }
                    }
                }
            }
        }

        Ok(json!({
            "root_url": url,
            "pages_crawled": documents.len(),
            "documents": documents
        }))
    }

    /// Runs a named workflow.
    pub async fn run_browser_task(
        &self,
        task: &str,
        url: &str,
        params: Option<&Value>,
    ) -> Result<Value> {
        let (client, session) = self.open_page(Some(url)).await?;

        match task {
            "login" => {
                let user_selector = params
                    .and_then(|p| p.get("user_selector"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("input[type='email'], input[type='text'], input[name='user']");
                let pass_selector = params
                    .and_then(|p| p.get("pass_selector"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("input[type='password']");
                let username = params
                    .and_then(|p| p.get("username"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");
                let password = params
                    .and_then(|p| p.get("password"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("");

                self.fill_field(user_selector, username, false, None).await?;
                self.fill_field(pass_selector, password, true, None).await?;
                sleep(Duration::from_secs(2)).await;

                let location = self
                    .evaluate(&client, &session, "window.location.href")
                    .await?
                    .as_str()
                    .unwrap_or(url)
                    .to_string();

                Ok(json!({ "status": "ok", "task": "login", "url": location }))
            }
            "infinite_scroll_collect" => {
                let scroll_count = params
                    .and_then(|p| p.get("scroll_count"))
                    .and_then(|c| c.as_u64())
                    .unwrap_or(5);
                for _ in 0..scroll_count {
                    self.evaluate(
                        &client,
                        &session,
                        "window.scrollBy({ top: 800, behavior: 'smooth' })",
                    )
                    .await?;
                    sleep(Duration::from_millis(700)).await;
                }
                let text = self
                    .evaluate(
                        &client,
                        &session,
                        "document.body ? document.body.innerText.slice(0, 20000) : ''",
                    )
                    .await?
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                Ok(json!({ "status": "ok", "task": "infinite_scroll_collect", "collected_text": text }))
            }
            "extract_table" => {
                let expression = r#"(() => {
                    const tables = [];
                    document.querySelectorAll('table').forEach(table => {
                        const rows = [];
                        table.querySelectorAll('tr').forEach(tr => {
                            const cells = Array.from(tr.querySelectorAll('th, td')).map(c => c.innerText.trim());
                            if (cells.length > 0) rows.push(cells);
                        });
                        if (rows.length > 0) tables.push(rows);
                    });
                    return tables;
                })()"#;
                let tables = self.evaluate(&client, &session, expression).await?;
                Ok(json!({ "status": "ok", "tables": tables }))
            }
            "paginate_collect" => {
                let expression = r#"(() => {
                    const next = document.querySelector('a[rel="next"], .next, a.next-page');
                    return next ? next.href : null;
                })()"#;
                let next = self.evaluate(&client, &session, expression).await?;
                Ok(json!({
                    "status": "ok",
                    "task": "paginate_collect",
                    "next_url": next.as_str().unwrap_or("")
                }))
            }
            _ => {
                let title = self
                    .evaluate(&client, &session, "document.title")
                    .await?
                    .as_str()
                    .unwrap_or("")
                    .to_string();
                Ok(json!({ "status": "ok", "task": task, "url": url, "title": title }))
            }
        }
    }

    /// The workflows that can be run.
    pub fn list_browser_tasks(&self) -> Vec<String> {
        vec![
            "login".to_string(),
            "infinite_scroll_collect".to_string(),
            "paginate_collect".to_string(),
            "extract_table".to_string(),
        ]
    }

    /// Reports how the session leaves the machine.
    pub async fn get_egress_info(&self) -> Result<Value> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_default();

        let public_ip = match client.get("https://api.ipify.org?format=json").send().await {
            Ok(response) => response
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("ip").and_then(|i| i.as_str()).map(|s| s.to_string())),
            Err(_) => None,
        };

        let profile = self.profile.lock().await.clone();
        let engine = match &profile {
            Some(profile) => format!(
                "Fortress-Reach profile {} ({} / {})",
                profile.id, profile.country, profile.platform.client_hint_platform()
            ),
            None => "Fortress-Reach (not started)".to_string(),
        };

        Ok(json!({
            "proxy_configured": std::env::var("HTTPS_PROXY").is_ok() || std::env::var("HTTP_PROXY").is_ok(),
            "region": profile.as_ref().map(|p| p.country.clone()).unwrap_or_else(|| "unknown".to_string()),
            "public_ip": public_ip.unwrap_or_else(|| "unknown".to_string()),
            "engine": engine
        }))
    }

    /// The protocol endpoint, so that an external tool can attach to it.
    pub async fn get_stealth_cdp_endpoint(&self) -> Result<Value> {
        let client = self.ensure_browser().await?;
        Ok(json!({
            "status": "ok",
            "cdp_url": client.ws_url(),
            "host": self.launcher.host(),
            "port": self.launcher.port()
        }))
    }

    /// Runs an expression in the page.
    pub async fn evaluate_js(&self, expression: &str, url: Option<&str>) -> Result<Value> {
        self.evaluate_on(expression, url).await
    }

    /// Installs the environment profile on a page, once per page.
    async fn ensure_profile(
        &self,
        client: &CdpClient,
        session_id: &str,
        profile: &PersonaProfile,
    ) -> Result<()> {
        if self.applied.lock().await.contains(session_id) {
            return Ok(());
        }
        self.apply_profile(client, session_id, profile).await?;
        self.applied.lock().await.insert(session_id.to_string());
        Ok(())
    }

    /// Creates a page session with the profile applied.
    async fn create_session(&self, client: &CdpClient, profile: &PersonaProfile) -> Result<String> {
        let created = client
            .call("Target.createTarget", json!({ "url": "about:blank" }))
            .await?;
        let target_id = created
            .get("targetId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ReachError::BrowserError("The browser did not create a target".to_string()))?
            .to_string();

        let attached = client
            .call(
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
            )
            .await?;
        let session_id = attached
            .get("sessionId")
            .and_then(|v| v.as_str())
            .ok_or_else(|| ReachError::BrowserError("The browser did not attach to the target".to_string()))?
            .to_string();

        self.ensure_profile(client, &session_id, profile).await?;
        Ok(session_id)
    }

    /// Stops the browser.
    pub async fn shutdown(&self) {
        if let Some(mut child) = self.child.lock().await.take() {
            self.launcher.stop(&mut child);
        }
    }
}

/// The folder where the stored sessions live.
fn profile_directory() -> std::path::PathBuf {
    std::env::temp_dir().join("fortress_reach_profiles")
}

/// Keeps a profile name from escaping its folder.
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

/// Decodes standard base64.
fn decode_base64(input: &str) -> Result<Vec<u8>> {
    let trimmed: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = trimmed.as_bytes();

    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;

    for byte in bytes {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            _ => continue,
        } as u32;

        buffer = (buffer << 6) | value;
        bits += 6;

        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xFF) as u8);
        }
    }

    Ok(out)
}

/// The newest file in a folder.
fn newest_file(directory: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(directory).ok()?.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) == Some("crdownload") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            newest = Some((modified, path));
        }
    }
    newest.map(|(_, path)| path)
}

/// The protocol details of a key.
fn key_details(key: &str) -> (String, u32, Option<String>) {
    match key {
        "Enter" => ("Enter".into(), 13, Some("\r".into())),
        "Tab" => ("Tab".into(), 9, Some("\t".into())),
        "Escape" => ("Escape".into(), 27, None),
        "Backspace" => ("Backspace".into(), 8, None),
        "Delete" => ("Delete".into(), 46, None),
        "ArrowUp" => ("ArrowUp".into(), 38, None),
        "ArrowDown" => ("ArrowDown".into(), 40, None),
        "ArrowLeft" => ("ArrowLeft".into(), 37, None),
        "ArrowRight" => ("ArrowRight".into(), 39, None),
        "Space" => ("Space".into(), 32, Some(" ".into())),
        other => {
            let upper = other.to_uppercase();
            (upper.clone(), upper.as_bytes().first().copied().unwrap_or(0) as u32, None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_controller_instantiation() {
        let controller = BrowserController::new("127.0.0.1", 9222);
        assert_eq!(controller.launcher().port(), 9222);
    }

    #[test]
    fn test_base64_decoding() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn test_base64_decoding_handles_line_breaks() {
        assert_eq!(decode_base64("aGVs\nbG8=").unwrap(), b"hello");
    }

    #[test]
    fn test_key_details() {
        let (code, key_code, text) = key_details("Enter");
        assert_eq!(code, "Enter");
        assert_eq!(key_code, 13);
        assert!(text.is_some());
    }

    #[test]
    fn test_profile_name_is_sanitized() {
        assert_eq!(sanitize("../escape"), "___escape");
        assert_eq!(sanitize("session-1"), "session-1");
    }

    #[test]
    fn test_task_list_is_not_empty() {
        let controller = BrowserController::new("127.0.0.1", 9222);
        assert!(!controller.list_browser_tasks().is_empty());
    }
}
