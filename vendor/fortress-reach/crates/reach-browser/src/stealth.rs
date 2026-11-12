use serde_json::{json, Value};

/// Analyzes rendered HTML, title, and optional headers to detect WAF / anti-bot protection.
pub fn detect_waf(html: &str, title: &str, headers: Option<&Value>) -> Value {
    let lower_html = html.to_lowercase();
    let lower_title = title.to_lowercase();
    let mut signals = Vec::new();

    // 1. Cloudflare Detection
    if lower_title.contains("just a moment")
        || lower_html.contains("cf-turnstile")
        || lower_html.contains("challenges.cloudflare.com")
        || lower_html.contains("cf-chl-bypass")
        || lower_html.contains("cf-browser-verification")
        || lower_html.contains("ray id:")
    {
        signals.push("cloudflare_challenge");
    }

    if let Some(h) = headers {
        if h.get("cf-ray").is_some() || h.get("cf-cache-status").is_some() {
            signals.push("cloudflare_headers");
        }
    }

    if !signals.is_empty() && (signals.contains(&"cloudflare_challenge") || lower_title.contains("just a moment")) {
        return json!({
            "vendor": "cloudflare",
            "challenged": true,
            "confidence": 0.98,
            "strategy": "wait_challenge",
            "signals": signals
        });
    }

    // 2. DataDome Detection
    if lower_html.contains("datadome.js")
        || lower_html.contains("api-js.datadome.co")
        || lower_html.contains("blocked by datadome")
        || lower_html.contains("datadome-challenge")
    {
        return json!({
            "vendor": "datadome",
            "challenged": true,
            "confidence": 0.95,
            "strategy": "behavior_human_cadence",
            "signals": ["datadome_script_or_interstitial"]
        });
    }

    // 3. PerimeterX / HUMAN Security
    if lower_html.contains("client.perimeterx.net")
        || lower_html.contains("px-cdn.net")
        || lower_html.contains("press & hold")
        || lower_html.contains("human verification")
        || lower_html.contains("_pxhd")
    {
        return json!({
            "vendor": "perimeterx",
            "challenged": true,
            "confidence": 0.95,
            "strategy": "behavior_interaction",
            "signals": ["perimeterx_challenge"]
        });
    }

    // 4. Akamai Bot Manager
    if lower_html.contains("ak_bmsc")
        || lower_html.contains("bm_sz")
        || lower_html.contains("access denied") && lower_html.contains("reference #")
        || lower_html.contains("akamai")
    {
        return json!({
            "vendor": "akamai",
            "challenged": true,
            "confidence": 0.90,
            "strategy": "ip_and_wait",
            "signals": ["akamai_sensor_or_block"]
        });
    }

    // 5. Kasada
    if lower_html.contains("kpsdk")
        || lower_html.contains("ips.js")
        || lower_html.contains("149e9513-01")
    {
        return json!({
            "vendor": "kasada",
            "challenged": true,
            "confidence": 0.92,
            "strategy": "pow_wait",
            "signals": ["kasada_kpsdk"]
        });
    }

    // 6. Incapsula / Imperva
    if lower_html.contains("_incap_")
        || lower_html.contains("incap_ses")
        || lower_html.contains("incapsula incident")
    {
        return json!({
            "vendor": "incapsula",
            "challenged": true,
            "confidence": 0.90,
            "strategy": "wait_challenge",
            "signals": ["incapsula_token"]
        });
    }

    // Clean / Direct
    json!({
        "vendor": "none",
        "challenged": false,
        "confidence": 1.0,
        "strategy": "direct",
        "signals": []
    })
}

/// Detects presence and type of CAPTCHA on the page.
pub fn detect_captcha(html: &str) -> Value {
    let lower = html.to_lowercase();

    if lower.contains("cf-turnstile") || lower.contains("challenges.cloudflare.com") {
        return json!({
            "detected": true,
            "kind": "turnstile",
            "solvable": true,
            "auto_clears": true,
            "selector": ".cf-turnstile, iframe[src*='challenges.cloudflare.com']"
        });
    }

    if lower.contains("g-recaptcha") || lower.contains("google.com/recaptcha") {
        return json!({
            "detected": true,
            "kind": "recaptcha",
            "solvable": true,
            "auto_clears": false,
            "selector": ".g-recaptcha, iframe[src*='google.com/recaptcha']"
        });
    }

    if lower.contains("hcaptcha") || lower.contains("h-captcha") {
        return json!({
            "detected": true,
            "kind": "hcaptcha",
            "solvable": true,
            "auto_clears": false,
            "selector": ".h-captcha, iframe[src*='hcaptcha.com']"
        });
    }

    json!({
        "detected": false,
        "kind": "none",
        "solvable": false,
        "auto_clears": false,
        "selector": null
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_cloudflare_turnstile() {
        let html = r#"<html><head><title>Just a moment...</title></head><body><div class="cf-turnstile"></div></body></html>"#;
        let waf = detect_waf(html, "Just a moment...", None);
        assert_eq!(waf["vendor"], "cloudflare");
        assert_eq!(waf["challenged"], true);
    }

    #[test]
    fn test_detect_clean_page() {
        let html = r#"<html><head><title>My Blog</title></head><body><h1>Hello World</h1></body></html>"#;
        let waf = detect_waf(html, "My Blog", None);
        assert_eq!(waf["vendor"], "none");
        assert_eq!(waf["challenged"], false);
    }
}
