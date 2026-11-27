//! JavaScript measures and slices strings in UTF-16 code units. Every limit,
//! truncation, offset, and index the ported code takes from `.length`,
//! `.slice`, `.substring`, `.charCodeAt`, or a regex match index goes through
//! this module.
//!
//! A JavaScript string can hold the lone surrogate that slicing a surrogate
//! pair in two produces, and a Rust `String` cannot. A boundary that would
//! split a pair drops the half pair instead, so the result keeps every
//! character and is never longer than the JavaScript result.

use std::borrow::Cow;
use std::cmp::Ordering;

/// `.length`: the number of UTF-16 code units.
pub fn len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// `String.prototype.charCodeAt(index)`: the UTF-16 code unit at `index`, or
/// `None` when `index` is past the end, where JavaScript yields `NaN`.
pub fn char_code_at(text: &str, index: usize) -> Option<u16> {
    let mut offset = 0;
    for character in text.chars() {
        let units = character.len_utf16();
        if index < offset + units {
            if units == 1 {
                // INFALLIBLE: a one-unit character is a BMP code point.
                return Some(character as u16);
            }
            let code_point = character as u32 - 0x1_0000;
            return Some(if index == offset {
                (0xD800 + (code_point >> 10)) as u16
            } else {
                (0xDC00 + (code_point & 0x3FF)) as u16
            });
        }
        offset += units;
    }
    None
}

/// The byte offset of UTF-16 code unit `index`. An index inside a surrogate
/// pair moves after the pair when the range starts there and before it when
/// the range ends there.
fn byte_offset(text: &str, index: usize, starts: bool) -> usize {
    let mut offset = 0;
    for (at, character) in text.char_indices() {
        let units = character.len_utf16();
        if index < offset + units {
            if index == offset {
                return at;
            }
            return if starts {
                at + character.len_utf8()
            } else {
                at
            };
        }
        offset += units;
    }
    text.len()
}

/// `String.prototype.slice(start, end)`. A negative index counts from the end
/// and `end` of `None` means the end of the string.
pub fn slice(text: &str, start: isize, end: Option<isize>) -> &str {
    let length = len(text) as isize;
    let start = if start < 0 {
        (length + start).max(0)
    } else {
        start.min(length)
    };
    let end = match end {
        None => length,
        Some(end) => {
            if end < 0 {
                (length + end).max(0)
            } else {
                end.min(length)
            }
        }
    };
    if start >= end {
        return "";
    }
    &text[byte_offset(text, start as usize, true)..byte_offset(text, end as usize, false)]
}

/// `String.prototype.substring(start, end)`: as `slice`, but the two indices
/// are swapped when `start` is the larger and both clamp to the string.
pub fn substring(text: &str, start: isize, end: Option<isize>) -> &str {
    let length = len(text) as isize;
    let start = start.clamp(0, length);
    let end = match end {
        None => length,
        Some(end) => end.clamp(0, length),
    };
    slice(text, start.min(end), Some(start.max(end)))
}

/// The longest prefix of at most `max_units` code units.
pub fn truncate(text: &str, max_units: usize) -> &str {
    slice(text, 0, Some(max_units as isize))
}

/// `String.prototype.indexOf(needle)`: the UTF-16 code unit where `needle`
/// starts, or `None` when the string does not contain it.
pub fn index_of(text: &str, needle: &str) -> Option<usize> {
    let at = text.find(needle)?;
    Some(len(&text[..at]))
}

/// `String.prototype.padEnd(target_length, pad)`.
pub fn pad_end<'a>(text: &'a str, target_length: usize, pad: &str) -> Cow<'a, str> {
    let missing = target_length.saturating_sub(len(text));
    if missing == 0 || pad.is_empty() {
        return Cow::Borrowed(text);
    }
    let mut padded = String::with_capacity(text.len() + missing * pad.len());
    padded.push_str(text);
    let mut added = 0;
    while added < missing {
        for character in pad.chars() {
            let units = character.len_utf16();
            // A pad cut inside a surrogate pair ends before the pair.
            if added + units > missing {
                return Cow::Owned(padded);
            }
            padded.push(character);
            added += units;
        }
    }
    Cow::Owned(padded)
}

