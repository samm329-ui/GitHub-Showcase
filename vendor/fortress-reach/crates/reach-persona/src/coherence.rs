//! Coherence validation.
//!
//! The generator builds a profile so that its surfaces agree with each other.
//! This module is the safety net: it re-checks the result, so that a future
//! change to the generator cannot silently produce an impossible machine.

use crate::profile::{PersonaProfile, Platform};

/// Returns a list of coherence problems. An empty list means the profile is
/// internally consistent.
pub fn validate(profile: &PersonaProfile) -> Vec<String> {
    let mut issues = Vec::new();

    // --- Identity -------------------------------------------------------
    match profile.platform {
        Platform::Windows => {
            if !profile.user_agent.user_agent.contains("Windows NT") {
                issues.push("user agent does not mention Windows".into());
            }
            if profile.user_agent.platform != "Windows" {
                issues.push("client hint platform is not Windows".into());
            }
            if profile.user_agent.architecture != "x86" {
                issues.push("Windows architecture must be x86".into());
            }
        }
        Platform::Mac => {
            if !profile.user_agent.user_agent.contains("Mac OS X") {
                issues.push("user agent does not mention macOS".into());
            }
            if profile.user_agent.platform != "macOS" {
                issues.push("client hint platform is not macOS".into());
            }
            if profile.user_agent.architecture != "arm" {
                issues.push("Apple Silicon architecture must be arm".into());
            }
        }
    }

    if profile.user_agent.user_agent.contains("Headless") {
        issues.push("user agent leaks the headless token".into());
    }

    // The client hints and the user agent have to name the same major version.
    let chrome_major = profile
        .user_agent
        .user_agent
        .split("Chrome/")
        .nth(1)
        .and_then(|rest| rest.split('.').next())
        .unwrap_or("");
    if chrome_major.is_empty() {
        issues.push("user agent does not contain a Chrome version".into());
    } else if !profile
        .user_agent
        .brands
        .iter()
        .any(|b| b.version == chrome_major && b.brand != "Not)A;Brand")
    {
        issues.push("client hint brands disagree with the user agent version".into());
    }

    // --- Display --------------------------------------------------------
    if profile.display.avail_width > profile.display.width {
        issues.push("availWidth exceeds screen width".into());
    }
    if profile.display.avail_height > profile.display.height {
        issues.push("availHeight exceeds screen height".into());
    }
    if profile.display.outer_width < profile.display.width {
        issues.push("outerWidth is smaller than the screen width".into());
    }
    if profile.display.outer_height < profile.display.height {
        issues.push("outerHeight is smaller than the screen height".into());
    }
    if !matches!(profile.display.device_pixel_ratio, 1.0 | 1.25 | 1.5 | 2.0) {
        issues.push("device pixel ratio is not a plausible value".into());
    }
    if profile.display.color_depth != 24 {
        issues.push("color depth must be 24".into());
    }
    if !matches!(
        profile.display.color_scheme.as_str(),
        "light" | "dark" | "no-preference"
    ) {
        issues.push("color scheme is not a valid value".into());
    }

    // --- Hardware -------------------------------------------------------
    if profile.hardware.hardware_concurrency == 0
        || profile.hardware.hardware_concurrency > 128
    {
        issues.push("hardware concurrency is out of range".into());
    }
    if !matches!(
        profile.hardware.device_memory,
        0.25 | 0.5 | 1.0 | 2.0 | 4.0 | 8.0
    ) {
        issues.push("device memory is not a web bucket value".into());
    }

    // --- Locale ---------------------------------------------------------
    if profile.locale.languages.is_empty() {
        issues.push("no languages are configured".into());
    } else {
        let primary = &profile.locale.languages[0];
        if !primary.contains('-') {
            issues.push("the primary language has no region".into());
        } else if primary.rsplit('-').next() != Some(profile.country.as_str()) {
            issues.push("the primary language does not match the country".into());
        }
        if !profile.user_agent.accept_language.starts_with(primary.as_str()) {
            issues.push("accept language does not start with the primary language".into());
        }
    }
    if !profile.locale.timezone.contains('/') {
        issues.push("the timezone is not an IANA identifier".into());
    }

    // --- Graphics -------------------------------------------------------
    let apple = profile.gpu.webgl_renderer.contains("ANGLE (Apple");
    let d3d = profile.gpu.webgl_renderer.contains("Direct3D11");
    match profile.platform {
        Platform::Mac if !apple => issues.push("macOS session with a non-Apple GPU".into()),
        Platform::Windows if !d3d => issues.push("Windows session with a non-D3D11 GPU".into()),
        _ => {}
    }
    if profile.gpu.webgpu_vendor.is_empty() {
        issues.push("the WebGPU vendor is empty".into());
    }
    if profile.gpu.webgpu_is_fallback {
        issues.push("the WebGPU adapter must not be a fallback adapter".into());
    }
    if profile.gpu.max_texture_size < profile.gpu.max_cube_map_texture_size {
        issues.push("the cube map limit exceeds the texture limit".into());
    }

    // --- Devices --------------------------------------------------------
    if profile.devices.fonts.is_empty() {
        issues.push("no fonts are configured".into());
    }
    if profile.devices.voices.is_empty() {
        issues.push("no voices are configured".into());
    }
    if profile.devices.keyboard_layout.len() < 40 {
        issues.push("the keyboard layout is incomplete".into());
    }
    if !profile.devices.battery_charging
        && profile.devices.battery_discharging_time <= 0.0
    {
        issues.push("a discharging battery must report a discharge time".into());
    }

    // --- Network --------------------------------------------------------
    match profile.network.effective_type.as_str() {
        "4g" => {
            if profile.network.rtt > 150 {
                issues.push("effective type 4g with a high round trip time".into());
            }
        }
        "3g" => {
            if profile.network.rtt > 300 {
                issues.push("effective type 3g with a high round trip time".into());
            }
        }
        "2g" => {
            if profile.network.downlink > 5.0 {
                issues.push("effective type 2g with a high downlink".into());
            }
        }
        other => issues.push(format!("unknown effective connection type {}", other)),
    }
    if profile.network.downlink <= 0.0 {
        issues.push("the downlink speed must be positive".into());
    }

    // --- Storage --------------------------------------------------------
    if profile.storage_quota_bytes < 1024 * 1024 * 1024 {
        issues.push("the storage quota is implausibly small".into());
    }

    issues
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::{GeneratorConfig, PersonaGenerator};

    fn profile(seed: u64, country: &str) -> PersonaProfile {
        PersonaGenerator::new(GeneratorConfig {
            seed: Some(seed),
            country: Some(country.to_string()),
            browser_major: 155,
            browser_full_version: "155.0.8059.85".to_string(),
            noise_secret: Some(7),
        })
        .generate()
    }

    #[test]
    fn test_valid_profiles_have_no_issues() {
        for country in ["US", "DE", "FR", "JP", "BR", "IN", "GB"] {
            for seed in 0..8u64 {
                let issues = validate(&profile(seed, country));
                assert!(issues.is_empty(), "{} {}: {:?}", country, seed, issues);
            }
        }
    }

    #[test]
    fn test_detects_platform_mismatch() {
        let mut p = profile(1, "US");
        p.gpu.webgl_renderer = "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)".into();
        let issues = validate(&p);
        assert!(issues.iter().any(|i| i.contains("non-D3D11 GPU")));

        let mut m = profile(1, "JP");
        m.gpu.webgl_renderer = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)".into();
        let issues = validate(&m);
        assert!(issues.iter().any(|i| i.contains("non-Apple GPU")));
    }

    #[test]
    fn test_detects_language_country_mismatch() {
        let mut p = profile(1, "DE");
        p.locale.languages = vec!["fr-FR".into()];
        let issues = validate(&p);
        assert!(issues.iter().any(|i| i.contains("does not match the country")));
    }

    #[test]
    fn test_detects_display_inconsistency() {
        let mut p = profile(1, "US");
        p.display.avail_height = p.display.height + 10;
        let issues = validate(&p);
        assert!(issues.iter().any(|i| i.contains("availHeight")));
    }
}
