//! Graphics device corpus.
//!
//! A browser that advertises one GPU through WebGL and a different one
//! through WebGPU is easier to fingerprint than a browser that advertises
//! nothing unusual at all. The corpus below keeps both channels on the same
//! device, and keeps the operating system of the session consistent with the
//! rendering backend of that device.

/// Graphics vendor family.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GpuFamily {
    Nvidia,
    Amd,
    Intel,
    Apple,
}

/// One coherent graphics identity.
#[derive(Clone, Copy, Debug)]
pub struct GpuModel {
    pub family: GpuFamily,
    /// `UNMASKED_VENDOR_WEBGL`.
    pub webgl_vendor: &'static str,
    /// `UNMASKED_RENDERER_WEBGL`.
    pub webgl_renderer: &'static str,
    /// `navigator.gpu` adapter vendor.
    pub webgpu_vendor: &'static str,
    /// `navigator.gpu` adapter architecture.
    pub webgpu_architecture: &'static str,
    /// `GL_MAX_TEXTURE_SIZE` and friends.
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
    /// Whether this device only exists on macOS.
    pub apple_only: bool,
    /// Whether this device only exists on Windows.
    pub windows_only: bool,
}

const NVIDIA_VENDOR: &str = "Google Inc. (NVIDIA Corporation)";
const AMD_VENDOR: &str = "Google Inc. (AMD)";
const INTEL_VENDOR: &str = "Google Inc. (Intel)";
const APPLE_VENDOR: &str = "Google Inc. (Apple Inc.)";