/// The order `Array.prototype.sort` and `localeCompare`-free string
/// comparison use: by UTF-16 code unit. `str::cmp` orders astral characters
/// differently.
pub fn cmp(left: &str, right: &str) -> Ordering {
    left.encode_utf16().cmp(right.encode_utf16())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measures_in_code_units() {
        assert_eq!(len(""), 0);
        assert_eq!(len("abc"), 3);
        assert_eq!(len("\u{e9}"), 1);
        assert_eq!(len("\u{1F600}"), 2);
        assert_eq!(len("a\u{1F600}z"), 4);
    }

    #[test]
    fn reads_code_units() {
        assert_eq!(char_code_at("a\u{1F600}", 0), Some(97));
        assert_eq!(char_code_at("a\u{1F600}", 1), Some(0xD83D));
        assert_eq!(char_code_at("a\u{1F600}", 2), Some(0xDE00));
        assert_eq!(char_code_at("a\u{1F600}", 3), None);
        assert_eq!(char_code_at("\u{e9}", 0), Some(0xE9));
    }

    #[test]
    fn slices_with_negative_and_clamped_indices() {
        // The string is five code units: `a`, the pair, `c`, `d`.
        let text = "a\u{1F600}cd";
        assert_eq!(len(text), 5);
        assert_eq!(slice(text, 0, Some(3)), "a\u{1F600}");
        // An end inside the pair drops the pair.
        assert_eq!(slice(text, 0, Some(2)), "a");
        assert_eq!(slice(text, 0, Some(1)), "a");
        assert_eq!(slice(text, 1, None), "\u{1F600}cd");
        // A start inside the pair drops the pair.
        assert_eq!(slice(text, 2, Some(4)), "c");
        assert_eq!(slice(text, 3, Some(5)), "cd");
        assert_eq!(slice(text, -2, None), "cd");
        assert_eq!(slice(text, -9, Some(-1)), "a\u{1F600}c");
        assert_eq!(slice(text, 3, Some(2)), "");
        assert_eq!(slice(text, 9, None), "");
        assert_eq!(slice(text, 1, Some(3)), "\u{1F600}");
        assert_eq!(substring(text, 3, Some(1)), "\u{1F600}");
        assert_eq!(substring("abc", -5, Some(9)), "abc");
        assert_eq!(substring("abc", 2, None), "c");
        assert_eq!(truncate("a\u{1F600}bcd", 3), "a\u{1F600}");
        assert_eq!(truncate("a\u{1F600}bcd", 2), "a");
        assert_eq!(truncate("a\u{1F600}bcd", 4), "a\u{1F600}b");
        assert_eq!(truncate("abc", 9), "abc");
        assert_eq!(truncate("abc", 0), "");
    }

    #[test]
    fn finds_and_pads_in_code_units() {
        assert_eq!(index_of("a\u{1F600}cd", "c"), Some(3));
        assert_eq!(index_of("a\u{1F600}cd", "z"), None);
        assert_eq!(pad_end("17", 16, "0"), Cow::Borrowed("1700000000000000"));
        assert_eq!(pad_end("x", 2, "ab"), Cow::Borrowed("xa"));
        assert_eq!(pad_end("abc", 2, "-"), Cow::<str>::Borrowed("abc"));
        assert_eq!(
            pad_end("", 3, "\u{1F600}"),
            Cow::<str>::Borrowed("\u{1F600}")
        );
    }

    #[test]
    fn orders_strings_by_code_unit() {
        assert_eq!(cmp("\u{5C}", "a"), Ordering::Less);
        assert_eq!(cmp("\u{FF5E}", "\u{1F600}"), Ordering::Greater);
        assert_eq!(cmp("\u{1F600}", "\u{E000}"), Ordering::Less);
        assert_eq!("\u{FF5E}".cmp("\u{1F600}"), Ordering::Less);
        let mut sorted = ["\u{FF5E}", "\u{5C}", "\u{1F600}", "a", "\u{E000}"];
        sorted.sort_by(|left, right| cmp(left, right));
        assert_eq!(sorted, ["\\", "a", "\u{1F600}", "\u{E000}", "\u{FF5E}"]);
    }
}
