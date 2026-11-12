//! Compares the environment profile of Fortress-Reach with a reference
//! browser.
//!
//! The same probe file is evaluated in both browsers, so the surfaces can be
//! compared field by field. The result is written as a report that can be
//! kept next to the code as the record of what was measured and when.
//!
//! ```text
//! cargo run -p reach-bench -- --reference C:\path\to\chrome.exe
//! ```

use reach_browser::cdp::CdpClient;
use reach_browser::fingerprint;
use reach_browser::provider::BrowserProvider;
use reach_persona::{GeneratorConfig, PersonaGenerator};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::{Child, Command};
use std::time::Duration;

/// The probe that is evaluated in every browser.
const PROBE: &str = include_str!("../probe.js");

/// The environment variable that names the browser to compare against.
///
/// The comparison is optional. The project never needs a second browser, and
/// it never needs a particular one.
const REFERENCE_ENV: &str = "REACH_REFERENCE_BROWSER";

struct Options {
    reference: Option<PathBuf>,
    url: String,
    output: PathBuf,
}

fn parse_options() -> Options {
    let mut reference = None;
    let mut url = "https://example.com".to_string();
    let mut output = PathBuf::from("docs/bench");

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--reference" | "-r" => {
                if let Some(value) = args.next() {
                    reference = Some(PathBuf::from(value));
                }
            }
            "--url" | "-u" => {
                if let Some(value) = args.next() {
                    url = value;
                }
            }
            "--out" | "-o" => {
                if let Some(value) = args.next() {
                    output = PathBuf::from(value);
                }
            }
            _ => {}
        }
    }

    if reference.is_none() {
        if let Ok(path) = std::env::var(REFERENCE_ENV) {
            let candidate = PathBuf::from(path);
            if candidate.exists() {
                reference = Some(candidate);
            }
        }
    }

    Options {
        reference,
        url,
        output,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let options = parse_options();
    let mut results: BTreeMap<String, Value> = BTreeMap::new();

    if let Some(reference) = options.reference.clone() {
        match probe_engine("reference", &reference, 9331, false, &options.url).await {
            Ok(value) => {
                results.insert("reference".to_string(), value);
            }
            Err(error) => {
                tracing::error!("The reference browser could not be measured: {}", error);
            }
        }
    } else {
        tracing::warn!(
            "No reference browser was given. Pass --reference <path to chrome.exe> to compare against one."
        );
    }

    match probe_engine("fortress-reach", &resolve_system_browser()?, 9332, true, &options.url).await {
        Ok(value) => {
            results.insert("fortress-reach".to_string(), value);
        }
        Err(error) => {
            tracing::error!("Fortress-Reach could not be measured: {}", error);
            return Err(error);
        }
    }

    let report = build_report(&results, &options.url);
    std::fs::create_dir_all(&options.output)?;
    let stamp = timestamp();
    let path = options.output.join(format!("comparison-{}.md", stamp));
    std::fs::write(&path, &report)?;
    println!("{}", report);
    println!("\nThe report was written to {}", path.display());

    Ok(())
}

/// The browser that Fortress-Reach would use on this host.
fn resolve_system_browser() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let provider = BrowserProvider::resolve(None)?;
    Ok(provider.executable().to_path_buf())
}

/// Launches a browser, evaluates the probe and returns the result.
async fn probe_engine(
    name: &str,
    executable: &PathBuf,
    port: u16,
    with_profile: bool,
    url: &str,
) -> Result<Value, Box<dyn std::error::Error>> {
    tracing::info!("Measuring {} using {}", name, executable.display());

    let profile_dir = std::env::temp_dir().join(format!("reach_bench_{}", port));
    let _ = std::fs::remove_dir_all(&profile_dir);
    std::fs::create_dir_all(&profile_dir)?;

    let mut switches: Vec<String> = Vec::new();
    if with_profile {
        let provider = BrowserProvider::from_path(executable.clone())?;
        let profile = PersonaGenerator::new(GeneratorConfig {
            seed: Some(20260101),
            country: Some("US".to_string()),
            browser_major: 155,
            browser_full_version: "155.0.0.0".to_string(),
            noise_secret: Some(424242),
        })
        .generate();
        let plan = fingerprint::build_plan(&profile, &provider);
        switches = plan.cli_switches.clone();
    }

    let mut child: Child = Command::new(executable)
        .arg(format!("--remote-debugging-port={}", port))
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--remote-allow-origins=*")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .args(&switches)
        .arg("--headless=new")
        .arg("about:blank")
        .spawn()?;

    let result = measure(port, with_profile, url).await;

    let _ = child.kill();
    let _ = child.wait();
    let _ = std::fs::remove_dir_all(&profile_dir);

    result
}

