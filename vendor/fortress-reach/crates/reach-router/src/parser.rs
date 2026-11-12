use regex::Regex;

/// Converts raw HTML string into clean, readable Markdown.
/// Strips script, style, navigation, header, and footer tags.
pub fn html_to_markdown(html: &str) -> String {
    let mut text = html.to_string();

    // Remove script and style blocks (Rust regex does not support backreferences)
    let re_scripts = Regex::new(r"(?is)<script[^>]*>.*?</script>|<style[^>]*>.*?</style>").unwrap();
    text = re_scripts.replace_all(&text, "").to_string();

    // Remove navigation, header, footer tags
    let re_clutter = Regex::new(r"(?is)<nav[^>]*>.*?</nav>|<header[^>]*>.*?</header>|<footer[^>]*>.*?</footer>").unwrap();
    text = re_clutter.replace_all(&text, "").to_string();

    // Replace headings with Markdown headings
    let re_h1 = Regex::new(r"(?i)<h1[^>]*>(.*?)</h1>").unwrap();
    text = re_h1.replace_all(&text, "\n# $1\n").to_string();

    let re_h2 = Regex::new(r"(?i)<h2[^>]*>(.*?)</h2>").unwrap();
    text = re_h2.replace_all(&text, "\n## $1\n").to_string();

    let re_h3 = Regex::new(r"(?i)<h3[^>]*>(.*?)</h3>").unwrap();
    text = re_h3.replace_all(&text, "\n### $1\n").to_string();

    // Convert links
    let re_links = Regex::new(r#"(?i)<a[^>]*href=["']([^"']+)["'][^>]*>(.*?)</a>"#).unwrap();
    text = re_links.replace_all(&text, "[$2]($1)").to_string();

    // Convert paragraphs and line breaks
    let re_p = Regex::new(r"(?i)<p[^>]*>(.*?)</p>").unwrap();
    text = re_p.replace_all(&text, "\n$1\n").to_string();

    let re_br = Regex::new(r"(?i)<br\s*/?>").unwrap();
    text = re_br.replace_all(&text, "\n").to_string();

    // Strip any remaining HTML tags
    let re_tags = Regex::new(r"<[^>]+>").unwrap();
    text = re_tags.replace_all(&text, "").to_string();

    // Clean multiple consecutive newlines and leading/trailing whitespace
    let re_whitespace = Regex::new(r"\n{3,}").unwrap();
    let cleaned = re_whitespace.replace_all(&text, "\n\n").trim().to_string();

    cleaned
}

/// Detects if an HTML or text payload is a bot challenge page (Cloudflare, Akamai, Turnstile).
pub fn is_bot_challenge(content: &str) -> bool {
    let lower = content.to_lowercase();
    let markers = [
        "just a moment...",
        "attention required! | cloudflare",
        "performing security verification",
        "verify you are human",
        "cloudflare turnstile",
        "access denied",
        "challenge-platform",
        "cf-chl-bypass",
        "403 forbidden",
        "please enable javascript and cookies to continue",
        "datadome",
        "instagram.com/accounts/login",
        "login • instagram",
        "sign in to x",
    ];

    markers.iter().any(|marker| lower.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_html_to_markdown_basic() {
        let raw_html = "<html><body><h1>Main Title</h1><p>This is a paragraph with <a href=\"https://example.com\">link</a>.</p></body></html>";
        let md = html_to_markdown(raw_html);
        assert!(md.contains("# Main Title"));
        assert!(md.contains("[link](https://example.com)"));
        assert!(!md.contains("<h1>"));
    }

    #[test]
    fn test_script_and_nav_removal() {
        let raw_html = "<html><head><script>alert('ad')</script></head><body><nav>Menu item</nav><p>Real Content</p></body></html>";
        let md = html_to_markdown(raw_html);
        assert!(!md.contains("alert"));
        assert!(!md.contains("Menu item"));
        assert!(md.contains("Real Content"));
    }

    #[test]
    fn test_bot_challenge_detection() {
        let cloudflare_challenge = "<html><head><title>Just a moment...</title></head><body>Verify you are human</body></html>";
        assert!(is_bot_challenge(cloudflare_challenge));

        let normal_content = "# Welcome\nThis is a standard technical blog.";
        assert!(!is_bot_challenge(normal_content));
    }
}