/// The device corpus.
pub const GPU_MODELS: &[GpuModel] = &[
    GpuModel {
        family: GpuFamily::Nvidia,
        webgl_vendor: NVIDIA_VENDOR,
        webgl_renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        webgpu_vendor: "nvidia",
        webgpu_architecture: "ampere",
        max_texture_size: 16384,
        max_viewport_dims: [16384, 16384],
        max_renderbuffer_size: 16384,
        max_cube_map_texture_size: 16384,
        extension_count: 31,
        precision_high_float: (127, 127, 23),
        apple_only: false,
        windows_only: false,
    },
    GpuModel {
        family: GpuFamily::Nvidia,
        webgl_vendor: NVIDIA_VENDOR,
        webgl_renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        webgpu_vendor: "nvidia",
        webgpu_architecture: "ada",
        max_texture_size: 16384,
        max_viewport_dims: [16384, 16384],
        max_renderbuffer_size: 16384,
        max_cube_map_texture_size: 16384,
        extension_count: 32,
        precision_high_float: (127, 127, 23),
        apple_only: false,
        windows_only: false,
    },
    GpuModel {
        family: GpuFamily::Nvidia,
        webgl_vendor: NVIDIA_VENDOR,
        webgl_renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        webgpu_vendor: "nvidia",
        webgpu_architecture: "turing",
        max_texture_size: 16384,
        max_viewport_dims: [16384, 16384],
        max_renderbuffer_size: 16384,
        max_cube_map_texture_size: 16384,
        extension_count: 29,
        precision_high_float: (127, 127, 23),
        apple_only: false,
        windows_only: false,
    },
    GpuModel {
        family: GpuFamily::Nvidia,
        webgl_vendor: NVIDIA_VENDOR,
        webgl_renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)",
        webgpu_vendor: "nvidia",
        webgpu_architecture: "ada",
        max_texture_size: 32768,
        max_viewport_dims: [32768, 32768],
        max_renderbuffer_size: 32768,
        max_cube_map_texture_size: 32768,
        extension_count: 33,
        precision_high_float: (127, 127, 23),
        apple_only: false,
        windows_only: false,
    },
    GpuModel {
        family: GpuFamily::Amd,
        webgl_vendor: AMD_VENDOR,
        webgl_renderer: "ANGLE (AMD, AMD Radeon RX 6600 (0x73BF0000) Direct3D11 vs_5_0 ps_5_0, D3D11)",
        webgpu_vendor: "amd",
        webgpu_architecture: "rdna-2",
        max_texture_size: 16384,
        max_viewport_dims: [16384, 16384],
        max_renderbuffer_size: 16384,
        max_cube_map_texture_size: 16384,
        extension_count: 30,
        precision_high_float: (127, 127, 23),
        apple_only: false,
        windows_only: false,
    },
    GpuModel {
        family: GpuFamily::Amd,
        webgl_vendor: AMD_VENDOR,
        webgl_renderer: "ANGLE (AMD, AMD Radeon RX 7900 XTX (0x744C0000) Direct3D11 vs_5_0 ps_5_0, D3D11)",
        webgpu_vendor: "amd",
        webgpu_architecture: "rdna-3",
        max_texture_size: 32768,
        max_viewport_dims: [32768, 32768],
        max_renderbuffer_size: 32768,
        max_cube_map_texture_size: 32768,
        extension_count: 33,
        precision_high_float: (127, 127, 23),
        apple_only: false,
        windows_only: false,
    },
    GpuModel {
        family: GpuFamily::Amd,
        webgl_vendor: AMD_VENDOR,
        webgl_renderer: "ANGLE (AMD, AMD Radeon Graphics (0x00001602) Direct3D11 vs_5_0 ps_5_0, D3D11)",
        webgpu_vendor: "amd",
        webgpu_architecture: "rdna-2",
        max_texture_size: 8192,
        max_viewport_dims: [8192, 8192],
        max_renderbuffer_size: 8192,
        max_cube_map_texture_size: 8192,
        extension_count: 27,
        precision_high_float: (127, 127, 23),
        apple_only: false,
        windows_only: false,
    },
    GpuModel {
        family: GpuFamily::Intel,
        webgl_vendor: INTEL_VENDOR,
        webgl_renderer:
            "ANGLE (Intel, Intel(R) UHD Graphics 770 (0x4680) Direct3D11 vs_5_0 ps_5_0, D3D11)",
        webgpu_vendor: "intel",
        webgpu_architecture: "gen-12lp",
        max_texture_size: 16384,
        max_viewport_dims: [16384, 16384],
        max_renderbuffer_size: 16384,
        max_cube_map_texture_size: 16384,
        extension_count: 28,
        precision_high_float: (127, 127, 23),
        apple_only: false,
        windows_only: false,
    },
    GpuModel {
        family: GpuFamily::Intel,
        webgl_vendor: INTEL_VENDOR,
        webgl_renderer:
            "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x9A49) Direct3D11 vs_5_0 ps_5_0, D3D11)",
        webgpu_vendor: "intel",
        webgpu_architecture: "tigerlake",
        max_texture_size: 16384,
        max_viewport_dims: [16384, 16384],
        max_renderbuffer_size: 16384,
        max_cube_map_texture_size: 16384,
        extension_count: 29,
        precision_high_float: (127, 127, 23),
        apple_only: false,
        windows_only: false,
    },
    GpuModel {
        family: GpuFamily::Apple,
        webgl_vendor: APPLE_VENDOR,
        webgl_renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
        webgpu_vendor: "apple",
        webgpu_architecture: "",
        max_texture_size: 16384,
        max_viewport_dims: [16384, 16384],
        max_renderbuffer_size: 16384,
        max_cube_map_texture_size: 16384,
        extension_count: 30,
        precision_high_float: (127, 127, 23),
        apple_only: true,
        windows_only: false,
    },
    GpuModel {
        family: GpuFamily::Apple,
        webgl_vendor: APPLE_VENDOR,
        webgl_renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
        webgpu_vendor: "apple",
        webgpu_architecture: "",
        max_texture_size: 16384,
        max_viewport_dims: [16384, 16384],
        max_renderbuffer_size: 16384,
        max_cube_map_texture_size: 16384,
        extension_count: 30,
        precision_high_float: (127, 127, 23),
        apple_only: true,
        windows_only: false,
    },
    GpuModel {
        family: GpuFamily::Apple,
        webgl_vendor: APPLE_VENDOR,
        webgl_renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro, Unspecified Version)",
        webgpu_vendor: "apple",
        webgpu_architecture: "",
        max_texture_size: 16384,
        max_viewport_dims: [16384, 16384],
        max_renderbuffer_size: 16384,
        max_cube_map_texture_size: 16384,
        extension_count: 31,
        precision_high_float: (127, 127, 23),
        apple_only: true,
        windows_only: false,
    },
];

/// Returns the device corpus filtered for the given platform.
///
/// A macOS session can only present a Metal based device, and a Windows
/// session can only present a Direct3D based one, so the two lists are
/// disjoint. Mixing them is one of the easiest ways to be classified.
pub fn models_for(is_macos: bool) -> Vec<&'static GpuModel> {
    GPU_MODELS
        .iter()
        .filter(|m| m.apple_only == is_macos)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_corpus_is_internally_consistent() {
        for m in GPU_MODELS {
            assert!(m.webgl_renderer.starts_with("ANGLE ("));
            assert!(m.webgl_vendor.starts_with("Google Inc. ("));
            assert!(m.max_texture_size >= 2048);
            assert!(m.max_viewport_dims[0] >= m.max_texture_size / 2);
            assert!(m.extension_count > 10);
        }
    }

    #[test]
    fn test_platform_filter_excludes_apple_on_windows() {
        let win = models_for(false);
        assert!(win.iter().all(|m| !m.apple_only));
        let mac = models_for(true);
        assert!(mac.iter().all(|m| !m.windows_only));
    }
}
