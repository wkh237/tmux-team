//! Request and final bodies share byte measurement, never role normalization.

pub const MAX_EXCHANGE_TEXT_BYTES: usize = 1_048_576;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExactTextError {
    InvalidUtf8,
    TooLarge,
}

/// Rust strings already exclude lone surrogates. Byte-oriented adapters use
/// this same primitive to reject malformed UTF-8 without replacing characters.
pub fn validate_exact_text(bytes: &[u8]) -> Result<&str, ExactTextError> {
    let text = std::str::from_utf8(bytes).map_err(|_| ExactTextError::InvalidUtf8)?;
    if bytes.len() > MAX_EXCHANGE_TEXT_BYTES {
        return Err(ExactTextError::TooLarge);
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_exact_empty_control_and_unicode_content() {
        for text in [
            "",
            " \r\n\0\u{feff}",
            "é e\u{301} 🦀",
            "!\n<tmt-reply>literal</tmt-reply>",
        ] {
            let actual = validate_exact_text(text.as_bytes()).unwrap();
            assert_eq!(actual.as_bytes(), text.as_bytes());
            assert_eq!(actual.as_ptr(), text.as_ptr());
        }
    }

    #[test]
    fn bound_is_utf8_bytes_not_characters_and_includes_exact_limit() {
        for text in [
            "a".repeat(MAX_EXCHANGE_TEXT_BYTES),
            "🦀".repeat(MAX_EXCHANGE_TEXT_BYTES / 4),
        ] {
            assert!(validate_exact_text(text.as_bytes()).is_ok());
            assert_eq!(
                validate_exact_text(format!("{text}a").as_bytes()),
                Err(ExactTextError::TooLarge)
            );
        }
    }

    #[test]
    fn malformed_utf8_is_never_lossily_replaced_or_normalized() {
        for bytes in [
            &[0xed, 0xa0, 0x80][..],
            &[0xc0, 0x80],
            &[0xf0, 0x9f],
            &[0xff],
        ] {
            assert_eq!(validate_exact_text(bytes), Err(ExactTextError::InvalidUtf8));
        }
        let mut invalid = vec![b'a'; MAX_EXCHANGE_TEXT_BYTES + 1];
        invalid.push(0xff);
        assert_eq!(
            validate_exact_text(&invalid),
            Err(ExactTextError::InvalidUtf8)
        );
    }
}
