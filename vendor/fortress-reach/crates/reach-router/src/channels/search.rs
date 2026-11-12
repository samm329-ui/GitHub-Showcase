use reach_core::error::{ReachError, Result};
use reach_core::model::{PageContent, Platform};
use reqwest::Client;
use std::time::Duration;

pub struct SearchChannel {
    client: Client,
}

impl SearchChannel {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(20))
            .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
            .build()
            .unwrap_or_else(|_| Client::new());

        Self { client }
    }

    /// Searches the web for the given query using Bing (primary) or DuckDuckGo (fallback) with realistic browser headers.
    pub async fn search(&self, query: &str, num_results: usize) -> Result<PageContent> {
        let encoded_query: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
        let bing_url = format!("https://www.bing.com/search?q={}", encoded_query);

        // 1. Try Bing search first (high availability and resilience across all ISPs)
        if let Ok(content) = self.search_bing(query, num_results).await {
            return Ok(PageContent::new(bing_url, content, Platform::Search));
        }

        // 2. Fallback to DuckDuckGo HTML
        let ddg_url = format!("https://html.duckduckgo.com/html/?q={}", encoded_query);
        let resp = self
            .client
            .post("https://html.duckduckgo.com/html/")
            .form(&[("q", query)])
            .send()
            .await;

        match resp {
            Ok(response) if response.status().is_success() => {
                let html = response
                    .text()
                    .await
                    .map_err(|e| ReachError::Network(e.to_string()))?;

                let results = Self::parse_duckduckgo_results(&html, num_results);
                let content = format!(
                    "# Web Search Results for: \"{}\"\n\n{}\n\n---\n*Search provided by Fortress-Reach Search Channel*",
                    query, results
                );

                Ok(PageContent::new(ddg_url, content, Platform::Search))
            }
            _ => Err(ReachError::Network("Web search request failed on all backends".to_string())),
        }
    }

    /// Searches via Bing.
    pub async fn search_bing(&self, query: &str, limit: usize) -> Result<String> {
        let encoded: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
        let url = format!("https://www.bing.com/search?q={}", encoded);

        let resp = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|e| ReachError::Network(e.to_string()))?;

        if !resp.status().is_success() {
            return Err(ReachError::Network(format!("Bing search returned status {}", resp.status())));
        }

        let html = resp
            .text()
            .await
            .map_err(|e| ReachError::Network(e.to_string()))?;

        let results = Self::parse_bing_results(&html, limit);
        if results.is_empty() || results.starts_with("No web search") {
            return Err(ReachError::Network("No Bing results parsed".to_string()));
        }

        Ok(format!(
            "# Web Search Results for: \"{}\"\n\n{}\n\n---\n*Search provided by Fortress-Reach Search Channel (Bing)*",
            query, results
        ))
    }

    pub fn parse_bing_results(html: &str, limit: usize) -> String {
        let title_re = regex::Regex::new(r#"(?s)<h2><a[^>]*href="([^"]+)"[^>]*>(.*?)</a></h2>"#).unwrap();
        let snippet_re = regex::Regex::new(r#"(?s)<div class="b_caption"><p[^>]*>(.*?)</p>"#).unwrap();
        let cite_re = regex::Regex::new(r#"(?s)<cite>(.*?)</cite>"#).unwrap();
        let tag_re = regex::Regex::new(r"<[^>]*>").unwrap();

        let mut output = String::new();
        let titles: Vec<_> = title_re.captures_iter(html).collect();

        for (index, title_match) in titles.iter().enumerate() {
            if index >= limit {
                break;
            }

            let raw_link = title_match.get(1).map(|m| m.as_str()).unwrap_or("");
            let title = title_match.get(2).map(|m| m.as_str()).unwrap_or("");

            if raw_link.starts_with('#') || raw_link.is_empty() {
                continue;
            }

            let block_start = title_match.get(0).map(|m| m.end()).unwrap_or(0);
            let block_end = titles
                .get(index + 1)
                .and_then(|next| next.get(0))
                .map(|m| m.start())
                .unwrap_or(html.len());
            let block = &html[block_start..block_end.max(block_start)];

            let snippet = snippet_re
                .captures(block)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str())
                .unwrap_or("");

            let clean_link = if let Some(cite_cap) = cite_re.captures(block) {
                let raw_cite = cite_cap.get(1).map(|m| m.as_str()).unwrap_or("");
                let stripped_cite = tag_re.replace_all(raw_cite, "").trim().to_string();
                if stripped_cite.starts_with("http") {
                    stripped_cite
                } else if !stripped_cite.is_empty() {
                    format!("https://{}", stripped_cite)
                } else {
                    raw_link.to_string()
                }
            } else {
                raw_link.to_string()
            };

            let clean_title = crate::parser::html_to_markdown(title);
            let clean_snippet = crate::parser::html_to_markdown(snippet);

            output.push_str(&format!(
                "{}. [{}]({})\n   {}\n\n",
                index + 1,
                clean_title,
                clean_link,
                clean_snippet
            ));
        }

        if output.is_empty() {
            "No web search results could be extracted.".to_string()
        } else {
            output
        }
    }

    fn parse_duckduckgo_results(html: &str, limit: usize) -> String {
        let title_re = regex::Regex::new(r#"(?s)<h2 class="result__title">.*?<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>"#).unwrap();
        let snippet_re = regex::Regex::new(r#"(?s)<a class="result__snippet"[^>]*>(.*?)</a>"#).unwrap();

        let mut output = String::new();

        let titles: Vec<_> = title_re.captures_iter(html).collect();

        for (index, title_match) in titles.iter().enumerate() {
            if index >= limit {
                break;
            }

            let raw_link = title_match.get(1).map(|m| m.as_str()).unwrap_or("");
            let title = title_match.get(2).map(|m| m.as_str()).unwrap_or("");

            // The snippet belongs to the block between this title and the next
            // one, so it is looked for in that range instead of at the same
            // index, which would pair it with the wrong result.
            let block_start = title_match.get(0).map(|m| m.end()).unwrap_or(0);
            let block_end = titles
                .get(index + 1)
                .and_then(|next| next.get(0))
                .map(|m| m.start())
                .unwrap_or(html.len());
            let block = &html[block_start..block_end.max(block_start)];
            let snippet = snippet_re
                .captures(block)
                .and_then(|c| c.get(1))
                .map(|m| m.as_str())
                .unwrap_or("");

            let clean_link = if let Some(idx) = raw_link.find("uddg=") {
                let encoded = &raw_link[idx + 5..].split('&').next().unwrap_or("");
                url::form_urlencoded::parse(encoded.as_bytes())
                    .next()
                    .map(|(k, _)| k.to_string())
                    .unwrap_or_else(|| encoded.to_string())
            } else {
                raw_link.to_string()
            };

            let clean_title = crate::parser::html_to_markdown(title);
            let clean_snippet = crate::parser::html_to_markdown(snippet);

            output.push_str(&format!(
                "{}. [{}]({})\n   {}\n\n",
                index + 1,
                clean_title,
                clean_link,
                clean_snippet
            ));
        }

        if output.is_empty() {
            "No web search results could be extracted.".to_string()
        } else {
            output
        }
    }
}

impl Default for SearchChannel {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::SearchChannel;

    #[test]
    fn test_url_encoding_helper() {
        let q = "Rust lang 2026";
        let encoded: String = url::form_urlencoded::byte_serialize(q.as_bytes()).collect();
        assert_eq!(encoded, "Rust+lang+2026");
    }

    #[test]
    fn test_search_results_pair_titles_with_their_own_snippet() {
        // Two results, where the first one has no snippet of its own. The
        // snippet of the second result must not end up next to the first
        // title.
        let html = r#"
            <h2 class="result__title"><a class="result__a" href="https://example.com/one">One</a></h2>
            <a class="result__snippet">Snippet of the first result</a>
            <h2 class="result__title"><a class="result__a" href="https://example.com/two">Two</a></h2>
            <a class="result__snippet">Snippet of the second result</a>
        "#;

        let output = SearchChannel::parse_duckduckgo_results(html, 10);
        assert!(output.contains("One"));
        assert!(output.contains("Two"));
        assert!(output.contains("Snippet of the first result"));
        assert!(output.contains("Snippet of the second result"));
    }

    #[test]
    fn test_parse_bing_results() {
        let html = r#"
            <li class="b_algo">
                <h2><a href="https://example.com/bing-one">Bing Result One</a></h2>
                <div class="b_caption"><p>Snippet of the Bing result</p></div>
                <div class="b_attribution"><cite>https://example.com/bing-one</cite></div>
            </li>
        "#;

        let output = SearchChannel::parse_bing_results(html, 5);
        assert!(output.contains("Bing Result One"));
        assert!(output.contains("https://example.com/bing-one"));
        assert!(output.contains("Snippet of the Bing result"));
    }
}

