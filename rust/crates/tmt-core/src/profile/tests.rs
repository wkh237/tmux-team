use super::*;
use crate::exact_text::{MAX_EXCHANGE_TEXT_BYTES, validate_exact_text};

#[test]
fn normalizes_profile_text_without_normalizing_exact_exchange_text() {
    let profile = normalize_content("\u{feff}\u{feff}  first\r\nsecond\rthird\n").unwrap();
    assert_eq!(profile.as_str(), "\u{feff}  first\nsecond\nthird\n");

    let exact = "\u{feff}\u{feff}  first\r\nsecond\rthird\n\0";
    assert_eq!(validate_exact_text(exact.as_bytes()).unwrap(), exact);
    assert_ne!(profile.as_str(), exact);
}

#[test]
fn uses_ecmascript_whitespace_for_empty_profiles() {
    let whitespace = [
        '\u{9}', '\u{a}', '\u{d}', ' ', '\u{a0}', '\u{1680}', '\u{2000}', '\u{2001}', '\u{2002}',
        '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}', '\u{2008}', '\u{2009}',
        '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}',
    ];
    for character in whitespace {
        assert_eq!(
            normalize_content(&character.to_string()),
            Err(ContentError::Empty),
            "character U+{:04X}",
            character as u32
        );
    }
    // U+0085 is not ECMAScript whitespace and is retained as meaningful text.
    assert_eq!(normalize_content("\u{85}").unwrap().as_str(), "\u{85}");
}

#[test]
fn rejects_controls_but_allows_tab_and_line_feed() {
    assert_eq!(
        normalize_content("tab\tline\n").unwrap().as_str(),
        "tab\tline\n"
    );
    for code in (0..0x20)
        .filter(|code| *code != 0x09 && *code != 0x0a && *code != 0x0d)
        .chain([0x7f])
    {
        let value = format!("before{}after", char::from_u32(code).unwrap());
        assert_eq!(
            normalize_content(&value),
            Err(ContentError::Control),
            "U+{code:04X}"
        );
    }
}

#[test]
fn enforces_utf8_byte_limit_before_normalization() {
    let exact = "a".repeat(MAX_PROFILE_BYTES);
    assert_eq!(normalize_content(&exact).unwrap().as_str(), exact);
    assert_eq!(
        normalize_content(&format!("{exact}a")),
        Err(ContentError::TooLarge)
    );

    let multibyte = "😀".repeat(MAX_PROFILE_BYTES / 4);
    assert_eq!(multibyte.len(), MAX_PROFILE_BYTES);
    assert_eq!(normalize_content(&multibyte).unwrap().as_str(), multibyte);
    assert_eq!(
        normalize_content(&format!("{multibyte}😀")),
        Err(ContentError::TooLarge)
    );
    let crlf_shrinks_to_limit = format!("{}\r\n", "a".repeat(MAX_PROFILE_BYTES - 1));
    assert_eq!(crlf_shrinks_to_limit.len(), MAX_PROFILE_BYTES + 1);
    assert_eq!(
        normalize_content(&crlf_shrinks_to_limit),
        Err(ContentError::TooLarge)
    );
    let bom_shrinks_to_limit = format!("\u{feff}{}", "a".repeat(MAX_PROFILE_BYTES));
    assert!(bom_shrinks_to_limit.len() > MAX_PROFILE_BYTES);
    assert_eq!(
        normalize_content(&bom_shrinks_to_limit),
        Err(ContentError::TooLarge)
    );
    assert!(validate_exact_text(&"a".repeat(MAX_EXCHANGE_TEXT_BYTES).into_bytes()).is_ok());
}
