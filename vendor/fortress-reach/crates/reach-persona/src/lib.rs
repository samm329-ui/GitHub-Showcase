//! Environment profiles for Fortress-Reach.
//!
//! A profile is a complete, internally consistent description of the machine
//! a browser session presents to the web: operating system, user agent and
//! client hints, graphics device, display geometry, locale, hardware, devices,
//! network characteristics and rendering noise.
//!
//! The generator derives every surface from one seed, so a session can be
//! reproduced exactly. The noise surfaces are derived from a separate
//! per-launch secret, so two sessions of the same machine never share a
//! rendering fingerprint.
//!
//! ```
//! use reach_persona::{GeneratorConfig, PersonaGenerator};
//!
//! let generator = PersonaGenerator::new(GeneratorConfig {
//!     seed: Some(2024),
//!     country: Some("DE".to_string()),
//!     browser_major: 155,
//!     browser_full_version: "155.0.8059.85".to_string(),
//!     noise_secret: Some(99),
//! });
//! let profile = generator.generate();
//! assert!(profile.user_agent.user_agent.contains("Chrome/155.0.0.0"));
//! ```

pub mod assets;
pub mod coherence;
pub mod generator;
pub mod geo;
pub mod gpu;
pub mod noise;
pub mod prng;
pub mod profile;

pub use coherence::validate;
pub use generator::{random_seed, GeneratorConfig, PersonaGenerator};
pub use noise::{domain_seed, parse_secret};
pub use profile::{
    Brand, DeviceProfile, DisplayProfile, GpuProfile, HardwareProfile, LocaleProfile, NetworkProfile,
    NoiseProfile, PersonaProfile, Platform, UserAgentProfile,
};
