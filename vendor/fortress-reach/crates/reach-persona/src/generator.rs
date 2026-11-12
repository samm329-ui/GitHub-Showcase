//! The persona generator.
//!
//! One seed produces one machine. The machine is internally consistent: the
//! operating system determines the user agent, the user agent determines the
//! client hints, the graphics device determines the WebGL and WebGPU identity,
//! the display determines the device pixel ratio, and the country determines
//! the timezone, the languages and the keyboard.
//!
//! Noise surfaces (canvas, audio) are deliberately *not* derived from the
//! seed: they come from a per-launch secret, so two sessions of the same
//! machine never share a rendering fingerprint.

use crate::assets;
use crate::geo;
use crate::gpu;
use crate::prng::field_stream;
use crate::profile::{
    Brand, DeviceProfile, DisplayProfile, GpuProfile, HardwareProfile, LocaleProfile, NetworkProfile,
    NoiseProfile, PersonaProfile, Platform, UserAgentProfile,
};

/// Inputs required to build a profile.
#[derive(Clone, Debug)]
pub struct GeneratorConfig {
    /// Structural seed. `None` means "pick one at random".
    pub seed: Option<u64>,
    /// Country the session is anchored to. `None` means "derive from the seed".
    pub country: Option<String>,
    /// Major browser version, taken from the browser that will actually run.
    /// A user agent that disagrees with the client hints is a strong tell.
    pub browser_major: u32,
    /// Full browser version, used for `fullVersionList`.
    pub browser_full_version: String,
    /// Secret for the noise surfaces. `None` means "derive from the seed",
    /// which is only appropriate for tests.
    pub noise_secret: Option<u64>,
}

impl Default for GeneratorConfig {
    fn default() -> Self {
        Self {
            seed: None,
            country: None,
            browser_major: 155,
            browser_full_version: "155.0.0.0".to_string(),
            noise_secret: None,
        }
    }
}

/// Builds environment profiles.
#[derive(Clone, Debug)]
pub struct PersonaGenerator {
    config: GeneratorConfig,
}

impl PersonaGenerator {
    pub fn new(config: GeneratorConfig) -> Self {
        Self { config }
    }

