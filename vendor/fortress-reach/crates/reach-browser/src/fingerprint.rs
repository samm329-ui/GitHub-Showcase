//! Turns an environment profile into something the browser can act on.
//!
//! Three layers are produced:
//!
//! * command line switches, for the surfaces the browser reads at start up;
//! * protocol overrides, for the surfaces the DevTools protocol can express;
//! * an injected script, for the surfaces nothing else can reach.
//!
//! The order matters. A protocol override leaves no trace in the page, so it
//! is always preferred over a script level override.

use crate::cdp::CdpClient;
use crate::provider::BrowserProvider;
use reach_core::error::Result;
use reach_persona::PersonaProfile;
use serde_json::{json, Value};

/// The script that is installed on every new document.
const SHIM_TEMPLATE: &str = include_str!("shims.js");

/// A ready to apply environment description.
#[derive(Clone, Debug)]
pub struct FingerprintPlan {
    /// Switches for the browser command line.
    pub cli_switches: Vec<String>,
    /// Protocol calls to apply to a freshly attached session.
    pub cdp_overrides: Vec<(String, Value)>,
    /// The script to install on every new document.
    pub shim_script: String,
}

/// Builds the plan for a profile.
pub fn build_plan(profile: &PersonaProfile, provider: &BrowserProvider) -> FingerprintPlan {
    FingerprintPlan {
        cli_switches: cli_switches(profile, provider),
        cdp_overrides: cdp_overrides(profile),
        shim_script: shim_script(profile),
    }
}

/// The command line switches for a profile.
fn cli_switches(profile: &PersonaProfile, provider: &BrowserProvider) -> Vec<String> {
    let mut switches = vec![
        // The browser has to be able to speak to the protocol client.
        "--remote-allow-origins=*".to_string(),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        // Keeps the automation flag out of the navigator, natively, so that
        // no script level override is needed for it.
        "--disable-blink-features=AutomationControlled".to_string(),
        // The window matches the display of the profile.
        format!(
            "--window-size={},{}",
            profile.display.width, profile.display.height
        ),
        // The language matches the locale of the profile.
        format!(
            "--lang={}",
            profile
                .locale
                .languages
                .first()
                .cloned()
                .unwrap_or_else(|| "en-US".to_string())
        ),
        // The real address must not leak into a peer connection candidate.
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp".to_string(),
        // A software renderer is deterministic, which is what the profile
        // describes, and it keeps the session working on a headless host.
        "--use-angle=swiftshader".to_string(),
        "--enable-unsafe-webgpu".to_string(),
    ];

    if cfg!(target_os = "linux") {
        switches.push("--disable-dev-shm-usage".to_string());
    }

    if provider.supports_persona_switches() {
        // Only the switches that this build knows are sent. A switch the
        // build does not know would leave the surface at the host value.
        for switch in persona_switches(profile) {
            let name = switch.trim_start_matches("--").split('=').next().unwrap_or("");
            if provider.knows_switch(name) {
                switches.push(switch);
            }
        }
    }

    switches
}

