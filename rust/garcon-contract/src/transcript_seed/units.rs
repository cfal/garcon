use std::borrow::Cow;

use garcon_js::utf16;

pub(super) fn prefix(text: &str, units: usize) -> Cow<'_, str> {
    // At most three UTF-8 bytes per UTF-16 unit, plus one boundary character.
    let limit = units.saturating_mul(3).saturating_add(4).min(text.len());
    let candidate = &text[..text.floor_char_boundary(limit)];
    let head = utf16::truncate(candidate, units);
    if utf16::len(head) < units && head.len() < candidate.len() {
        Cow::Owned(format!("{head}\u{fffd}"))
    } else {
        Cow::Borrowed(head)
    }
}

pub(super) fn suffix(text: &str, units: isize) -> Cow<'_, str> {
    let tail = utf16::slice(text, units, None);
    let split = matches!(
        utf16::char_code_at(text, units as usize),
        Some(0xdc00..=0xdfff)
    );
    if split {
        Cow::Owned(format!("\u{fffd}{tail}"))
    } else {
        Cow::Borrowed(tail)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accounts_for_the_utf16_unit_at_a_split_pair() {
        let word = "a\u{1f642}b";
        assert_eq!(prefix(word, 2), "a\u{fffd}");
        assert_eq!(prefix(word, 3), "a\u{1f642}");
        assert_eq!(suffix(word, 2), "\u{fffd}b");
        assert_eq!(suffix(word, 3), "b");
    }
}
