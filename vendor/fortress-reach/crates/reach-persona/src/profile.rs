//! The environment profile: a complete, internally consistent description of
//! the machine a browser session presents to the web.
//!
//! Every field in this module is a *surface* that a page can observe. The
//! profile exists so that all of those surfaces can be derived from one seed
//! and can therefore agree with each other. Disagreement between surfaces is
//! the single most reliable way to be classified as automated, so the profile
//! is generated as a whole and validated as a whole.

use serde::{Deserialize, Serialize};

/// Operating system family the session presents as.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Windows,
    Mac,
}

impl Platform {
    /// `navigator.platform` value.
    pub fn navigator_platform(self) -> &'static str {
        match self {
            Platform::Windows => "Win32",
            Platform::Mac => "MacIntel",
        }
    }

    /// `navigator.userAgentData.platform` value.
    pub fn client_hint_platform(self) -> &'static str {
        match self {
            Platform::Windows => "Windows",
            Platform::Mac => "macOS",
        }
    }
}

/// One entry of the `Sec-CH-UA` brand list.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Brand {
    pub brand: String,
    pub version: String,
}

/// User-Agent string and the client-hint metadata that must agree with it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserAgentProfile {
    /// Full `navigator.userAgent` value.
    pub user_agent: String,
    /// `userAgentData.brands`.
    pub brands: Vec<Brand>,
    /// `userAgentData.fullVersionList`.
    pub full_version_list: Vec<Brand>,
    /// `userAgentData.platform`.
    pub platform: String,
    /// `userAgentData.platformVersion` (e.g. `15.0.0`).
    pub platform_version: String,
    /// `userAgentData.architecture` (e.g. `x86`).
    pub architecture: String,
    /// `userAgentData.bitness` (e.g. `64`).
    pub bitness: String,
    /// `userAgentData.model` (empty on desktop).
    pub model: String,
    /// `userAgentData.wow64`.
    pub wow64: bool,
    /// Value sent in the `Accept-Language` header.
    pub accept_language: String,
}

/// GPU identity shared by WebGL, WebGPU and the canvas noise seed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GpuProfile {
    /// `UNMASKED_VENDOR_WEBGL`.
    pub webgl_vendor: String,
    /// `UNMASKED_RENDERER_WEBGL`.
    pub webgl_renderer: String,
    /// `navigator.gpu` adapter vendor.
    pub webgpu_vendor: String,
    /// `navigator.gpu` adapter architecture.
    pub webgpu_architecture: String,
    /// `navigator.gpu` adapter description (empty string, as real Chrome returns).
    pub webgpu_description: String,
    /// Whether the adapter is a fallback adapter.
    pub webgpu_is_fallback: bool,
    /// Whether the numeric WebGL limits are aligned to the advertised GPU.
    pub align_webgl_parameters: bool,
    /// `GL_MAX_TEXTURE_SIZE`.
    pub max_texture_size: u32,
    /// `GL_MAX_VIEWPORT_DIMS`.
    pub max_viewport_dims: [u32; 2],
    /// `GL_MAX_RENDERBUFFER_SIZE`.
    pub max_renderbuffer_size: u32,
    /// `GL_MAX_CUBE_MAP_TEXTURE_SIZE`.
    pub max_cube_map_texture_size: u32,
    /// Number of advertised WebGL extensions.
    pub extension_count: u32,
    /// `getShaderPrecisionFormat` range for highp float.
    pub precision_high_float: (i32, i32, i32),
}

/// Display geometry, colour capabilities and media preferences.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DisplayProfile {
    /// `screen.width`.
    pub width: u32,
    /// `screen.height`.
    pub height: u32,
    /// `screen.availWidth`.
    pub avail_width: u32,
    /// `screen.availHeight`.
    pub avail_height: u32,
    /// `screen.colorDepth`.
    pub color_depth: u32,
    /// `window.devicePixelRatio`.
    pub device_pixel_ratio: f64,
    /// `window.outerWidth`.
    pub outer_width: u32,
    /// `window.outerHeight`.
    pub outer_height: u32,
    /// `prefers-color-scheme`.
    pub color_scheme: String,
    /// `color-gamut` media feature.
    pub color_gamut: String,
    /// `dynamic-range` media feature.
    pub dynamic_range: String,
}

/// Locale surfaces: they travel together with the exit country.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocaleProfile {
    /// IANA timezone.
    pub timezone: String,
    /// `navigator.languages`.
    pub languages: Vec<String>,
}

/// Hardware surfaces.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HardwareProfile {
    /// `navigator.hardwareConcurrency`.
    pub hardware_concurrency: u32,
    /// `navigator.deviceMemory`.
    pub device_memory: f64,
}

/// Media and input device surfaces.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DeviceProfile {
    /// Synthetic `enumerateDevices()` result, empty device id and label.
    pub media_devices: Vec<String>,
    /// `navigator.getBattery().charging`.
    pub battery_charging: bool,
    /// `navigator.getBattery().level`.
    pub battery_level: f64,
    /// `navigator.getBattery().chargingTime`.
    pub battery_charging_time: f64,
    /// `navigator.getBattery().dischargingTime`.
    pub battery_discharging_time: f64,
    /// `speechSynthesis.getVoices()` result.
    pub voices: Vec<String>,
    /// Keyboard layout map, as a `code -> key` table.
    pub keyboard_layout: Vec<(String, String)>,
    /// Font families reported to the page.
    pub fonts: Vec<String>,
}