/// The switches for builds that accept the optional persona vocabulary.
fn persona_switches(profile: &PersonaProfile) -> Vec<String> {
    let switches = vec![
        format!("--uxr-seed={}", profile.seed),
        format!(
            "--uxr-country={}",
            profile.country
        ),
        format!("--uxr-platform={}", profile.platform.navigator_platform()),
        format!(
            "--uxr-ua-platform={}",
            profile.user_agent.platform
        ),
        format!(
            "--uxr-ua-os={}",
            match profile.platform {
                reach_persona::Platform::Windows => "Windows NT 10.0; Win64; x64",
                reach_persona::Platform::Mac => "Macintosh; Intel Mac OS X 10_15_7",
            }
        ),
        format!("--uxr-ua-arch={}", profile.user_agent.architecture),
        format!("--uxr-ua-bitness={}", profile.user_agent.bitness),
        format!(
            "--uxr-ua-platform-version={}",
            profile.user_agent.platform_version
        ),
        "--uxr-ua-brand=Google Chrome".to_string(),
        format!("--uxr-ua-model={}", profile.user_agent.model),
        format!(
            "--uxr-ua-full-version={}",
            profile
                .user_agent
                .full_version_list
                .first()
                .map(|b| b.version.clone())
                .unwrap_or_default()
        ),
        format!(
            "--uxr-hw-concurrency={}",
            profile.hardware.hardware_concurrency
        ),
        format!("--uxr-device-memory={}", profile.hardware.device_memory),
        format!("--uxr-webgl-vendor={}", profile.gpu.webgl_vendor),
        format!("--uxr-webgl-renderer={}", profile.gpu.webgl_renderer),
        "--uxr-webgl-fullparams".to_string(),
        format!("--uxr-webgpu-vendor={}", profile.gpu.webgpu_vendor),
        format!(
            "--uxr-webgpu-architecture={}",
            profile.gpu.webgpu_architecture
        ),
        format!("--uxr-canvas-seed={}", profile.noise.canvas_seed),
        format!("--uxr-audio-seed={}", profile.noise.audio_seed),
        format!("--uxr-timezone={}", profile.locale.timezone),
        format!(
            "--uxr-languages={}",
            profile.locale.languages.join(",")
        ),
        format!("--uxr-color-scheme={}", profile.display.color_scheme),
        format!("--uxr-screen-width={}", profile.display.width),
        format!("--uxr-screen-height={}", profile.display.height),
        format!(
            "--uxr-screen-avail-width={}",
            profile.display.avail_width
        ),
        format!(
            "--uxr-screen-avail-height={}",
            profile.display.avail_height
        ),
        format!("--uxr-screen-color-depth={}", profile.display.color_depth),
        format!(
            "--uxr-device-pixel-ratio={}",
            profile.display.device_pixel_ratio
        ),
        format!("--uxr-outer-width={}", profile.display.outer_width),
        format!("--uxr-outer-height={}", profile.display.outer_height),
        format!("--uxr-net-rtt={}", profile.network.rtt),
        format!("--uxr-net-downlink={}", profile.network.downlink),
        format!(
            "--uxr-net-effective-type={}",
            profile.network.effective_type
        ),
        format!(
            "--uxr-media-devices={}",
            profile.devices.media_devices.join(",")
        ),
        format!("--uxr-storage-quota={}", profile.storage_quota_bytes),
        format!(
            "--uxr-keyboard-layout-data={}",
            profile
                .devices
                .keyboard_layout
                .iter()
                .map(|(code, key)| format!("{}={}", code, key))
                .collect::<Vec<_>>()
                .join(",")
        ),
        format!(
            "--uxr-voices-list={}",
            profile.devices.voices.join(",")
        ),
        format!("--uxr-webrtc-policy={}", profile.network.webrtc_policy),
    ];

    switches
}

