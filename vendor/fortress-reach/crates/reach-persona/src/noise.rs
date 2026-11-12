//! Noise derivation.
//!
//! Rendering noise has to be stable for a site within a session and different
//! for every session, otherwise it becomes a tracking vector of its own. The
//! scheme is: a per-launch secret is combined with the site host name to
//! produce a per-site seed.

use crate::prng::fnv1a64;

/// Derives the per-site noise seed from the session secret and the host name.
pub fn domain_seed(secret: u64, hostname: &str) -> u64 {
    let mut buf = Vec::with_capacity(hostname.len() + 8);
    buf.extend_from_slice(&secret.to_le_bytes());
    buf.extend_from_slice(hostname.to_ascii_lowercase().as_bytes());
    fnv1a64(&buf) | 1
}

/// Parses the hexadecimal session secret back into a number.
pub fn parse_secret(hex: &str) -> Option<u64> {
    u64::from_str_radix(hex.trim(), 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_domain_seed_is_stable() {
        assert_eq!(domain_seed(5, "example.com"), domain_seed(5, "example.com"));
    }

    #[test]
    fn test_domain_seed_differs_per_host() {
        assert_ne!(domain_seed(5, "a.com"), domain_seed(5, "b.com"));
    }

    #[test]
    fn test_domain_seed_is_case_insensitive() {
        assert_eq!(domain_seed(5, "Example.COM"), domain_seed(5, "example.com"));
    }

    #[test]
    fn test_secret_roundtrip() {
        let secret = 0x0123_4567_89AB_CDEF;
        let hex = format!("{:016x}", secret);
        assert_eq!(parse_secret(&hex), Some(secret));
    }
}