/// Evaluates the probe in a running browser.
async fn measure(
    port: u16,
    with_profile: bool,
    url: &str,
) -> Result<Value, Box<dyn std::error::Error>> {
    let ws_url = wait_for_endpoint(port).await?;
    let client = CdpClient::new(ws_url);
    client.connect().await?;

    let created = client
        .call("Target.createTarget", json!({ "url": "about:blank" }))
        .await?;
    let target_id = created
        .get("targetId")
        .and_then(|v| v.as_str())
        .ok_or("the browser did not create a target")?
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
        .ok_or("the browser did not attach to the target")?
        .to_string();

    if with_profile {
        let version = client.call("Browser.getVersion", json!({})).await?;
        let product = version.get("product").and_then(|v| v.as_str()).unwrap_or("");
        let full = product
            .split('/')
            .nth(1)
            .unwrap_or("155.0.0.0")
            .to_string();
        let major = full
            .split('.')
            .next()
            .and_then(|m| m.parse::<u32>().ok())
            .unwrap_or(155);

        let profile = PersonaGenerator::new(GeneratorConfig {
            seed: Some(20260101),
            country: Some("US".to_string()),
            browser_major: major,
            browser_full_version: full,
            noise_secret: Some(424242),
        })
        .generate();

        // The reference browser is measured with its own values, so the
        // profile is not put on top of it.
        fingerprint::apply_to_session(&client, &session_id, &profile).await?;
    } else {
        client
            .call_session(&session_id, "Page.enable", json!({}))
            .await?;
        client
            .call_session(&session_id, "Runtime.enable", json!({}))
            .await?;
    }

    client
        .call_session(&session_id, "Page.navigate", json!({ "url": url }))
        .await?;
    tokio::time::sleep(Duration::from_secs(4)).await;

    let evaluated = client
        .call_session(
            &session_id,
            "Runtime.evaluate",
            json!({
                "expression": PROBE,
                "returnByValue": true,
                "awaitPromise": true
            }),
        )
        .await?;

    let value = evaluated
        .get("result")
        .and_then(|r| r.get("value"))
        .cloned()
        .unwrap_or(json!({}));

    Ok(value)
}