/// The protocol overrides for a profile.
pub fn cdp_overrides(profile: &PersonaProfile) -> Vec<(String, Value)> {
    let mut overrides = Vec::new();

    // The user agent and the client hints have to name the same machine.
    // The `platform` field is the legacy value that ends up in
    // `navigator.platform`, which is not the same string as the client hint
    // platform: the client hint says "Windows", the legacy value says
    // "Win32".
    overrides.push((
        "Network.setUserAgentOverride".to_string(),
        json!({
            "userAgent": profile.user_agent.user_agent,
            "acceptLanguage": profile.user_agent.accept_language,
            "platform": profile.platform.navigator_platform(),
            "userAgentMetadata": {
                "brands": profile.user_agent.brands,
                "fullVersionList": profile.user_agent.full_version_list,
                "fullVersion": profile
                    .user_agent
                    .full_version_list
                    .first()
                    .map(|b| b.version.clone())
                    .unwrap_or_default(),
                "platform": profile.user_agent.platform,
                "platformVersion": profile.user_agent.platform_version,
                "architecture": profile.user_agent.architecture,
                "model": profile.user_agent.model,
                "mobile": false,
                "bitness": profile.user_agent.bitness,
                "wow64": profile.user_agent.wow64,
            }
        }),
    ));

    // The locale and the timezone follow the country of the profile.
    if let Some(locale) = profile.locale.languages.first() {
        overrides.push((
            "Emulation.setLocaleOverride".to_string(),
            json!({ "locale": locale }),
        ));
    }
    overrides.push((
        "Emulation.setTimezoneOverride".to_string(),
        json!({ "timezoneId": profile.locale.timezone }),
    ));

    // The hardware surfaces.
    overrides.push((
        "Emulation.setHardwareConcurrencyOverride".to_string(),
        json!({ "hardwareConcurrency": profile.hardware.hardware_concurrency }),
    ));

    // The display surfaces. The window is a little smaller than the screen,
    // because a window always has a frame, and the frame is part of what a
    // page can measure.
    let inner_width = profile.display.avail_width.saturating_sub(18).max(1);
    let inner_height = profile.display.avail_height.saturating_sub(87).max(1);
    overrides.push((
        "Emulation.setDeviceMetricsOverride".to_string(),
        json!({
            "width": inner_width,
            "height": inner_height,
            "deviceScaleFactor": profile.display.device_pixel_ratio,
            "mobile": false,
            "screenWidth": profile.display.width,
            "screenHeight": profile.display.height,
            "positionX": 0,
            "positionY": 0,
            "screenOrientation": {
                "type": "landscapePrimary",
                "angle": 0
            }
        }),
    ));

    // The media preferences.
    overrides.push((
        "Emulation.setEmulatedMedia".to_string(),
        json!({
            "features": [
                { "name": "prefers-color-scheme", "value": profile.display.color_scheme },
                { "name": "color-gamut", "value": profile.display.color_gamut },
                { "name": "dynamic-range", "value": profile.display.dynamic_range },
                { "name": "forced-colors", "value": "none" }
            ]
        }),
    ));

    // A page that is never focused behaves differently from a page the user
    // is looking at.
    overrides.push((
        "Emulation.setFocusEmulationEnabled".to_string(),
        json!({ "enabled": true }),
    ));

    overrides
}

/// Applies the environment profile to a page session.
///
/// The order is fixed: the domains have to be enabled before the overrides
/// are sent, and the script has to be installed before the document is
/// created, so that it runs before any page script.
///
/// The profile is always applied through the protocol and the script, even
/// when the browser understands the extended switch vocabulary. A build in
/// the public first generation mode carries the vocabulary but does not act
/// on it, and a build that does act on it would only produce the same values
/// that the profile already describes. The protocol route is the one route
/// that is known to work on every build, so it is the one that is used.
pub async fn apply_to_session(
    client: &CdpClient,
    session_id: &str,
    profile: &PersonaProfile,
) -> Result<()> {
    client.call_session(session_id, "Page.enable", json!({})).await?;
    client.call_session(session_id, "Runtime.enable", json!({})).await?;
    client.call_session(session_id, "Network.enable", json!({})).await?;

    for (method, params) in cdp_overrides(profile) {
        let result = if method.starts_with("Browser.") {
            client.call(&method, params).await
        } else {
            client.call_session(session_id, &method, params).await
        };
        if let Err(error) = result {
            tracing::debug!("The browser refused {}: {}", method, error);
        }
    }

    let script = shim_script(profile);
    client
        .call_session(
            session_id,
            "Page.addScriptToEvaluateOnNewDocument",
            json!({ "source": script }),
        )
        .await?;

    Ok(())
}

/// The script that is installed on every new document.
pub fn shim_script(profile: &PersonaProfile) -> String {
    let payload = shim_payload(profile);
    SHIM_TEMPLATE.replace("__PAYLOAD__", &payload.to_string())
}

