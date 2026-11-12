pub mod actions;
pub mod cdp;
pub mod fingerprint;
pub mod launcher;
pub mod provider;
pub mod stealth;

pub use actions::BrowserController;
pub use cdp::{CdpClient, CdpEvent};
pub use fingerprint::{build_plan, FingerprintPlan};
pub use launcher::BrowserLauncher;
pub use provider::BrowserProvider;
pub use stealth::{detect_captcha, detect_waf};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_browser_exports() {
        let controller = BrowserController::new("127.0.0.1", 9222);
        assert_eq!(controller.launcher().port(), 9222);
    }
}
