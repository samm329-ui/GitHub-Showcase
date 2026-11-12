//! Static assets used to fill the observable device surfaces.

/// Keyboard layout identifier to `code -> key` table.
pub fn keyboard_layout(id: &str) -> Vec<(String, String)> {
    let mut map: Vec<(String, String)> = US_LAYOUT
        .iter()
        .map(|(code, key)| (code.to_string(), key.to_string()))
        .collect();

    let overrides: &[(&str, &str)] = match id {
        "de" => &[
            ("KeyY", "z"),
            ("KeyZ", "y"),
            ("Semicolon", "ö"),
            ("Quote", "ä"),
            ("BracketLeft", "ü"),
            ("Backslash", "ß"),
        ],
        "fr" => &[
            ("KeyA", "q"),
            ("KeyQ", "a"),
            ("KeyZ", "w"),
            ("KeyW", "z"),
            ("KeyM", ";"),
            ("Semicolon", "m"),
            ("Quote", "2"),
        ],
        "uk" => &[
            ("Quote", "2"),
            ("Backslash", "#"),
            ("Semicolon", ";"),
        ],
        "es" => &[
            ("Semicolon", "ñ"),
            ("Quote", "'"),
            ("Backslash", "`"),
        ],
        "jp" => &[("Quote", "7"), ("Backslash", "¥"), ("Semicolon", ";")],
        _ => &[],
    };

    for (code, key) in overrides {
        if let Some(entry) = map.iter_mut().find(|(c, _)| c == code) {
            entry.1 = (*key).to_string();
        }
    }

    map
}

/// Base US layout.
const US_LAYOUT: &[(&str, &str)] = &[
    ("Backquote", "`"),
    ("Digit1", "1"),
    ("Digit2", "2"),
    ("Digit3", "3"),
    ("Digit4", "4"),
    ("Digit5", "5"),
    ("Digit6", "6"),
    ("Digit7", "7"),
    ("Digit8", "8"),
    ("Digit9", "9"),
    ("Digit0", "0"),
    ("Minus", "-"),
    ("Equal", "="),
    ("KeyQ", "q"),
    ("KeyW", "w"),
    ("KeyE", "e"),
    ("KeyR", "r"),
    ("KeyT", "t"),
    ("KeyY", "y"),
    ("KeyU", "u"),
    ("KeyI", "i"),
    ("KeyO", "o"),
    ("KeyP", "p"),
    ("BracketLeft", "["),
    ("BracketRight", "]"),
    ("Backslash", "\\"),
    ("KeyA", "a"),
    ("KeyS", "s"),
    ("KeyD", "d"),
    ("KeyF", "f"),
    ("KeyG", "g"),
    ("KeyH", "h"),
    ("KeyJ", "j"),
    ("KeyK", "k"),
    ("KeyL", "l"),
    ("Semicolon", ";"),
    ("Quote", "'"),
    ("KeyZ", "z"),
    ("KeyX", "x"),
    ("KeyC", "c"),
    ("KeyV", "v"),
    ("KeyB", "b"),
    ("KeyN", "n"),
    ("KeyM", "m"),
    ("Comma", ","),
    ("Period", "."),
    ("Slash", "/"),
];

/// Font families a desktop browser reports through font enumeration.
pub const FONT_FAMILIES: &[&str] = &[
    "Arial",
    "Arial Black",
    "Arial Narrow",
    "Arial Rounded MT Bold",
    "Bahnschrift",
    "Calibri",
    "Cambria",
    "Cambria Math",
    "Candara",
    "Comic Sans MS",
    "Consolas",
    "Constantia",
    "Corbel",
    "Courier New",
    "Ebrima",
    "Franklin Gothic Medium",
    "Gabriola",
    "Gadugi",
    "Georgia",
    "HoloLens MDL2 Assets",
    "Impact",
    "Ink Free",
    "Javanese Text",
    "Leelawadee UI",
    "Lucida Console",
    "Lucida Sans Unicode",
    "Malgun Gothic",
    "Marlett",
    "Microsoft Himalaya",
    "Microsoft JhengHei",
    "Microsoft New Tai Lue",
    "Microsoft PhagsPa",
    "Microsoft Sans Serif",
    "Microsoft Tai Le",
    "Microsoft YaHei",
    "Microsoft Yi Baiti",
    "MingLiU-ExtB",
    "Mongolian Baiti",
    "MS Gothic",
    "MV Boli",
    "Myanmar Text",
    "Nirmala UI",
    "Palatino Linotype",
    "Segoe MDL2 Assets",
    "Segoe Print",
    "Segoe Script",
    "Segoe UI",
    "Segoe UI Emoji",
    "Segoe UI Historic",
    "Segoe UI Symbol",
    "SimSun",
    "Sitka",
    "Sylfaen",
    "Symbol",
    "Tahoma",
    "Times New Roman",
    "Trebuchet MS",
    "Verdana",
    "Webdings",
    "Wingdings",
    "Yu Gothic",
    "Yu Gothic UI",
];

/// Speech synthesis voices a desktop browser reports.
pub fn voices_for(is_macos: bool) -> Vec<String> {
    if is_macos {
        vec![
            "Alex".to_string(),
            "Alice".to_string(),
            "Daniel".to_string(),
            "Fred".to_string(),
            "Karen".to_string(),
            "Moira".to_string(),
            "Samantha".to_string(),
            "Tessa".to_string(),
            "Victoria".to_string(),
        ]
    } else {
        vec![
            "Microsoft David Desktop - English (United States)".to_string(),
            "Microsoft Mark Desktop - English (United States)".to_string(),
            "Microsoft Zira Desktop - English (United States)".to_string(),
        ]
    }
}

/// Media device kinds reported by `enumerateDevices()`.
pub fn media_devices_for(has_camera: bool) -> Vec<String> {
    let mut devices = vec![
        "audioinput".to_string(),
        "audiooutput".to_string(),
    ];
    if has_camera {
        devices.insert(1, "videoinput".to_string());
    }
    devices
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_us_layout_is_complete() {
        let map = keyboard_layout("us");
        assert!(map.len() >= 46);
        assert_eq!(map.iter().find(|(c, _)| c == "KeyA").unwrap().1, "a");
    }

    #[test]
    fn test_german_layout_swaps_yz() {
        let map = keyboard_layout("de");
        assert_eq!(map.iter().find(|(c, _)| c == "KeyY").unwrap().1, "z");
        assert_eq!(map.iter().find(|(c, _)| c == "KeyZ").unwrap().1, "y");
    }

    #[test]
    fn test_fonts_are_unique() {
        let mut sorted = FONT_FAMILIES.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), FONT_FAMILIES.len());
    }

    #[test]
    fn test_media_devices_ordering() {
        assert_eq!(media_devices_for(false)[0], "audioinput");
        assert_eq!(media_devices_for(true)[1], "videoinput");
    }
}