/// The data the injected script works from.
pub fn shim_payload(profile: &PersonaProfile) -> Value {
    let mime_types = vec![
        json!({ "type": "application/pdf", "suffixes": "pdf", "description": "Portable Document Format" }),
        json!({ "type": "text/pdf", "suffixes": "pdf", "description": "Portable Document Format" }),
    ];

    let plugin_names = [
        ("PDF Viewer", "internal-pdf-viewer"),
        ("Chrome PDF Viewer", "internal-pdf-viewer"),
        ("Chromium PDF Viewer", "internal-pdf-viewer"),
        ("Microsoft Edge PDF Viewer", "internal-pdf-viewer"),
        ("WebKit built-in PDF", "internal-pdf-viewer"),
    ];

    let plugins: Vec<Value> = plugin_names
        .iter()
        .map(|(name, filename)| {
            json!({
                "name": name,
                "filename": filename,
                "description": "Portable Document Format",
                "mimeTypes": [0, 1]
            })
        })
        .collect();

    json!({
        "languages": profile.locale.languages,
        "hardware": {
            "deviceMemory": profile.hardware.device_memory,
            "hardwareConcurrency": profile.hardware.hardware_concurrency,
        },
        "connection": {
            "rtt": profile.network.rtt,
            "downlink": profile.network.downlink,
            "effectiveType": profile.network.effective_type,
            "saveData": profile.network.save_data,
        },
        "plugins": plugins,
        "mimeTypes": mime_types,
        "webgl": {
            "vendor": profile.gpu.webgl_vendor,
            "renderer": profile.gpu.webgl_renderer,
            "version": "WebGL 1.0 (OpenGL ES 2.0 Chromium)",
            "version2": "WebGL 2.0 (OpenGL ES 3.0 Chromium)",
            "shadingLanguageVersion": "WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)",
            "shadingLanguageVersion2": "WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)",
            "maxTextureSize": profile.gpu.max_texture_size,
            "maxCubeMapTextureSize": profile.gpu.max_cube_map_texture_size,
            "maxRenderbufferSize": profile.gpu.max_renderbuffer_size,
            "maxViewportDims": profile.gpu.max_viewport_dims,
            "extensionCount": profile.gpu.extension_count,
            "precisionHighFloat": profile.gpu.precision_high_float,
        },
        "webgpu": {
            "vendor": profile.gpu.webgpu_vendor,
            "architecture": profile.gpu.webgpu_architecture,
            "description": profile.gpu.webgpu_description,
            "subgroupMinSize": 16,
            "subgroupMaxSize": 256,
        },
        "display": {
            "width": profile.display.width,
            "height": profile.display.height,
            "availWidth": profile.display.avail_width,
            "availHeight": profile.display.avail_height,
            "colorDepth": profile.display.color_depth,
            "outerWidth": profile.display.outer_width,
            "outerHeight": profile.display.outer_height,
        },
        "mediaDevices": profile.devices.media_devices,
        "battery": {
            "charging": profile.devices.battery_charging,
            "chargingTime": profile.devices.battery_charging_time,
            "dischargingTime": profile.devices.battery_discharging_time,
            "level": profile.devices.battery_level,
        },
        "keyboard": profile
            .devices
            .keyboard_layout
            .iter()
            .map(|(code, key)| json!([code, key]))
            .collect::<Vec<Value>>(),
        "voices": profile.devices.voices,
        "fonts": profile.devices.fonts,
        "storage": { "quota": profile.storage_quota_bytes },
        "noise": {
            "secret": profile.noise.session_secret,
            "canvas": profile.noise.canvas_seed,
            "audio": profile.noise.audio_seed,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use reach_persona::{GeneratorConfig, PersonaGenerator, Platform};

    fn profile() -> PersonaProfile {
        PersonaGenerator::new(GeneratorConfig {
            seed: Some(1234),
            country: Some("DE".to_string()),
            browser_major: 155,
            browser_full_version: "155.0.8059.85".to_string(),
            noise_secret: Some(99),
        })
        .generate()
    }

    #[test]
    fn test_overrides_cover_the_important_surfaces() {
        let overrides = cdp_overrides(&profile());
        let methods: Vec<&str> = overrides.iter().map(|(m, _)| m.as_str()).collect();
        assert!(methods.contains(&"Network.setUserAgentOverride"));
        assert!(methods.contains(&"Emulation.setTimezoneOverride"));
        assert!(methods.contains(&"Emulation.setLocaleOverride"));
        assert!(methods.contains(&"Emulation.setHardwareConcurrencyOverride"));
        assert!(methods.contains(&"Emulation.setDeviceMetricsOverride"));
        assert!(methods.contains(&"Emulation.setEmulatedMedia"));
    }

    #[test]
    fn test_user_agent_override_carries_the_client_hints() {
        let overrides = cdp_overrides(&profile());
        let (_, params) = overrides
            .iter()
            .find(|(m, _)| m == "Network.setUserAgentOverride")
            .expect("user agent override");
        let metadata = &params["userAgentMetadata"];
        assert_eq!(metadata["platform"], "Windows");
        assert_eq!(metadata["bitness"], "64");
        assert!(!metadata["brands"].as_array().unwrap().is_empty());
    }

    #[test]
    fn test_shim_script_has_the_payload_replaced() {
        let script = shim_script(&profile());
        assert!(!script.contains("__PAYLOAD__"));
        assert!(script.contains("WebGLRenderingContext"));
        assert!(script.contains("navigator"));
    }

    #[test]
    fn test_shim_payload_is_valid_json() {
        let profile = profile();
        let payload = shim_payload(&profile);
        assert_eq!(
            payload["hardware"]["hardwareConcurrency"],
            profile.hardware.hardware_concurrency
        );
        assert_eq!(
            payload["display"]["width"],
            profile.display.width
        );
        assert!(payload["fonts"].as_array().unwrap().len() > 40);
    }

    #[test]
    fn test_cli_switches_are_generic_without_persona_support() {
        let provider = BrowserProvider::from_path(std::path::PathBuf::from("chrome.exe")).unwrap();
        let switches = cli_switches(&profile(), &provider);
        assert!(switches.iter().any(|s| s == "--disable-blink-features=AutomationControlled"));
        assert!(!switches.iter().any(|s| s.starts_with("--uxr-")));
    }

    #[test]
    fn test_persona_switches_are_generated_for_supporting_builds() {
        let profile = profile();
        let switches = persona_switches(&profile);
        assert!(switches.iter().any(|s| s
            == &format!("--uxr-hw-concurrency={}", profile.hardware.hardware_concurrency)));
        assert!(switches
            .iter()
            .any(|s| s == &format!("--uxr-timezone={}", profile.locale.timezone)));
        assert!(switches.iter().any(|s| s
            == &format!("--uxr-webgl-renderer={}", profile.gpu.webgl_renderer)));
    }

    #[test]
    fn test_macos_profile_uses_apple_platform_token() {
        let mut p = profile();
        p.platform = Platform::Mac;
        let switches = persona_switches(&p);
        assert!(switches.iter().any(|s| s == "--uxr-platform=MacIntel"));
    }

    #[test]
    fn test_the_injected_script_is_balanced() {
        // A script that does not parse is silently ignored by the browser,
        // so the whole profile would be lost without any error. The check
        // counts the brackets outside of strings and comments.
        let script = shim_script(&profile());
        let mut depth = 0i32;
        let mut index = 0usize;
        let bytes = script.as_bytes();

        while index < bytes.len() {
            match bytes[index] {
                b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'/' => {
                    while index < bytes.len() && bytes[index] != b'\n' {
                        index += 1;
                    }
                }
                b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'*' => {
                    index += 2;
                    while index + 1 < bytes.len()
                        && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                    {
                        index += 1;
                    }
                    index += 2;
                }
                quote @ (b'\'' | b'"' | b'`') => {
                    index += 1;
                    while index < bytes.len() {
                        if bytes[index] == b'\\' {
                            index += 2;
                            continue;
                        }
                        if bytes[index] == quote {
                            break;
                        }
                        index += 1;
                    }
                    index += 1;
                }
                b'{' | b'(' | b'[' => {
                    depth += 1;
                    index += 1;
                }
                b'}' | b')' | b']' => {
                    depth -= 1;
                    assert!(depth >= 0, "the script closes a bracket it never opened");
                    index += 1;
                }
                _ => index += 1,
            }
        }

        assert_eq!(depth, 0, "the script has unbalanced brackets");
    }
}
