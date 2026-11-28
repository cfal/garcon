//! JavaScript number semantics and the string rules the ported code shares:
//! `Number::toString`, `parseInt`, `Math.round`, `toFixed`, `String.prototype
//! .trim`, and the order in which JavaScript enumerates object keys.

use std::cmp::Ordering;
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A JavaScript `number` that can be fractional and reaches JSON output.
///
/// It serializes as JavaScript writes it: `serde_json` writes the `f64` 1.0 as
/// `1.0` and 1e21 as `1e21`, where JavaScript writes `1` and `1e+21`. A number
/// that is not finite is written as `null`, as `JSON.stringify` does.
///
/// The number is written as a raw JSON token, so it is exact when a value is
/// serialized to text, a byte buffer, or a writer. `serde_json::to_value`
/// cannot hold the token: it parses it again into a plain `f64`, which then
/// prints as `serde_json` prints.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Number(pub f64);

impl Number {
    pub fn to_js_string(self) -> String {
        number_to_string(self.0)
    }
}

impl<'de> Deserialize<'de> for Number {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Number, D::Error> {
        f64::deserialize(deserializer).map(Number)
    }
}

impl From<f64> for Number {
    fn from(value: f64) -> Number {
        Number(value)
    }
}

impl fmt::Display for Number {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&number_to_string(self.0))
    }
}

impl Serialize for Number {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let token = if self.0.is_finite() {
            number_to_string(self.0)
        } else {
            "null".to_owned()
        };
        serde_json::value::RawValue::from_string(token)
            .map_err(serde::ser::Error::custom)?
            .serialize(serializer)
    }
}

/// `Number::toString()` in base 10, which is also what `JSON.stringify` writes
/// for a finite number. `NaN`, the infinities, and zero print as JavaScript
/// prints them.
pub fn number_to_string(value: f64) -> String {
    ryu_js::Buffer::new().format(value).to_owned()
}

/// `parseInt(text, radix)`. A radix of 0 means the radix was not given.
/// Returns `None` for `NaN`.
///
/// Bun's `parseInt` follows JavaScriptCore
/// (https://github.com/WebKit/WebKit/blob/6f5f583b55ecab83b237a8fd1a5aade75acef938/Source/JavaScriptCore/runtime/ParseInt.h#L136-L253):
/// in base 10 a long digit run is converted exactly, and in another base the
/// value accumulates in `f64` arithmetic, which the specification permits to
/// be an approximation. The port repeats that arithmetic so the results are
/// equal and not merely close.
pub fn parse_int(text: &str, radix: u32) -> Option<f64> {
    if radix != 0 && !(2..=36).contains(&radix) {
        return None;
    }
    let mut rest = trim_start(text);
    let mut negative = false;
    match rest.chars().next() {
        Some('+') => rest = &rest[1..],
        Some('-') => {
            negative = true;
            rest = &rest[1..];
        }
        _ => {}
    }
    let mut radix = radix;
    let hex_prefix = rest.len() >= 2 && (rest.starts_with("0x") || rest.starts_with("0X"));
    if radix == 0 {
        if hex_prefix {
            radix = 16;
            rest = &rest[2..];
        } else {
            radix = 10;
        }
    } else if radix == 16 && hex_prefix {
        rest = &rest[2..];
    }
    let mut number = 0.0_f64;
    let mut digits: Vec<u64> = Vec::new();
    for character in rest.chars() {
        let digit = match character {
            '0'..='9' => u64::from(character as u8 - b'0'),
            'a'..='z' => u64::from(character as u8 - b'a') + 10,
            'A'..='Z' => u64::from(character as u8 - b'A') + 10,
            _ => break,
        };
        if digit >= u64::from(radix) {
            break;
        }
        number *= f64::from(radix);
        number += digit as f64;
        digits.push(digit);
    }
    if digits.is_empty() {
        return None;
    }
    // Where the accumulation has lost digits, base 10 converts the digit run
    // again and a power-of-two radix recovers them.
    if number >= 9007199254740992.0 {
        number = match radix {
            10 => parse_decimal(&digits),
            2 | 4 | 8 | 16 | 32 => parse_int_overflow(&digits, radix),
            _ => number,
        };
    }
    Some(if negative { -number } else { number })
}

