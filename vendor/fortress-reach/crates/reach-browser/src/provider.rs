use reach_core::error::{ReachError, Result};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Environment variable that points at a browser executable.
pub const BROWSER_PATH_ENV: &str = "REACH_BROWSER_PATH";

/// The prefix of the extended switch vocabulary.
const PERSONA_SWITCH_PREFIX: &[u8] = b"uxr-";

/// A resolved browser to drive.
///
/// The project never depends on a particular browser build. The provider
/// resolves whatever Chromium based browser is available on the host, and
/// reports whether that build understands the optional persona switches, so
/// the caller can use the richer path when it is available and fall back to
/// the protocol level path when it is not.
#[derive(Clone, Debug)]
pub struct BrowserProvider {
    pub(crate) executable: PathBuf,
    pub(crate) label: String,
    pub(crate) supports_persona_switches: bool,
    /// The switch names the build actually knows.
    pub(crate) known_switches: HashSet<String>,
}

impl BrowserProvider {
    /// Resolves the browser to use.
    ///
    /// The order is deliberate: an explicit configuration wins, then the
    /// environment, then the browsers installed on the host.
    pub fn resolve(configured: Option<&str>) -> Result<Self> {
        if let Some(path) = configured {
            let path = PathBuf::from(path);
            if path.exists() {
                return Self::from_path(path);
            }
            return Err(ReachError::BrowserError(format!(
                "The configured browser path does not exist: {}",
                path.display()
            )));
        }

        if let Ok(path) = std::env::var(BROWSER_PATH_ENV) {
            let path = PathBuf::from(path);
            if path.exists() {
                return Self::from_path(path);
            }
            return Err(ReachError::BrowserError(format!(
                "{} points at a path that does not exist: {}",
                BROWSER_PATH_ENV,
                path.display()
            )));
        }

        for candidate in Self::system_candidates() {
            if candidate.exists() {
                return Self::from_path(candidate);
            }
        }

        Err(ReachError::BrowserError(format!(
            "No Chromium based browser was found. Install Chrome, Edge, Brave or Chromium, \
             or point {} at an executable.",
            BROWSER_PATH_ENV
        )))
    }

    /// Builds a provider for an explicit executable.
    pub fn from_path(executable: PathBuf) -> Result<Self> {
        let label = executable
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "browser".to_string());

        let known_switches = Self::detect_switches(&executable);
        let supports_persona_switches = !known_switches.is_empty();

        Ok(Self {
            executable,
            label,
            supports_persona_switches,
            known_switches,
        })
    }

    /// The executable to launch.
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    /// A short name for logs and for the user interface.
    pub fn label(&self) -> &str {
        &self.label
    }

    /// Whether the build understands the optional persona switches.
    pub fn supports_persona_switches(&self) -> bool {
        self.supports_persona_switches
    }

    /// Whether the build knows a switch by name.
    ///
    /// The check is by name, not by family, because the vocabulary grew over
    /// time: a build can know one switch and not another. Sending a switch
    /// that the build does not know leaves the surface at the host value,
    /// which is exactly what the project is trying to avoid.
    pub fn knows_switch(&self, name: &str) -> bool {
        self.known_switches.contains(name)
    }

    /// The switch names the build knows.
    pub fn known_switches(&self) -> &HashSet<String> {
        &self.known_switches
    }

    /// The browsers that are looked for on the host, in order of preference.
    pub fn system_candidates() -> Vec<PathBuf> {
        let mut candidates = Vec::new();

        // 1. Check relative to current executable (portable bundle distribution)
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                candidates.push(dir.join("engine").join("chrome.exe"));
                candidates.push(dir.join("tilion-fortress").join("chrome.exe"));
                candidates.push(dir.join("chrome.exe"));
            }
        }

        #[cfg(target_os = "windows")]
        {
            // 2. Check user-level AppData cache
            if let Ok(appdata) = std::env::var("LOCALAPPDATA") {
                candidates.push(PathBuf::from(appdata).join("fortress-reach").join("engine").join("chrome.exe"));
            }
            if let Ok(userprofile) = std::env::var("USERPROFILE") {
                candidates.push(PathBuf::from(userprofile).join(".cache").join("tilion-fortress").join("chrome.exe"));
            }

            const PATHS: &[&str] = &[
                r"E:\fortress-v153-win-x64\chrome.exe",
                r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
                r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
                r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
                r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
                r"C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe",
            ];
            for path in PATHS {
                candidates.push(PathBuf::from(path));
            }
        }

        #[cfg(target_os = "macos")]
        {
            const PATHS: &[&str] = &[
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                "/Applications/Chromium.app/Contents/MacOS/Chromium",
            ];
            for path in PATHS {
                candidates.push(PathBuf::from(path));
            }
        }

        #[cfg(target_os = "linux")]
        {
            const NAMES: &[&str] = &[
                "google-chrome",
                "google-chrome-stable",
                "chromium",
                "chromium-browser",
                "microsoft-edge",
                "brave-browser",
            ];
            for name in NAMES {
                if let Some(path) = which(name) {
                    candidates.push(path);
                }
            }
        }

        candidates
    }

    /// Looks for the extended switch vocabulary in the executable and in the
    /// library next to it.
    ///
    /// A byte scan is used rather than a launch probe because it is
    /// deterministic, needs no extra process and cannot be influenced by the
    /// state of the machine. Every switch name the build knows is collected,
    /// so that a name the build does not know is never sent to it.
    fn detect_switches(executable: &Path) -> HashSet<String> {
        let mut switches = HashSet::new();

        collect_switches(executable, &mut switches);

        if let Some(parent) = executable.parent() {
            for name in ["chrome.dll", "chrome_elf.dll", "libEGL.dll", "msedge.dll"] {
                let sibling = parent.join(name);
                if sibling.exists() {
                    collect_switches(&sibling, &mut switches);
                }
            }
        }

        switches
    }
}

