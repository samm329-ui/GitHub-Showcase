use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UserProfile {
    pub name: String,
    pub email: String,
    pub phone: String,
    pub slug: String,
    pub permanent_domain: String,
    pub cloudflare_token: String,
    pub is_registered: bool,
    pub created_at: String,
}

impl UserProfile {
    pub fn get_profile_path() -> PathBuf {
        if let Some(local_appdata) = std::env::var_os("LOCALAPPDATA") {
            let mut path = PathBuf::from(local_appdata);
            path.push("fortress-reach");
            let _ = std::fs::create_dir_all(&path);
            path.push("profile.json");
            path
        } else {
            PathBuf::from("user_profile.json")
        }
    }

    pub fn load() -> Self {
        let path = Self::get_profile_path();
        if path.exists() {
            if let Ok(content) = std::fs::read_to_string(&path) {
                if let Ok(profile) = serde_json::from_str::<UserProfile>(&content) {
                    if profile.is_registered && !profile.name.trim().is_empty() {
                        return profile;
                    }
                }
            }
        }
        Self::default()
    }

    pub fn save(&self) -> Result<(), std::io::Error> {
        let path = Self::get_profile_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| {
            std::io::Error::other(e.to_string())
        })?;
        std::fs::write(path, json)
    }

    /// Generates a deterministic slug and permanent domain based on name/email.
    pub fn generate_slug_and_domain(name: &str, email: &str) -> (String, String) {
        let clean_name: String = name
            .chars()
            .filter(|c| c.is_alphanumeric())
            .map(|c| c.to_ascii_lowercase())
            .take(12)
            .collect();
        let fallback_name = if clean_name.is_empty() {
            "node".to_string()
        } else {
            clean_name
        };

        // Simple hash of email for uniqueness
        let hash: u32 = email.bytes().fold(5381_u32, |acc, b| {
            acc.wrapping_mul(33).wrapping_add(b as u32)
        }) % 9999;

        let slug = format!("reach-{}-{:04}", fallback_name, hash);
        let permanent_domain = format!("{}.trycloudflare.com", slug);
        (slug, permanent_domain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_slug_and_domain_generation() {
        let (slug, domain) = UserProfile::generate_slug_and_domain("Alex Vance", "alex@example.com");
        assert!(slug.starts_with("reach-alexvance-"));
        assert!(domain.ends_with(".trycloudflare.com"));
    }

    #[test]
    fn test_profile_serialization() {
        let profile = UserProfile {
            name: "John Doe".to_string(),
            email: "john@doe.com".to_string(),
            phone: "+123456789".to_string(),
            slug: "reach-johndoe-1234".to_string(),
            permanent_domain: "reach-johndoe-1234.trycloudflare.com".to_string(),
            cloudflare_token: "".to_string(),
            is_registered: true,
            created_at: "22:00:00".to_string(),
        };

        let json = serde_json::to_string(&profile).expect("serialize");
        let deserialized: UserProfile = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(profile.name, deserialized.name);
        assert_eq!(profile.permanent_domain, deserialized.permanent_domain);
        assert!(deserialized.is_registered);
    }
}