/// A digit run in base 10 as the nearest `f64`, as a numeric literal is read.
fn parse_decimal(digits: &[u64]) -> f64 {
    let text: String = digits
        .iter()
        .map(|digit| char::from(b'0' + *digit as u8))
        .collect();
    // A run of digits is always a numeric literal; one too large is infinite.
    text.parse().unwrap_or(f64::INFINITY)
}

/// JavaScriptCore's `parseIntOverflow`
/// (ParseInt.h, lines 59 to 79 of the commit above): a power-of-two radix adds
/// each digit times its power, from the last digit back to the first.
fn parse_int_overflow(digits: &[u64], radix: u32) -> f64 {
    let radix = f64::from(radix);
    let mut number = 0.0_f64;
    let mut radix_multiplier = 1.0_f64;
    for digit in digits.iter().rev() {
        if radix_multiplier.is_infinite() {
            if *digit != 0 {
                return f64::INFINITY;
            }
        } else {
            number += *digit as f64 * radix_multiplier;
        }
        radix_multiplier *= radix;
    }
    number
}

/// `Math.round`: rounds half toward positive infinity.
pub fn math_round(value: f64) -> f64 {
    if value == 0.0 || !value.is_finite() {
        return value;
    }
    // A negative value that rounds to zero yields negative zero.
    if (-0.5..0.0).contains(&value) {
        return -0.0;
    }
    // The exact fraction decides, not the rounded sum `value + 0.5`.
    let magnitude = value.abs();
    let floor = magnitude.floor();
    let fraction = magnitude - floor;
    let rounds_up = if value < 0.0 {
        fraction > 0.5
    } else {
        fraction >= 0.5
    };
    let rounded = if rounds_up { floor + 1.0 } else { floor };
    if value < 0.0 { -rounded } else { rounded }
}

/// `Number.isInteger(value)`.
pub fn is_integer(value: f64) -> bool {
    value.is_finite() && value.trunc() == value
}

/// `Number.isSafeInteger(value)`: an integer that a `number` holds exactly.
pub fn is_safe_integer(value: f64) -> bool {
    is_integer(value) && value.abs() <= 9007199254740991.0
}

/// `Number.isFinite(value)` for a value that is known to be a `number`.
pub fn is_finite_number(value: f64) -> bool {
    value.is_finite()
}

/// `toFixed()` was called with a digit count outside 0 to 100.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FractionDigitsOutOfRange;

impl fmt::Display for FractionDigitsOutOfRange {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("toFixed() argument must be between 0 and 100")
    }
}

impl std::error::Error for FractionDigitsOutOfRange {}

/// `Number.prototype.toFixed(fraction_digits)`.
pub fn to_fixed(value: f64, fraction_digits: u32) -> Result<String, FractionDigitsOutOfRange> {
    match u8::try_from(fraction_digits) {
        Ok(fraction_digits) if fraction_digits <= 100 => Ok(ryu_js::Buffer::new()
            .format_to_fixed(value, fraction_digits)
            .to_owned()),
        _ => Err(FractionDigitsOutOfRange),
    }
}

/// `String.prototype.trim()`.
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_whitespace)
}

/// `String.prototype.trimStart()`.
pub fn trim_start(text: &str) -> &str {
    text.trim_start_matches(is_whitespace)
}

/// `String.prototype.trimEnd()`.
pub fn trim_end(text: &str) -> &str {
    text.trim_end_matches(is_whitespace)
}

/// Whether `character` is ECMAScript whitespace or a line terminator, the set
/// `trim` removes. U+0085 is not in it.
fn is_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'..='\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// The array index a property key names, if it is one: a canonical decimal
/// string from 0 to 2^32 - 2.
pub fn array_index(key: &str) -> Option<u64> {
    if key.is_empty() || !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    if key.len() > 1 && key.starts_with('0') {
        return None;
    }
    match key.parse::<u64>() {
        Ok(index) if index < u32::MAX as u64 => Some(index),
        _ => None,
    }
}