/// Collects the switch names in a file.
fn collect_switches(path: &Path, switches: &mut HashSet<String>) {
    use std::io::Read;

    let Ok(mut file) = std::fs::File::open(path) else {
        return;
    };

    let mut buffer = vec![0u8; 4 * 1024 * 1024];
    let mut carry: Vec<u8> = Vec::with_capacity(64);
    let mut read_total = 0usize;

    loop {
        let read = match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => return,
        };

        let mut window = std::mem::take(&mut carry);
        window.extend_from_slice(&buffer[..read]);

        let mut index = 0usize;
        while let Some(found) = window[index..]
            .windows(PERSONA_SWITCH_PREFIX.len())
            .position(|w| w == PERSONA_SWITCH_PREFIX)
        {
            let start = index + found;
            let mut end = start + PERSONA_SWITCH_PREFIX.len();
            while end < window.len() {
                let byte = window[end];
                if byte.is_ascii_alphanumeric() || byte == b'-' {
                    end += 1;
                } else {
                    break;
                }
            }
            if end > start + PERSONA_SWITCH_PREFIX.len() {
                let name = String::from_utf8_lossy(&window[start..end]).to_string();
                switches.insert(name);
            }
            index = end.max(start + 1);
        }

        let keep = 64.min(window.len());
        carry = window[window.len() - keep..].to_vec();
        read_total += read;

        if read_total > 700 * 1024 * 1024 {
            break;
        }
    }
}

/// Resolves a program on the search path.
#[cfg(target_os = "linux")]
fn which(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_resolve_reports_a_missing_configured_path() {
        let result = BrowserProvider::resolve(Some("Z:\\definitely\\not\\here.exe"));
        assert!(result.is_err());
    }

    #[test]
    fn test_system_candidates_are_absolute() {
        for candidate in BrowserProvider::system_candidates() {
            assert!(candidate.is_absolute(), "{:?} is not absolute", candidate);
        }
    }

    #[test]
    fn test_contains_bytes_finds_the_marker() {
        let dir = std::env::temp_dir().join("reach_provider_test");
        std::fs::create_dir_all(&dir).expect("temp dir");
        let file = dir.join("blob.bin");
        let mut data = vec![0u8; 4096];
        data.extend_from_slice(b"uxr-hw-concurrency");
        data.extend(vec![0u8; 4096]);
        std::fs::write(&file, &data).expect("write");

        let mut switches = HashSet::new();
        collect_switches(&file, &mut switches);
        assert!(switches.contains("uxr-hw-concurrency"));
        assert!(!switches.contains("uxr-nothing-here"));

        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn test_collecting_switches_from_a_missing_file_is_harmless() {
        let mut switches = HashSet::new();
        collect_switches(Path::new("Z:\\definitely\\not\\here.bin"), &mut switches);
        assert!(switches.is_empty());
    }

    #[test]
    fn test_a_switch_is_only_sent_when_the_build_knows_it() {
        let provider = BrowserProvider {
            executable: PathBuf::from("chrome.exe"),
            label: "chrome.exe".to_string(),
            supports_persona_switches: true,
            known_switches: ["uxr-hw-concurrency".to_string()].into_iter().collect(),
        };
        assert!(provider.knows_switch("uxr-hw-concurrency"));
        assert!(!provider.knows_switch("uxr-timezone"));
    }
}