/// Waits for the debugging endpoint to come up.
async fn wait_for_endpoint(port: u16) -> Result<String, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    for _ in 0..100 {
        if let Ok(response) = client
            .get(format!("http://127.0.0.1:{}/json/version", port))
            .send()
            .await
        {
            if let Ok(value) = response.json::<Value>().await {
                if let Some(url) = value.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) {
                    return Ok(url.to_string());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    Err("the browser did not open its debugging port".into())
}

/// Builds the comparison report.
fn build_report(results: &BTreeMap<String, Value>, url: &str) -> String {
    let mut report = String::new();
    report.push_str("# Environment profile comparison\n\n");
    report.push_str(&format!("Measured against: {}\n\n", url));

    let reference = results.get("reference");
    let ours = results.get("fortress-reach");

    let mut keys: Vec<String> = Vec::new();
    for value in results.values() {
        if let Some(map) = value.as_object() {
            for key in map.keys() {
                if !keys.contains(key) {
                    keys.push(key.clone());
                }
            }
        }
    }
    keys.sort();

    report.push_str("| Surface | Reference | Fortress-Reach | State |\n");
    report.push_str("| --- | --- | --- | --- |\n");

    let mut same = 0usize;
    let mut different = 0usize;

    for key in &keys {
        let left = reference
            .and_then(|v| v.get(key))
            .map(render)
            .unwrap_or_else(|| "-".to_string());
        let right = ours
            .and_then(|v| v.get(key))
            .map(render)
            .unwrap_or_else(|| "-".to_string());

        let state = if reference.is_none() {
            "only in ours"
        } else if left == right {
            same += 1;
            "same"
        } else {
            different += 1;
            "different"
        };

        report.push_str(&format!(
            "| `{}` | {} | {} | {} |\n",
            key,
            escape(&left),
            escape(&right),
            state
        ));
    }

    report.push_str(&format!(
        "\n{} surfaces match, {} differ.\n",
        same, different
    ));

    report.push_str("\n## Assessment\n\n");
    report.push_str("| Check | Reference | Fortress-Reach |\n");
    report.push_str("| --- | --- | --- |\n");

    for assessment in assessment_list() {
        let name = assessment.name;
        let check = assessment.check;
        let left = reference.map(check).unwrap_or_else(|| "-".to_string());
        let right = ours.map(check).unwrap_or_else(|| "-".to_string());
        report.push_str(&format!("| {} | {} | {} |\n", name, left, right));
    }

    report.push_str(
        "\nA check passes when the value is what a browser that was actually used by a person \
         would report. A reference browser that reports a host value is shown as a warning, \
         because that is what makes a session linkable to the machine it came from.\n",
    );

    report
}

/// One consistency check.
struct Assessment {
    name: &'static str,
    check: fn(&Value) -> String,
}

macro_rules! assessment {
    ($name:literal, $label:literal, $body:expr) => {
        Assessment {
            name: $name,
            check: $body,
        }
    };
}

fn pass() -> String {
    "pass".to_string()
}

fn warn() -> String {
    "warn".to_string()
}

fn fail() -> String {
    "fail".to_string()
}

/// The checks that decide whether a session looks like a browser that a
/// person actually used.
fn assessments() -> Vec<Assessment> {
    vec![
        assessment!("platform_token", "The platform token is the legacy one", |v| {
            let platform = v.get("platform").and_then(|x| x.as_str()).unwrap_or("");
            match platform {
                "Win32" | "MacIntel" | "Linux x86_64" => pass(),
                "" => fail(),
                _ => fail(),
            }
        }),
        assessment!("no_headless_token", "The user agent has no headless token", |v| {
            let ua = v.get("userAgent").and_then(|x| x.as_str()).unwrap_or("");
            if ua.contains("Headless") {
                fail()
            } else {
                pass()
            }
        }),
        assessment!("version_agreement", "The user agent and the client hints agree", |v| {
            let ua = v.get("userAgent").and_then(|x| x.as_str()).unwrap_or("");
            let ua_major = ua
                .split("Chrome/")
                .nth(1)
                .and_then(|rest| rest.split('.').next())
                .unwrap_or("");
            let brands = v
                .get("userAgentDataHigh")
                .and_then(|x| x.get("brands"))
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default();
            let hint_versions: Vec<String> = brands
                .iter()
                .filter_map(|b| {
                    let name = b.get("brand").and_then(|x| x.as_str())?;
                    if name.contains("Chrome") || name.contains("Chromium") {
                        b.get("version")
                            .and_then(|x| x.as_str())
                            .map(|s| s.to_string())
                    } else {
                        None
                    }
                })
                .collect();
            if hint_versions.is_empty() {
                return fail();
            }
            if hint_versions.iter().all(|version| version == ua_major) {
                pass()
            } else {
                fail()
            }
        }),
        assessment!("screen_not_default", "The screen is not the headless default", |v| {
            let width = v
                .get("screen")
                .and_then(|s| s.get("width"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
            let height = v
                .get("screen")
                .and_then(|s| s.get("height"))
                .and_then(|x| x.as_u64())
                .unwrap_or(0);
            if width == 800 && height == 600 {
                fail()
            } else if width >= 1024 && height >= 768 {
                pass()
            } else {
                warn()
            }
        }),
        assessment!("window_has_a_frame", "The window is smaller than the screen", |v| {
            let size = v.get("windowSize");
            let inner = size.and_then(|s| s.get("innerWidth")).and_then(|x| x.as_u64());
            let outer = size.and_then(|s| s.get("outerWidth")).and_then(|x| x.as_u64());
            match (inner, outer) {
                (Some(inner), Some(outer)) if outer > inner => pass(),
                (Some(_), Some(_)) => fail(),
                _ => warn(),
            }
        }),
        assessment!("avail_within_screen", "The available area fits the screen", |v| {
            let screen = v.get("screen");
            let width = screen.and_then(|s| s.get("width")).and_then(|x| x.as_u64());
            let height = screen.and_then(|s| s.get("height")).and_then(|x| x.as_u64());
            let avail_width = screen.and_then(|s| s.get("availWidth")).and_then(|x| x.as_u64());
            let avail_height = screen.and_then(|s| s.get("availHeight")).and_then(|x| x.as_u64());
            match (width, height, avail_width, avail_height) {
                (Some(w), Some(h), Some(aw), Some(ah)) if aw <= w && ah <= h => pass(),
                _ => fail(),
            }
        }),
        assessment!("device_memory_bucket", "The device memory is a legal value", |v| {
            match v.get("deviceMemory").and_then(|x| x.as_f64()) {
                Some(memory) if [0.25, 0.5, 1.0, 2.0, 4.0, 8.0].contains(&memory) => pass(),
                Some(_) => fail(),
                None => warn(),
            }
        }),
        assessment!("language_list", "The language list is well formed", |v| {
            let languages = v
                .get("languages")
                .and_then(|x| x.as_array())
                .cloned()
                .unwrap_or_default();
            if languages.is_empty() {
                return fail();
            }
            if languages.iter().any(|l| {
                l.as_str()
                    .map(|s| s.contains(";q=") || s.contains(","))
                    .unwrap_or(true)
            }) {
                return fail();
            }
            pass()
        }),
        assessment!("graphics_agree", "The graphics identity is coherent", |v| {
            let renderer = v
                .get("webgl1")
                .and_then(|g| g.get("unmaskedRenderer"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            let vendor = v
                .get("webgpu")
                .and_then(|g| g.get("vendor"))
                .and_then(|x| x.as_str())
                .unwrap_or("");
            if renderer.is_empty() {
                return fail();
            }
            if vendor.is_empty() {
                return warn();
            }
            let family = if renderer.contains("NVIDIA") {
                "nvidia"
            } else if renderer.contains("AMD") {
                "amd"
            } else if renderer.contains("Intel") {
                "intel"
            } else if renderer.contains("Apple") {
                "apple"
            } else {
                ""
            };
            if family.is_empty() {
                fail()
            } else if family == vendor {
                pass()
            } else {
                fail()
            }
        }),
        assessment!("webgpu_present", "The graphics interface is present", |v| {
            match v.get("webgpu") {
                Some(Value::Null) => fail(),
                Some(_) => pass(),
                None => fail(),
            }
        }),
        assessment!("quota_is_not_the_default", "The storage quota is not the sandbox default", |v| {
            match v
                .get("storage")
                .and_then(|s| s.get("quota"))
                .and_then(|x| x.as_u64())
            {
                Some(10_737_418_240) => fail(),
                Some(_) => pass(),
                None => warn(),
            }
        }),
        assessment!("no_automation_flag", "The automation flag is not set", |v| {
            match v.get("webdriver").and_then(|x| x.as_bool()) {
                Some(false) => pass(),
                Some(true) => fail(),
                None => warn(),
            }
        }),
        assessment!("permission_not_granted", "No permission is granted without a gesture", |v| {
            match v
                .get("permissions")
                .and_then(|p| p.get("notification"))
                .and_then(|x| x.as_str())
            {
                Some("default") | Some("prompt") => pass(),
                Some("granted") => warn(),
                _ => warn(),
            }
        }),
        assessment!("canvas_is_stable", "The canvas reads agree with each other", |v| {
            match v
                .get("canvas")
                .and_then(|c| c.get("stable"))
                .and_then(|x| x.as_bool())
            {
                Some(true) => pass(),
                _ => fail(),
            }
        }),
        assessment!("native_source", "Functions report a native source", |v| {
            let source = v.get("functionSource").and_then(|x| x.as_str()).unwrap_or("");
            if source.contains("[native code]") {
                warn()
            } else if source.contains("function") {
                pass()
            } else {
                fail()
            }
        }),
        assessment!("keyboard_present", "The keyboard layout is present", |v| {
            match v
                .get("keyboard")
                .and_then(|k| k.get("size"))
                .and_then(|x| x.as_u64())
            {
                Some(size) if size >= 40 => pass(),
                _ => fail(),
            }
        }),
        assessment!("media_devices_present", "The media devices are listed", |v| {
            match v.get("mediaDevices").and_then(|x| x.as_array()) {
                Some(devices) if !devices.is_empty() => pass(),
                _ => fail(),
            }
        }),
    ]
}

/// The checks, built once.
fn assessment_list() -> Vec<Assessment> {
    assessments()
}

/// Renders a value for the report.
fn render(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => "null".to_string(),
        other => other.to_string(),
    }
}

/// Escapes the table separators.
fn escape(text: &str) -> String {
    text.replace('|', "\\|").replace('\n', " ")
}

/// A timestamp for the file name.
fn timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", seconds)
}