/// Puts property keys in the order JavaScript enumerates them: array indexes
/// in ascending numeric order, then every other key in the given order.
pub fn sort_object_keys(keys: &mut [String]) {
    keys.sort_by(
        |left, right| match (array_index(left), array_index(right)) {
            (Some(left), Some(right)) => left.cmp(&right),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            (None, None) => Ordering::Equal,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_numbers_as_javascript_does() {
        for (value, expected) in [
            (1.0, "1"),
            (1.5, "1.5"),
            (0.5, "0.5"),
            (100.0, "100"),
            (0.1 + 0.2, "0.30000000000000004"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (1e-7, "1e-7"),
            (1e-6, "0.000001"),
            (123e-20, "1.23e-18"),
            (1.5e300, "1.5e+300"),
            (5e-324, "5e-324"),
            (-1.5, "-1.5"),
            (-0.0, "0"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (0.0, "0"),
            (2_f64.powi(53), "9007199254740992"),
            (9007199254740993.0, "9007199254740992"),
            (1e23, "1e+23"),
            (1.5e20, "150000000000000000000"),
            (123456.789, "123456.789"),
            // Two shortest forms tie; JavaScript writes the even one.
            (f64::from_bits(0x4318_1996_d751_52d1), "1695883772318900.2"),
            (f64::from_bits(0x42af_c888_d706_b720), "17473074856795.562"),
        ] {
            assert_eq!(number_to_string(value), expected, "{value}");
        }
    }

    #[test]
    fn serializes_as_a_json_number_in_javascript_form() {
        let payload = StructWithNumber {
            duration: Number(1.0),
            tiny: Number(1e-7),
            big: Number(1e21),
            tie: Number(f64::from_bits(0x4318_1996_d751_52d1)),
        };
        assert_eq!(
            serde_json::to_string(&payload).unwrap(),
            "{\"duration\":1,\"tiny\":1e-7,\"big\":1e+21,\"tie\":1695883772318900.2}"
        );
        let array = vec![Number(f64::NAN), Number(f64::INFINITY), Number(-0.0)];
        assert_eq!(serde_json::to_string(&array).unwrap(), "[null,null,0]");
        // `to_value` cannot hold the raw token: it parses the token again and
        // keeps a plain `f64`, which prints as `serde_json` prints.
        assert_eq!(
            serde_json::to_value(Number(12.5)).unwrap(),
            serde_json::json!(12.5)
        );
        assert_eq!(
            serde_json::to_value(Number(1e21)).unwrap(),
            serde_json::json!(1e21)
        );
    }

    #[test]
    fn reads_a_json_number_as_a_javascript_double() {
        #[derive(Debug, PartialEq, Deserialize, Serialize)]
        struct Settings {
            min: Number,
            step: Number,
        }
        let settings: Settings = crate::json::from_str(r#"{"min":1,"step":0.5}"#).unwrap();
        assert_eq!(
            settings,
            Settings {
                min: Number(1.0),
                step: Number(0.5)
            }
        );
        assert_eq!(
            serde_json::to_string(&settings).unwrap(),
            r#"{"min":1,"step":0.5}"#
        );
        // An integer beyond 2^53 rounds as `JSON.parse` rounds it.
        let big: Number = crate::json::from_str("9007199254740993").unwrap();
        assert_eq!(big, Number(9007199254740992.0));
        assert!(crate::json::from_str::<Number>("\"1\"").is_err());
        assert!(crate::json::from_str::<Number>("null").is_err());
    }

    #[derive(Serialize)]
    struct StructWithNumber {
        duration: Number,
        tiny: Number,
        big: Number,
        tie: Number,
    }

    #[test]
    fn parses_integers_from_a_numeric_prefix() {
        for (text, radix, expected) in [
            ("  0x1f", 0, Some(31.0)),
            ("  -42abc", 0, Some(-42.0)),
            ("zz", 0, None),
            ("99999999999999999999", 10, Some(1e20)),
            (
                "123456789012345678901234567890",
                10,
                Some(1.2345678901234568e29),
            ),
            ("1e3", 10, Some(1.0)),
            (" \u{00a0}77", 10, Some(77.0)),
            ("\u{feff}8", 10, Some(8.0)),
            ("\u{0085}8", 10, None),
            ("0x10", 16, Some(16.0)),
            ("0x10", 0, Some(16.0)),
            ("-0x10", 0, Some(-16.0)),
            ("+", 10, None),
            ("", 10, None),
            ("  +7.5", 10, Some(7.0)),
            ("37abc", 8, Some(31.0)),
            ("0b101", 0, Some(0.0)),
            ("0o17", 0, Some(0.0)),
        ] {
            assert_eq!(parse_int(text, radix), expected, "{text:?} radix {radix}");
        }
        assert!(parse_int("-0", 10).unwrap().is_sign_negative());
    }

    #[test]
    fn rounds_half_toward_positive_infinity() {
        for (value, expected) in [
            (2.5, 3.0),
            (-2.5, -2.0),
            (0.49999999999999994, 0.0),
            (4503599627370495.5, 4503599627370496.0),
        ] {
            assert_eq!(math_round(value), expected, "{value}");
        }
        for value in [-0.5, -0.49999999999999994] {
            assert_eq!(math_round(value), 0.0);
            assert!(math_round(value).is_sign_negative(), "{value}");
        }
        assert!(math_round(f64::NAN).is_nan());
        assert_eq!(math_round(f64::INFINITY), f64::INFINITY);
    }

    #[test]
    fn rounds_and_formats_fixed_fractions() {
        for (value, digits, expected) in [
            (-0.04, 1, "-0.0"),
            (-0.0001, 2, "-0.00"),
            (-0.0, 1, "0.0"),
            (-1.25, 1, "-1.3"),
            (1.25, 1, "1.3"),
            (1.005, 2, "1.00"),
            (0.5, 0, "1"),
            (-0.5, 0, "-1"),
            (-1.5, 0, "-2"),
            (1e21, 2, "1e+21"),
            (-1e21, 2, "-1e+21"),
            (1e20, 0, "100000000000000000000"),
            (123.456, 8, "123.45600000"),
            (0.0, 3, "0.000"),
            (4.35, 1, "4.3"),
            (8.345, 2, "8.35"),
            (5e-324, 2, "0.00"),
            (-5e-324, 2, "-0.00"),
            (123456789012345670000.0, 2, "123456789012345667584.00"),
            (0.1, 30, "0.100000000000000005551115123126"),
            (f64::NAN, 2, "NaN"),
            (f64::INFINITY, 2, "Infinity"),
            (f64::NEG_INFINITY, 2, "-Infinity"),
        ] {
            assert_eq!(to_fixed(value, digits), Ok(expected.to_owned()), "{value}");
        }
        assert_eq!(to_fixed(1.0, 101), Err(FractionDigitsOutOfRange));
        assert_eq!(
            to_fixed(1.0, 101).unwrap_err().to_string(),
            "toFixed() argument must be between 0 and 100"
        );
    }

    #[test]
    fn classifies_numbers_as_javascript_does() {
        // `Number.isInteger`, `Number.isSafeInteger`, `Number.isFinite`, as
        // Bun 1.4.5 answers for each value.
        for (value, integer, safe, finite) in [
            (0.0, true, true, true),
            (-0.0, true, true, true),
            (1.0, true, true, true),
            (-3.0, true, true, true),
            (-9007199254740991.0, true, true, true),
            (9007199254740991.0, true, true, true),
            (1e15, true, true, true),
            // An integer beyond 2^53 is still an integer, but not a safe one.
            (9007199254740992.0, true, false, true),
            (1e21, true, false, true),
            (1e300, true, false, true),
            (0.5, false, false, true),
            (1e-7, false, false, true),
            (5e-324, false, false, true),
            (f64::NAN, false, false, false),
            (f64::INFINITY, false, false, false),
            (f64::NEG_INFINITY, false, false, false),
        ] {
            assert_eq!(is_integer(value), integer, "isInteger({value})");
            assert_eq!(is_safe_integer(value), safe, "isSafeInteger({value})");
            assert_eq!(is_finite_number(value), finite, "isFinite({value})");
        }
    }

    #[test]
    fn trims_javascript_whitespace() {
        assert_eq!(trim(" \t\n\u{feff}x\u{00a0}\u{3000}"), "x");
        assert_eq!(trim("\u{0085}x"), "\u{0085}x");
        assert_eq!(trim_start("  x  "), "x  ");
        assert_eq!(trim_end("  x  "), "  x");
    }

    #[test]
    fn orders_object_keys_as_javascript_enumerates_them() {
        let mut keys = ["x", "01", "10", "1", "4294967295", "4294967294", "9", "-1"]
            .map(String::from)
            .to_vec();
        sort_object_keys(&mut keys);
        assert_eq!(
            keys,
            ["1", "9", "10", "4294967294", "x", "01", "4294967295", "-1"]
        );
    }
}