    /// Generates a profile.
    pub fn generate(&self) -> PersonaProfile {
        let seed = self.config.seed.unwrap_or_else(random_seed);
        let country = self
            .config
            .country
            .clone()
            .unwrap_or_else(|| pick_country(seed));
        let country_profile = geo::country(&country);

        let is_macos = geo::prefers_macos(&country);
        let platform = if is_macos {
            Platform::Mac
        } else {
            Platform::Windows
        };

        let profile = PersonaProfile {
            id: profile_id(seed, &country),
            seed,
            country: country_profile.code.to_string(),
            platform,
            user_agent: self.build_user_agent(platform),
            gpu: self.build_gpu(platform),
            display: self.build_display(platform),
            locale: LocaleProfile {
                timezone: country_profile.timezone.to_string(),
                languages: country_profile
                    .accept_language
                    .split(',')
                    .map(|part| part.split(';').next().unwrap_or(part).trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect(),
            },
            hardware: self.build_hardware(platform),
            devices: self.build_devices(platform),
            network: self.build_network(),
            storage_quota_bytes: self.build_storage_quota(),
            noise: self.build_noise(seed),
        };

        profile
    }

    fn build_user_agent(&self, platform: Platform) -> UserAgentProfile {
        let major = self.config.browser_major;
        let full = &self.config.browser_full_version;
        let grease_brand = "Not)A;Brand";
        let grease_version = "24";

        let os_token = match platform {
            Platform::Windows => "Windows NT 10.0; Win64; x64",
            Platform::Mac => "Macintosh; Intel Mac OS X 10_15_7",
        };

        let user_agent = format!(
            "Mozilla/5.0 ({}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{}.0.0.0 Safari/537.36",
            os_token, major
        );

        let mut brands = vec![
            Brand {
                brand: "Chromium".to_string(),
                version: major.to_string(),
            },
            Brand {
                brand: "Google Chrome".to_string(),
                version: major.to_string(),
            },
            Brand {
                brand: grease_brand.to_string(),
                version: grease_version.to_string(),
            },
        ];
        // The brand list order is randomised by the browser; rotate it so the
        // session does not look like a fixed template.
        let rotation = field_stream(self.config.seed.unwrap_or(0), "brand_rotation").next_u64() as usize
            % brands.len();
        brands.rotate_left(rotation);

        let full_version_list = vec![
            Brand {
                brand: "Chromium".to_string(),
                version: full.clone(),
            },
            Brand {
                brand: "Google Chrome".to_string(),
                version: full.clone(),
            },
            Brand {
                brand: grease_brand.to_string(),
                version: "24.0.0.0".to_string(),
            },
        ];

        let (platform_version, architecture) = match platform {
            Platform::Windows => {
                let mut rng = field_stream(self.config.seed.unwrap_or(0), "win_version");
                let version = if rng.next_u64().is_multiple_of(3) {
                    "15.0.0"
                } else {
                    "10.0.0"
                };
                (version.to_string(), "x86".to_string())
            }
            Platform::Mac => ("14.0.0".to_string(), "arm".to_string()),
        };

        let country_profile = geo::country(self.config.country.as_deref().unwrap_or("US"));

        UserAgentProfile {
            user_agent,
            brands,
            full_version_list,
            platform: platform.client_hint_platform().to_string(),
            platform_version,
            architecture,
            bitness: "64".to_string(),
            model: String::new(),
            wow64: false,
            accept_language: country_profile.accept_language.to_string(),
        }
    }

    fn build_gpu(&self, platform: Platform) -> GpuProfile {
        let seed = self.config.seed.unwrap_or(0);
        let models = gpu::models_for(platform == Platform::Mac);
        let index = field_stream(seed, "gpu").next_u64() as usize % models.len();
        let model = models[index];

        GpuProfile {
            webgl_vendor: model.webgl_vendor.to_string(),
            webgl_renderer: model.webgl_renderer.to_string(),
            webgpu_vendor: model.webgpu_vendor.to_string(),
            webgpu_architecture: model.webgpu_architecture.to_string(),
            webgpu_description: String::new(),
            webgpu_is_fallback: false,
            align_webgl_parameters: true,
            max_texture_size: model.max_texture_size,
            max_viewport_dims: model.max_viewport_dims,
            max_renderbuffer_size: model.max_renderbuffer_size,
            max_cube_map_texture_size: model.max_cube_map_texture_size,
            extension_count: model.extension_count,
            precision_high_float: model.precision_high_float,
        }
    }

    fn build_display(&self, platform: Platform) -> DisplayProfile {
        let seed = self.config.seed.unwrap_or(0);
        let mut rng = field_stream(seed, "display");

        let (width, height, retina_default) = match platform {
            Platform::Windows => {
                const SIZES: &[(u32, u32, bool)] = &[
                    (1920, 1080, false),
                    (1536, 864, false),
                    (1366, 768, false),
                    (2560, 1440, false),
                    (1680, 1050, false),
                    (1280, 720, false),
                ];
                *rng.pick(SIZES)
            }
            Platform::Mac => {
                const SIZES: &[(u32, u32, bool)] = &[
                    (1512, 982, true),
                    (1728, 1117, true),
                    (1440, 900, false),
                    (2560, 1440, false),
                    (1680, 1050, false),
                ];
                *rng.pick(SIZES)
            }
        };

        // The taskbar on Windows and the menu bar on macOS eat into the
        // available height; `availHeight` can never exceed `height`.
        let reserved = match platform {
            Platform::Windows => 48,
            Platform::Mac => 25,
        };

        let dpr = if retina_default {
            2.0
        } else if rng.next_u64().is_multiple_of(5) {
            1.25
        } else {
            1.0
        };

        let dark = rng.next_u64().is_multiple_of(3);
        let p3 = rng.next_u64().is_multiple_of(4);
        let hdr = p3 && rng.next_u64().is_multiple_of(2);

        DisplayProfile {
            width,
            height,
            avail_width: width,
            avail_height: height.saturating_sub(reserved),
            color_depth: 24,
            device_pixel_ratio: dpr,
            outer_width: width,
            outer_height: height,
            color_scheme: if dark { "dark" } else { "light" }.to_string(),
            color_gamut: if p3 { "p3" } else { "srgb" }.to_string(),
            dynamic_range: if hdr { "high" } else { "standard" }.to_string(),
        }
    }

    fn build_hardware(&self, platform: Platform) -> HardwareProfile {
        let seed = self.config.seed.unwrap_or(0);
        let mut rng = field_stream(seed, "hardware");

        let cores = match platform {
            Platform::Windows => {
                const CORES: &[u32] = &[4, 8, 8, 12, 16, 20, 24];
                *rng.pick(CORES)
            }
            Platform::Mac => {
                const CORES: &[u32] = &[8, 8, 10, 12, 16];
                *rng.pick(CORES)
            }
        };

        // `navigator.deviceMemory` is reported in powers of two and capped.
        let memory = match rng.next_u64() % 5 {
            0 => 2.0,
            1 => 4.0,
            _ => 8.0,
        };

        HardwareProfile {
            hardware_concurrency: cores,
            device_memory: memory,
        }
    }

    fn build_devices(&self, platform: Platform) -> DeviceProfile {
        let seed = self.config.seed.unwrap_or(0);
        let mut rng = field_stream(seed, "devices");
        let is_macos = platform == Platform::Mac;

        let has_camera = rng.next_u64() % 10 < 7;
        let charging = !rng.next_u64().is_multiple_of(3);
        let level = 0.35 + (rng.next_f64() * 0.6);

        DeviceProfile {
            media_devices: assets::media_devices_for(has_camera),
            battery_charging: charging,
            battery_level: level,
            battery_charging_time: if charging { 3600.0 } else { 0.0 },
            battery_discharging_time: if charging {
                0.0
            } else {
                14400.0 + (rng.next_u64() % 14400) as f64
            },
            voices: assets::voices_for(is_macos),
            keyboard_layout: assets::keyboard_layout(
                geo::country(self.config.country.as_deref().unwrap_or("US")).keyboard,
            ),
            fonts: assets::FONT_FAMILIES.iter().map(|f| f.to_string()).collect(),
        }
    }

    fn build_network(&self) -> NetworkProfile {
        let seed = self.config.seed.unwrap_or(0);
        let mut rng = field_stream(seed, "network");

        const RTTS: &[u32] = &[50, 50, 100, 100, 150, 250];
        const DOWNLINKS: &[f64] = &[10.0, 20.0, 50.0, 100.0, 300.0];

        let rtt = *rng.pick(RTTS);
        let downlink = *rng.pick(DOWNLINKS);

        let effective_type = if rtt <= 150 && downlink >= 10.0 {
            "4g"
        } else if rtt <= 300 && downlink >= 2.0 {
            "3g"
        } else {
            "2g"
        };

        NetworkProfile {
            rtt,
            downlink,
            effective_type: effective_type.to_string(),
            save_data: false,
            webrtc_policy: "disable_non_proxied_udp".to_string(),
        }
    }

    fn build_storage_quota(&self) -> u64 {
        let seed = self.config.seed.unwrap_or(0);
        let mut rng = field_stream(seed, "storage");
        let gigabytes = 150 + (rng.next_u64() % 250);
        gigabytes * 1024 * 1024 * 1024
    }

    fn build_noise(&self, seed: u64) -> NoiseProfile {
        let secret = self.config.noise_secret.unwrap_or_else(|| {
            field_stream(seed, "noise").next_u64()
        });
        let canvas = field_stream(secret, "canvas").next_u64() | 1;
        let audio = field_stream(secret, "audio").next_u64() | 1;

        NoiseProfile {
            canvas_seed: canvas,
            audio_seed: audio,
            session_secret: format!("{:016x}", secret),
        }
    }
}

/// A seed derived from the clock and the process id.
pub fn random_seed() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ (std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
}

/// Picks a country for a seed, weighted towards the larger markets.
fn pick_country(seed: u64) -> String {
    const POOL: &[&str] = &[
        "US", "US", "US", "GB", "DE", "IN", "CA", "AU", "FR", "BR", "NL", "ES", "IT", "SE", "JP",
        "MX", "PL", "TR", "ZA", "SG",
    ];
    let index = field_stream(seed, "country").next_u64() as usize % POOL.len();
    POOL[index].to_string()
}

/// Short stable identifier for a profile.
fn profile_id(seed: u64, country: &str) -> String {
    let mixed = field_stream(seed, country).next_u64();
    format!("{:08x}{:04x}", (mixed >> 32) as u32, mixed as u16)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coherence::validate;

    fn config(seed: u64) -> GeneratorConfig {
        GeneratorConfig {
            seed: Some(seed),
            country: Some("DE".to_string()),
            browser_major: 155,
            browser_full_version: "155.0.8059.85".to_string(),
            noise_secret: Some(0xDEAD_BEEF),
        }
    }

    #[test]
    fn test_same_seed_same_machine() {
        let a = PersonaGenerator::new(config(42)).generate();
        let b = PersonaGenerator::new(config(42)).generate();
        assert_eq!(a, b);
    }

    #[test]
    fn test_different_seed_different_machine() {
        let a = PersonaGenerator::new(config(42)).generate();
        let b = PersonaGenerator::new(config(43)).generate();
        assert_ne!(a.gpu.webgl_renderer, b.gpu.webgl_renderer);
    }

    #[test]
    fn test_noise_is_not_reproducible_from_seed() {
        let mut cfg = config(42);
        cfg.noise_secret = None;
        let a = PersonaGenerator::new(cfg.clone()).generate();
        cfg.noise_secret = Some(999);
        let b = PersonaGenerator::new(cfg).generate();
        // The structural machine stays the same, the noise does not.
        assert_eq!(a.gpu, b.gpu);
        assert_ne!(a.noise.canvas_seed, b.noise.canvas_seed);
    }

    #[test]
    fn test_user_agent_matches_browser_version() {
        let p = PersonaGenerator::new(config(7)).generate();
        assert!(p.user_agent.user_agent.contains("Chrome/155.0.0.0"));
        assert!(!p.user_agent.user_agent.contains("Headless"));
    }

    #[test]
    fn test_generated_profiles_are_coherent() {
        for seed in 0..64u64 {
            let profile = PersonaGenerator::new(config(seed)).generate();
            let issues = validate(&profile);
            assert!(issues.is_empty(), "seed {} issues: {:?}", seed, issues);
        }
    }
}
