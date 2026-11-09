//! A design a Designer showed in the Lead's thread (agent designer.ts), as the desk draws and saves it.

/// Whether `bytes` start as a PNG does.
pub fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a])
}

/// An image's type by its first bytes: a PNG, or a JPEG (the site check's screenshots on a website card); None for anything else.
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if is_png(bytes) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else {
        None
    }
}

/// The name a saved design gets: the agent's, kept to letters, digits, `-`, `_` and `.`, ending in
/// `.png`; the `n`th try at a free name adds ` (n)` before the extension.
pub fn file_name(name: &str, n: u32) -> String {
    let stem = name.strip_suffix(".png").unwrap_or(name);
    let mut safe: String = stem.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' }).collect();
    safe = safe.trim_matches(|c| c == '.' || c == '-').to_string();
    if safe.is_empty() {
        safe = "design".to_string();
    }
    if n > 1 { format!("{safe} ({n}).png") } else { format!("{safe}.png") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_by_its_signature() {
        assert!(is_png(b"\x89PNG\r\n\x1a\nrest"));
        assert!(!is_png(b"{\"error\":\"no\"}"));
        assert!(!is_png(b""));
    }

    #[test]
    fn an_image_type_by_its_signature() {
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(image_type(b"\xff\xd8\xff\xe0rest"), Some("image/jpeg"));
        assert_eq!(image_type(b"<html>"), None);
    }

    #[test]
    fn a_saved_name_is_plain_and_never_a_path() {
        assert_eq!(file_name("fall-sale-1.png", 1), "fall-sale-1.png");
        assert_eq!(file_name("fall-sale-1.png", 2), "fall-sale-1 (2).png");
        assert_eq!(file_name("../../etc/passwd", 1), "etc-passwd.png");
        assert_eq!(file_name("..", 1), "design.png");
        assert_eq!(file_name("Fall sale!", 1), "Fall-sale.png");
    }
}
