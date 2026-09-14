//! Narrow validation primitives shared by the two reviewed indexed-art contracts.

pub(crate) const KEY_LIMIT: usize = 32;
pub(crate) const LABEL_LIMIT: usize = 80;
pub(crate) const CREDIT_LIMIT: usize = 120;
pub(crate) const LICENSE_LIMIT: usize = 64;
pub(crate) const PALETTE_LIMIT: usize = 16;

pub(crate) fn valid_text(value: &str, max_bytes: usize) -> bool {
    !value.is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

pub(crate) fn valid_key(value: &str) -> bool {
    (1..=KEY_LIMIT).contains(&value.len())
        && value.bytes().enumerate().all(|(index, byte)| match byte {
            b'a'..=b'z' => true,
            b'0'..=b'9' | b'-' => index > 0,
            _ => false,
        })
}

pub(crate) fn valid_license(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= LICENSE_LIMIT
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".+-".contains(&byte))
}

pub(crate) fn valid_palette(palette: &[String]) -> bool {
    (1..=PALETTE_LIMIT).contains(&palette.len())
        && palette.first().map(String::as_str) == Some("#00000000")
        && palette.iter().skip(1).all(|value| {
            value.len() == 9
                && value.starts_with('#')
                && value[1..]
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                && value.ends_with("ff")
        })
}

pub(crate) fn validate_raster(
    pixels: &[String],
    palette_len: usize,
    expected_width: Option<usize>,
    expected_height: Option<usize>,
    max_side: usize,
    max_cells: usize,
) -> Option<usize> {
    if pixels.is_empty()
        || pixels.len() > max_side
        || expected_height.is_some_and(|value| value != pixels.len())
    {
        return None;
    }
    let width = pixels.first()?.len();
    if width == 0
        || width > max_side
        || expected_width.is_some_and(|value| value != width)
        || width.checked_mul(pixels.len())? > max_cells
    {
        return None;
    }
    pixels
        .iter()
        .all(|row| {
            row.len() == width
                && row.bytes().all(|byte| {
                    let index = match byte {
                        b'0'..=b'9' => byte - b'0',
                        b'a'..=b'f' => byte - b'a' + 10,
                        _ => return false,
                    };
                    usize::from(index) < palette_len
                })
        })
        .then_some(width * pixels.len())
}