/// Network surfaces.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct NetworkProfile {
    /// `navigator.connection.rtt` in milliseconds.
    pub rtt: u32,
    /// `navigator.connection.downlink` in megabits per second.
    pub downlink: f64,
    /// `navigator.connection.effectiveType`.
    pub effective_type: String,
    /// `navigator.connection.saveData`.
    pub save_data: bool,
    /// WebRTC candidate policy.
    pub webrtc_policy: String,
}

/// Per-launch noise seeds.
///
/// The structural machine is reproducible from `seed`; the noise is not. It is
/// derived from a fresh secret on every launch and then keyed per site, so a
/// page sees a stable value for the whole session while two different sessions
/// never share a fingerprint.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoiseProfile {
    /// Seed for canvas and WebGL readback noise.
    pub canvas_seed: u64,
    /// Seed for audio output noise.
    pub audio_seed: u64,
    /// Per-session secret, never persisted.
    pub session_secret: String,
}

/// A complete environment profile.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PersonaProfile {
    /// Stable identifier for this profile, derived from the seed.
    pub id: String,
    /// The seed the profile was generated from.
    pub seed: u64,
    /// ISO 3166-1 alpha-2 country the profile is anchored to.
    pub country: String,
    /// Operating system family.
    pub platform: Platform,
    /// User agent and client hints.
    pub user_agent: UserAgentProfile,
    /// GPU identity.
    pub gpu: GpuProfile,
    /// Display geometry and media preferences.
    pub display: DisplayProfile,
    /// Locale.
    pub locale: LocaleProfile,
    /// Hardware.
    pub hardware: HardwareProfile,
    /// Devices and input.
    pub devices: DeviceProfile,
    /// Network.
    pub network: NetworkProfile,
    /// `navigator.storage.estimate().quota` in bytes.
    pub storage_quota_bytes: u64,
    /// Noise seeds.
    pub noise: NoiseProfile,
}

impl PersonaProfile {
    /// Short human readable summary, used in logs and in the desktop UI.
    pub fn summary(&self) -> String {
        format!(
            "{} / {} / {} / {}x{}@{}x / {} cores / {} GB",
            self.id,
            self.country,
            self.platform.client_hint_platform(),
            self.display.width,
            self.display.height,
            self.display.device_pixel_ratio,
            self.hardware.hardware_concurrency,
            self.hardware.device_memory
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_platform_tokens() {
        assert_eq!(Platform::Windows.navigator_platform(), "Win32");
        assert_eq!(Platform::Mac.navigator_platform(), "MacIntel");
        assert_eq!(Platform::Mac.client_hint_platform(), "macOS");
    }

    #[test]
    fn test_profile_serializes() {
        let profile = PersonaProfile {
            id: "abc123".into(),
            seed: 1,
            country: "DE".into(),
            platform: Platform::Windows,
            user_agent: UserAgentProfile {
                user_agent: "ua".into(),
                brands: vec![Brand {
                    brand: "Chromium".into(),
                    version: "155".into(),
                }],
                full_version_list: vec![],
                platform: "Windows".into(),
                platform_version: "15.0.0".into(),
                architecture: "x86".into(),
                bitness: "64".into(),
                model: String::new(),
                wow64: false,
                accept_language: "de-DE,de;q=0.9".into(),
            },
            gpu: GpuProfile {
                webgl_vendor: "v".into(),
                webgl_renderer: "r".into(),
                webgpu_vendor: "n".into(),
                webgpu_architecture: String::new(),
                webgpu_description: String::new(),
                webgpu_is_fallback: false,
                align_webgl_parameters: true,
                max_texture_size: 16384,
                max_viewport_dims: [16384, 16384],
                max_renderbuffer_size: 16384,
                max_cube_map_texture_size: 16384,
                extension_count: 30,
                precision_high_float: (127, 127, 23),
            },
            display: DisplayProfile {
                width: 1920,
                height: 1080,
                avail_width: 1920,
                avail_height: 1032,
                color_depth: 24,
                device_pixel_ratio: 1.0,
                outer_width: 1920,
                outer_height: 1080,
                color_scheme: "dark".into(),
                color_gamut: "srgb".into(),
                dynamic_range: "standard".into(),
            },
            locale: LocaleProfile {
                timezone: "Europe/Berlin".into(),
                languages: vec!["de-DE".into(), "de".into(), "en".into()],
            },
            hardware: HardwareProfile {
                hardware_concurrency: 8,
                device_memory: 8.0,
            },
            devices: DeviceProfile {
                media_devices: vec![],
                battery_charging: true,
                battery_level: 0.8,
                battery_charging_time: 3600.0,
                battery_discharging_time: 14400.0,
                voices: vec![],
                keyboard_layout: vec![],
                fonts: vec![],
            },
            network: NetworkProfile {
                rtt: 50,
                downlink: 10.0,
                effective_type: "4g".into(),
                save_data: false,
                webrtc_policy: "disable_non_proxied_udp".into(),
            },
            storage_quota_bytes: 128_000_000_000,
            noise: NoiseProfile {
                canvas_seed: 1,
                audio_seed: 2,
                session_secret: "s".into(),
            },
        };

        let json = serde_json::to_string(&profile).expect("serialize");
        let back: PersonaProfile = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(profile, back);
    }
}
