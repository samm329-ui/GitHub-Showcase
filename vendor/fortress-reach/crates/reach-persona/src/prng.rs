//! Deterministic pseudo-random helpers.
//!
//! The persona generator must be reproducible: the same seed has to yield the
//! same machine on every launch, so that a session can be resumed and so that
//! a profile can be pinned for testing. At the same time, noise surfaces
//! (canvas, audio) must never be reproducible across launches, which is why
//! noise seeds are derived from a separate per-session secret.

/// SplitMix64 — small, fast, and stable across platforms.
#[derive(Clone, Debug)]
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    pub fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    pub fn next_u32(&mut self) -> u32 {
        (self.next_u64() >> 32) as u32
    }

    /// Uniform float in `[0, 1)`.
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform integer in `[0, len)`. Returns 0 for an empty slice.
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        if items.is_empty() {
            panic!("pick() called with an empty slice");
        }
        let idx = (self.next_u64() % items.len() as u64) as usize;
        &items[idx]
    }

    /// Uniform integer in `[low, high]`.
    pub fn range(&mut self, low: u64, high: u64) -> u64 {
        if high <= low {
            return low;
        }
        low + (self.next_u64() % (high - low + 1))
    }
}

/// FNV-1a 64-bit hash. Used to derive independent per-field streams from one
/// seed so that changing one field does not shift every other field.
pub fn fnv1a64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    hash
}

/// Derives an independent stream for a named field of a seed.
pub fn field_stream(seed: u64, field: &str) -> SplitMix64 {
    let mut buf = Vec::with_capacity(field.len() + 8);
    buf.extend_from_slice(&seed.to_le_bytes());
    buf.extend_from_slice(field.as_bytes());
    SplitMix64::new(fnv1a64(&buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_splitmix_is_deterministic() {
        let a: Vec<u64> = (0..5).map(|_| SplitMix64::new(42).next_u64()).collect();
        let b: Vec<u64> = (0..5).map(|_| SplitMix64::new(42).next_u64()).collect();
        assert_eq!(a, b);
    }

    #[test]
    fn test_field_streams_are_independent() {
        let a = field_stream(7, "screen").next_u64();
        let b = field_stream(7, "gpu").next_u64();
        assert_ne!(a, b);
    }

    #[test]
    fn test_field_stream_is_stable() {
        assert_eq!(
            field_stream(7, "screen").next_u64(),
            field_stream(7, "screen").next_u64()
        );
    }

    #[test]
    fn test_range_bounds() {
        let mut rng = SplitMix64::new(1);
        for _ in 0..100 {
            let v = rng.range(4, 8);
            assert!((4..=8).contains(&v));
        }
    }
}
