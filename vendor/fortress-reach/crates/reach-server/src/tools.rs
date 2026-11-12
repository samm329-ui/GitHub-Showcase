use reach_core::model::ToolDefinition;
use serde_json::json;

/// Returns the complete list of MCP tool definitions provided by Fortress-Reach.
/// Covers all 29 official Fortress stealth automation tools plus Agent-Reach multi-platform channels.
pub fn get_mcp_tools() -> Vec<ToolDefinition> {
    vec![
        // --------------------------------------------------------------------
        // 1. Core Protected Page & Retrieval (Fortress Stealth)
        // --------------------------------------------------------------------
        ToolDefinition {
            name: "fetch_protected_page".to_string(),
            description: "Fetches Cloudflare, DataDome, PerimeterX, or bot-protected pages using the Fortress stealth Chromium engine.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The URL of the protected webpage." }
                },
                "required": ["url"]
            }),
        },
        ToolDefinition {
            name: "read_page".to_string(),
            description: "Reads any webpage URL (or current page) and returns clean, readable Markdown text and tables.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Optional webpage URL. If omitted, reads current active page." }
                }
            }),
        },
        ToolDefinition {
            name: "get_page_html".to_string(),
            description: "Returns the raw outerHTML of a page (or current active page).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Optional webpage URL. If omitted, reads current active page." }
                }
            }),
        },
        ToolDefinition {
            name: "detect_waf".to_string(),
            description: "Identifies the anti-bot / WAF vendor (Cloudflare, DataDome, PerimeterX, Akamai, Kasada, Incapsula) protecting a page.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Optional webpage URL to inspect. If omitted, inspects current page." }
                }
            }),
        },
        ToolDefinition {
            name: "detect_captcha".to_string(),
            description: "Reports whether a page shows a challenge (Turnstile, reCAPTCHA, hCaptcha) on the current or the given page.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Optional webpage URL. If omitted, checks current page." }
                }
            }),
        },

        // --------------------------------------------------------------------
        // 2. Structured Extraction & Site Crawling
        // --------------------------------------------------------------------
        ToolDefinition {
            name: "extract_page".to_string(),
            description: "Extracts clean content, OpenGraph metadata, JSON-LD, and structured schema from a protected page.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The URL of the webpage to extract." },
                    "schema": { "type": "object", "description": "Optional JSON schema describing desired output structure." }
                },
                "required": ["url"]
            }),
        },
        ToolDefinition {
            name: "extract_document".to_string(),
            description: "Extracts markdown text and tables from local or remote documents (PDF, DOCX, XLSX, CSV, HTML).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "source": { "type": "string", "description": "URL or local filepath to document." }
                },
                "required": ["source"]
            }),
        },
        ToolDefinition {
            name: "crawl_site".to_string(),
            description: "Crawls a whole website (internal links, auto-handling SPAs) through the stealth browser and returns sitemap + documents.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The starting root URL to crawl." },
                    "depth": { "type": "integer", "description": "Crawl depth (default: 2, max: 5)." },
                    "max_pages": { "type": "integer", "description": "Maximum pages to harvest (default: 20, max: 200)." }
                },
                "required": ["url"]
            }),
        },
        ToolDefinition {
            name: "recon_site_apis".to_string(),
            description: "Reverse-engineers a site's private XHR/fetch JSON API by driving page and recording background API endpoints.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The target webpage URL." },
                    "duration": { "type": "number", "description": "Recording window in seconds (default: 10, max: 30)." }
                },
                "required": ["url"]
            }),
        },

        // --------------------------------------------------------------------
        // 3. Human Cadence Interactive Actions
        // --------------------------------------------------------------------
        ToolDefinition {
            name: "page_elements".to_string(),
            description: "Lists interactive buttons, input fields, links, and headings on the working page.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Optional webpage URL. If omitted, maps current page." }
                }
            }),
        },
        ToolDefinition {
            name: "click_button".to_string(),
            description: "Clicks a button or link by visible text or CSS selector with human-like mouse trajectory simulation.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string", "description": "Visible button text or CSS selector." },
                    "url": { "type": "string", "description": "Optional page URL." }
                },
                "required": ["text"]
            }),
        },
        ToolDefinition {
            name: "fill_field".to_string(),
            description: "Types into an input field or textarea with human cadence, with optional form submission.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "field": { "type": "string", "description": "Field placeholder, name, id, or CSS selector." },
                    "value": { "type": "string", "description": "Value to type into the field." },
                    "submit": { "type": "boolean", "description": "Whether to press Enter or submit after typing (default: false)." },
                    "url": { "type": "string", "description": "Optional page URL." }
                },
                "required": ["field", "value"]
            }),
        },
        ToolDefinition {
            name: "press_key".to_string(),
            description: "Sends a keyboard key press (Enter, Tab, Escape, ArrowDown, etc.) to the active element.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "Key name (e.g. Enter, Tab, Escape)." }
                },
                "required": ["key"]
            }),
        },
        ToolDefinition {
            name: "wait_for".to_string(),
            description: "Waits until a CSS selector appears in the DOM before proceeding.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "selector": { "type": "string", "description": "CSS selector to wait for." },
                    "timeout_ms": { "type": "integer", "description": "Max timeout in milliseconds (default: 10000)." },
                    "url": { "type": "string", "description": "Optional page URL." }
                },
                "required": ["selector"]
            }),
        },
        ToolDefinition {
            name: "current_page".to_string(),
            description: "Returns the URL and title of the currently loaded page in the stealth browser.".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },

        // --------------------------------------------------------------------
        // 4. Capture, Media, Files, & Session State
        // --------------------------------------------------------------------
        ToolDefinition {
            name: "screenshot_page".to_string(),
            description: "Captures a full visual PNG screenshot of the webpage using the stealth engine.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Optional webpage URL." },
                    "path": { "type": "string", "description": "Optional local file path to save PNG image." }
                }
            }),
        },
        ToolDefinition {
            name: "save_page".to_string(),
            description: "Exports and saves a webpage as PDF, HTML, or plain text to a local path.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The webpage URL." },
                    "path": { "type": "string", "description": "Local destination file path." },
                    "format": { "type": "string", "description": "Export format: pdf | html | text (default: html)." }
                },
                "required": ["url", "path"]
            }),
        },
        ToolDefinition {
            name: "download_file".to_string(),
            description: "Downloads a file using the stealth browser's active cookies and authenticated session.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Download link URL." },
                    "filename": { "type": "string", "description": "Destination file path or name." }
                },
                "required": ["url", "filename"]
            }),
        },
        ToolDefinition {
            name: "get_cookies".to_string(),
            description: "Retrieves active cookies for a domain or the current page.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Optional URL to query cookies for." }
                }
            }),
        },
        ToolDefinition {
            name: "save_profile".to_string(),
            description: "Persists the current authenticated session (cookies and storage) so you log in once and reuse across restarts.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Profile name (default: session)." }
                }
            }),
        },
        ToolDefinition {
            name: "load_profile".to_string(),
            description: "Restores a previously saved profile into the stealth browser session.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string", "description": "Profile name to restore." }
                },
                "required": ["name"]
            }),
        },
        ToolDefinition {
            name: "list_tabs".to_string(),
            description: "Lists all open browser tabs and page targets with their IDs and titles.".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDefinition {
            name: "close_tab".to_string(),
            description: "Closes a specific browser tab by index from list_tabs.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "index": { "type": "integer", "description": "Tab index to close." }
                },
                "required": ["index"]
            }),
        },

        // --------------------------------------------------------------------
        // 5. Multi-Step Workflows & Engine Bridges
        // --------------------------------------------------------------------
        ToolDefinition {
            name: "run_browser_task".to_string(),
            description: "Runs an autonomous multi-step browser automation (login, infinite_scroll_collect, paginate_collect, extract_table).".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "task": { "type": "string", "description": "Workflow name (see list_browser_tasks)." },
                    "url": { "type": "string", "description": "The target starting URL." },
                    "params": { "type": "object", "description": "Flow parameters (credentials, scroll count, selectors)." }
                },
                "required": ["task", "url"]
            }),
        },
        ToolDefinition {
            name: "list_browser_tasks".to_string(),
            description: "Lists available automated browser task flows supported by run_browser_task.".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDefinition {
            name: "get_egress_info".to_string(),
            description: "Reports current egress details: proxy configuration, region, and real public IP seen by targets.".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDefinition {
            name: "get_stealth_cdp_endpoint".to_string(),
            description: "Returns the raw CDP WebSocket URL so Playwright, Puppeteer, or external agents can connect directly to the stealth engine.".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
        ToolDefinition {
            name: "evaluate_js".to_string(),
            description: "Executes a JavaScript expression inside the browser context and returns the output.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "expression": { "type": "string", "description": "The JavaScript expression to evaluate." },
                    "url": { "type": "string", "description": "Optional page URL." }
                },
                "required": ["expression"]
            }),
        },
        ToolDefinition {
            name: "search_web".to_string(),
            description: "Performs real-time web search and returns structured search results with titles, URLs, and summaries.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Search query keywords." },
                    "count": { "type": "integer", "description": "Number of results to return (default: 10)." }
                },
                "required": ["query"]
            }),
        },

        // --------------------------------------------------------------------
        // 6. Agent-Reach Fast-Path Multi-Platform Channels
        // --------------------------------------------------------------------
        ToolDefinition {
            name: "get_youtube_transcript".to_string(),
            description: "Extracts video title and full text subtitles/transcript from a YouTube video URL.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "YouTube video URL." }
                },
                "required": ["url"]
            }),
        },
        ToolDefinition {
            name: "read_tweet".to_string(),
            description: "Reads a tweet or thread from Twitter / X.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Twitter / X post URL." }
                },
                "required": ["url"]
            }),
        },
        ToolDefinition {
            name: "read_reddit".to_string(),
            description: "Reads a Reddit post, selftext, and top comments.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Reddit post URL." }
                },
                "required": ["url"]
            }),
        },
        ToolDefinition {
            name: "read_rss".to_string(),
            description: "Fetches and parses an RSS or Atom feed into clean Markdown articles.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "The RSS or Atom XML feed URL." }
                },
                "required": ["url"]
            }),
        },
        ToolDefinition {
            name: "read_github".to_string(),
            description: "Extracts GitHub repository metadata, stars, forks, and README.".to_string(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "GitHub repository URL." }
                },
                "required": ["url"]
            }),
        },
        ToolDefinition {
            name: "doctor_status".to_string(),
            description: "Checks health, readiness, and connectivity status of all Fortress-Reach channels and stealth engine.".to_string(),
            input_schema: json!({ "type": "object", "properties": {} }),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mcp_tools_list() {
        let tools = get_mcp_tools();
        assert!(tools.len() >= 30);
        assert!(tools.iter().any(|t| t.name == "fetch_protected_page"));
        assert!(tools.iter().any(|t| t.name == "detect_waf"));
        assert!(tools.iter().any(|t| t.name == "detect_captcha"));
        assert!(tools.iter().any(|t| t.name == "click_button"));
        assert!(tools.iter().any(|t| t.name == "recon_site_apis"));
        assert!(tools.iter().any(|t| t.name == "crawl_site"));
        assert!(tools.iter().any(|t| t.name == "get_stealth_cdp_endpoint"));
    }
}
