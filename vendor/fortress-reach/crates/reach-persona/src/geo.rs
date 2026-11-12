//! Country anchored locale data.
//!
//! Timezone, `Accept-Language` and keyboard layout travel together: a visitor
//! whose browser claims one country but whose timezone and language point at
//! another is trivially classified. The table below is compiled from the
//! public IANA time zone database and the CLDR language/territory mappings.

/// A country, with the surfaces that must agree with it.
#[derive(Clone, Copy, Debug)]
pub struct CountryProfile {
    /// ISO 3166-1 alpha-2 code.
    pub code: &'static str,
    /// IANA timezone.
    pub timezone: &'static str,
    /// `Accept-Language` / `navigator.languages` value.
    pub accept_language: &'static str,
    /// Keyboard layout identifier.
    pub keyboard: &'static str,
}

macro_rules! countries {
    ($($code:literal => ($tz:literal, $lang:literal, $kb:literal)),* $(,)?) => {
        pub const COUNTRIES: &[CountryProfile] = &[
            $(CountryProfile {
                code: $code,
                timezone: $tz,
                accept_language: $lang,
                keyboard: $kb,
            }),*
        ];
    };
}

countries! {
    "US" => ("America/New_York", "en-US,en;q=0.9", "us"),
    "CA" => ("America/Toronto", "en-CA,en;q=0.9", "us"),
    "GB" => ("Europe/London", "en-GB,en;q=0.9", "uk"),
    "IE" => ("Europe/Dublin", "en-IE,en;q=0.9", "uk"),
    "AU" => ("Australia/Sydney", "en-AU,en;q=0.9", "us"),
    "NZ" => ("Pacific/Auckland", "en-NZ,en;q=0.9", "us"),
    "DE" => ("Europe/Berlin", "de-DE,de;q=0.9,en;q=0.8", "de"),
    "AT" => ("Europe/Vienna", "de-AT,de;q=0.9,en;q=0.8", "de"),
    "CH" => ("Europe/Zurich", "de-CH,de;q=0.9,en;q=0.8", "de"),
    "FR" => ("Europe/Paris", "fr-FR,fr;q=0.9,en;q=0.8", "fr"),
    "BE" => ("Europe/Brussels", "fr-BE,fr;q=0.9,en;q=0.8", "fr"),
    "ES" => ("Europe/Madrid", "es-ES,es;q=0.9,en;q=0.8", "es"),
    "PT" => ("Europe/Lisbon", "pt-PT,pt;q=0.9,en;q=0.8", "es"),
    "IT" => ("Europe/Rome", "it-IT,it;q=0.9,en;q=0.8", "es"),
    "NL" => ("Europe/Amsterdam", "nl-NL,nl;q=0.9,en;q=0.8", "us"),
    "SE" => ("Europe/Stockholm", "sv-SE,sv;q=0.9,en;q=0.8", "se"),
    "NO" => ("Europe/Oslo", "nb-NO,nb;q=0.9,en;q=0.8", "no"),
    "DK" => ("Europe/Copenhagen", "da-DK,da;q=0.9,en;q=0.8", "no"),
    "FI" => ("Europe/Helsinki", "fi-FI,fi;q=0.9,en;q=0.8", "se"),
    "PL" => ("Europe/Warsaw", "pl-PL,pl;q=0.9,en;q=0.8", "pl"),
    "CZ" => ("Europe/Prague", "cs-CZ,cs;q=0.9,en;q=0.8", "pl"),
    "RO" => ("Europe/Bucharest", "ro-RO,ro;q=0.9,en;q=0.8", "pl"),
    "HU" => ("Europe/Budapest", "hu-HU,hu;q=0.9,en;q=0.8", "pl"),
    "GR" => ("Europe/Athens", "el-GR,el;q=0.9,en;q=0.8", "gr"),
    "TR" => ("Europe/Istanbul", "tr-TR,tr;q=0.9,en;q=0.8", "tr"),
    "UA" => ("Europe/Kyiv", "uk-UA,uk;q=0.9,en;q=0.8", "pl"),
    "RU" => ("Europe/Moscow", "ru-RU,ru;q=0.9,en;q=0.8", "ru"),
    "IL" => ("Asia/Jerusalem", "he-IL,he;q=0.9,en;q=0.8", "us"),
    "AE" => ("Asia/Dubai", "ar-AE,ar;q=0.9,en;q=0.8", "us"),
    "SA" => ("Asia/Riyadh", "ar-SA,ar;q=0.9,en;q=0.8", "us"),
    "ZA" => ("Africa/Johannesburg", "en-ZA,en;q=0.9", "uk"),
    "NG" => ("Africa/Lagos", "en-NG,en;q=0.9", "us"),
    "EG" => ("Africa/Cairo", "ar-EG,ar;q=0.9,en;q=0.8", "us"),
    "IN" => ("Asia/Kolkata", "en-IN,en;q=0.9,hi-IN;q=0.8", "in"),
    "PK" => ("Asia/Karachi", "en-PK,en;q=0.9,ur-PK;q=0.8", "in"),
    "BD" => ("Asia/Dhaka", "bn-BD,bn;q=0.9,en;q=0.8", "in"),
    "CN" => ("Asia/Shanghai", "zh-CN,zh;q=0.9,en;q=0.8", "us"),
    "HK" => ("Asia/Hong_Kong", "zh-HK,zh;q=0.9,en;q=0.8", "us"),
    "TW" => ("Asia/Taipei", "zh-TW,zh;q=0.9,en;q=0.8", "us"),
    "JP" => ("Asia/Tokyo", "ja-JP,ja;q=0.9,en;q=0.8", "jp"),
    "KR" => ("Asia/Seoul", "ko-KR,ko;q=0.9,en;q=0.8", "us"),
    "SG" => ("Asia/Singapore", "en-SG,en;q=0.9", "us"),
    "MY" => ("Asia/Kuala_Lumpur", "en-MY,en;q=0.9", "us"),
    "ID" => ("Asia/Jakarta", "id-ID,id;q=0.9,en;q=0.8", "us"),
    "TH" => ("Asia/Bangkok", "th-TH,th;q=0.9,en;q=0.8", "us"),
    "VN" => ("Asia/Ho_Chi_Minh", "vi-VN,vi;q=0.9,en;q=0.8", "us"),
    "PH" => ("Asia/Manila", "en-PH,en;q=0.9", "us"),
    "BR" => ("America/Sao_Paulo", "pt-BR,pt;q=0.9,en;q=0.8", "es"),
    "MX" => ("America/Mexico_City", "es-MX,es;q=0.9,en;q=0.8", "es"),
    "AR" => ("America/Argentina/Buenos_Aires", "es-AR,es;q=0.9,en;q=0.8", "es"),
    "CL" => ("America/Santiago", "es-CL,es;q=0.9,en;q=0.8", "es"),
    "CO" => ("America/Bogota", "es-CO,es;q=0.9,en;q=0.8", "es"),
    "PE" => ("America/Lima", "es-PE,es;q=0.9,en;q=0.8", "es"),
}

/// Looks up a country by ISO code, falling back to the United States.
pub fn country(code: &str) -> &'static CountryProfile {
    let upper = code.trim().to_ascii_uppercase();
    COUNTRIES
        .iter()
        .find(|c| c.code == upper)
        .unwrap_or(&COUNTRIES[0])
}

/// Whether the country is plausibly a macOS market.
///
/// Used to keep the operating system and the locale cluster in agreement.
pub fn prefers_macos(code: &str) -> bool {
    matches!(code.trim().to_ascii_uppercase().as_str(), "JP" | "NZ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_country_lookup_is_case_insensitive() {
        assert_eq!(country("de").code, "DE");
        assert_eq!(country(" US ").code, "US");
    }

    #[test]
    fn test_unknown_country_falls_back() {
        assert_eq!(country("ZZ").code, "US");
    }

    #[test]
    fn test_country_entries_are_well_formed() {
        for c in COUNTRIES {
            assert_eq!(c.code.len(), 2, "bad code {}", c.code);
            assert!(c.timezone.contains('/'), "bad tz {}", c.timezone);
            assert!(c.accept_language.contains(','));
            assert!(!c.keyboard.is_empty());
        }
    }
}
