//! Reading and writing JSON as JavaScript does (rust/RULES.md, JSON).
//!
//! JSON text that comes from outside is read with [`from_str`] and
//! [`from_slice`], never with `serde_json`'s: a JavaScript string can hold a
//! lone surrogate and a Rust `String` cannot, so a lone `\\uD800`-`\\uDFFF`
//! escape becomes U+FFFD where `serde_json` fails the whole document. JSON
//! that came from outside and is written out again is an [`Opaque`]: it reads
//! every number as a JavaScript double and prints it as JavaScript prints it.
//!
//! Three differences from the original remain. Each is a known difference and
//! is not worked around here.
//!
//! - A number beyond the `f64` range. `[1e400]`: the original reads an infinity
//!   and prints `[null]`; here it is a parse error.
//! - Nesting deeper than 128 levels. 129 nested `[`: the original parses it;
//!   here it is a parse error.
//! - A lone surrogate escape. `{"a":"\\ud800"}`: the original prints
//!   `{"a":"\\ud800"}`; here the string holds U+FFFD instead.
//!
//! JavaScript also lists the array-index keys of an object first, in numeric
//! order, where a `serde_json::Map` keeps insertion order. [`parse`] and
//! [`Opaque`] put them in the JavaScript order.

use std::borrow::Cow;
use std::ops::Deref;

use serde::de::DeserializeOwned;
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{Map, Number, Value};

use crate::js::{Number as JsNumber, array_index, sort_object_keys};

/// Reads JSON text that came from outside into `T`.
#[expect(
    clippy::disallowed_methods,
    reason = "this is the entry point the lint points to"
)]
pub fn from_str<T: DeserializeOwned>(text: &str) -> Result<T, serde_json::Error> {
    match replace_lone_surrogates(text.as_bytes()) {
        Cow::Borrowed(_) => serde_json::from_str(text),
        Cow::Owned(text) => serde_json::from_slice(&text),
    }
}

/// Reads JSON bytes that came from outside into `T`.
#[expect(
    clippy::disallowed_methods,
    reason = "this is the entry point the lint points to"
)]
pub fn from_slice<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, serde_json::Error> {
    serde_json::from_slice(&replace_lone_surrogates(bytes))
}

/// Replaces a surrogate escape that has no partner with U+FFFD. A high
/// surrogate followed by a low one is a valid pair and stays. The scan tracks
/// string and backslash state, so a backslash that is itself escaped is not
/// read as the start of an escape.
fn replace_lone_surrogates(input: &[u8]) -> Cow<'_, [u8]> {
    if !input.windows(2).any(|window| window == b"\\u") {
        return Cow::Borrowed(input);
    }
    let mut escapes = unpaired_surrogate_escapes(input);
    let Some(first) = escapes.next() else {
        return Cow::Borrowed(input);
    };
    let mut output = Vec::with_capacity(input.len());
    let mut copied = 0;
    for start in std::iter::once(first).chain(escapes) {
        output.extend_from_slice(&input[copied..start]);
        output.extend_from_slice(b"\\uFFFD");
        copied = start + 6;
    }
    output.extend_from_slice(&input[copied..]);
    Cow::Owned(output)
}

/// Checks valid JSON text for unpaired surrogate escapes in string keys or values.
pub fn contains_unpaired_surrogate_escape(raw: &[u8]) -> bool {
    raw.windows(2).any(|window| window == b"\\u")
        && unpaired_surrogate_escapes(raw).next().is_some()
}

fn unpaired_surrogate_escapes(input: &[u8]) -> impl Iterator<Item = usize> + '_ {
    let mut index = 0;
    let mut in_string = false;
    std::iter::from_fn(move || {
        while let Some(&byte) = input.get(index) {
            if byte == b'"' {
                in_string = !in_string;
            }
            if !in_string || byte != b'\\' {
                index += 1;
                continue;
            }
            let start = index;
            index += 2;
            if input.get(start + 1) != Some(&b'u') {
                continue;
            }
            let Some(unit) = hex_escape(input, index) else {
                continue;
            };
            index += 4;
            if !(0xD800..=0xDFFF).contains(&unit) {
                continue;
            }
            let paired = unit <= 0xDBFF
                && input.get(index..index + 2) == Some(b"\\u")
                && hex_escape(input, index + 2).is_some_and(|low| (0xDC00..=0xDFFF).contains(&low));
            if paired {
                index += 6;
            } else {
                return Some(start);
            }
        }
        None
    })
}

/// The code unit of the four hex digits of a `\\u` escape that starts at
/// `start`.
fn hex_escape(input: &[u8], start: usize) -> Option<u16> {
    let digits = input.get(start..start + 4)?;
    let mut unit = 0_u16;
    for digit in digits {
        unit = unit * 16 + (*digit as char).to_digit(16)? as u16;
    }
    Some(unit)
}

/// JSON that came from outside and is written out again: tool input, provider
/// payloads, stored rows.
///
/// It holds a value tree and reads every number as a JavaScript double, so an
/// integer beyond 2^53 is rounded as `JSON.parse` rounds it. It prints numbers
/// as JavaScript prints them: `1.0` prints as `1`, and an exponent carries its
/// `+`. A bare `serde_json::Value` prints `1.0` and keeps such an integer.
///
/// It dereferences to `serde_json::Value` for inspection; read a number with
/// [`as_number`], because no number in an `Opaque` is an integer type. It works
/// as a field of a derived `Serialize` and `Deserialize` struct. Serialize it
/// to text, a byte buffer, or a writer: `serde_json::to_value` reparses the
/// numbers and loses their form.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Opaque(Value);

impl Opaque {
    /// The JSON value that came from `text`.
    pub fn parse(text: &str) -> Result<Opaque, serde_json::Error> {
        from_str(text)
    }

    /// The JSON value from an already parsed tree.
    pub fn from_value(value: Value) -> Opaque {
        let mut value = value;
        normalize(&mut value);
        Opaque(value)
    }

    /// The value tree.
    pub fn as_value(&self) -> &Value {
        &self.0
    }

    /// The value tree.
    pub fn into_value(self) -> Value {
        self.0
    }
}

impl From<Value> for Opaque {
    fn from(value: Value) -> Opaque {
        Opaque::from_value(value)
    }
}

impl From<Opaque> for Value {
    fn from(opaque: Opaque) -> Value {
        opaque.0
    }
}

impl Deref for Opaque {
    type Target = Value;

    fn deref(&self) -> &Value {
        &self.0
    }
}

impl Serialize for Opaque {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        AsJavaScript(&self.0).serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for Opaque {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Opaque, D::Error> {
        Value::deserialize(deserializer).map(Opaque::from_value)
    }
}

/// A value tree written as JavaScript writes it.
struct AsJavaScript<'a>(&'a Value);

impl Serialize for AsJavaScript<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            Value::Null => serializer.serialize_unit(),
            Value::Bool(value) => serializer.serialize_bool(*value),
            Value::Number(number) => JsNumber(as_number_of(number)).serialize(serializer),
            Value::String(value) => serializer.serialize_str(value),
            Value::Array(items) => {
                let mut sequence = serializer.serialize_seq(Some(items.len()))?;
                for item in items {
                    sequence.serialize_element(&AsJavaScript(item))?;
                }
                sequence.end()
            }
            Value::Object(map) => {
                let mut object = serializer.serialize_map(Some(map.len()))?;
                match javascript_key_order(map) {
                    None => {
                        for (key, item) in map {
                            object.serialize_entry(key, &AsJavaScript(item))?;
                        }
                    }
                    Some(keys) => {
                        for key in keys {
                            // INFALLIBLE: every key comes from this map.
                            let item = map.get(&key).expect("the key comes from this map");
                            object.serialize_entry(&key, &AsJavaScript(item))?;
                        }
                    }
                }
                object.end()
            }
        }
    }
}

/// The JavaScript double a `serde_json` number holds.
fn as_number_of(number: &Number) -> f64 {
    // INFALLIBLE: `serde_json` parses only finite numbers into a `Value`.
    number.as_f64().unwrap_or(0.0)
}

/// Parses JSON text as `JSON.parse` does, for inspection.
pub fn parse(text: &str) -> Result<Value, serde_json::Error> {
    from_str::<Opaque>(text).map(Opaque::into_value)
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut text = Vec::new();
    // INFALLIBLE: writing to a `Vec` cannot fail.
    AsJavaScript(value)
        .serialize(&mut serde_json::Serializer::new(&mut text))
        .expect("serializing JSON into memory cannot fail");
    // INFALLIBLE: the serializer writes UTF-8.
    String::from_utf8(text).expect("serde_json writes UTF-8")
}

/// Rewrites every number of `value` as a JavaScript double and puts the keys
/// of every object in the order JavaScript enumerates them.
pub fn normalize(value: &mut Value) {
    match value {
        Value::Array(items) => {
            for item in items {
                normalize(item);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                normalize(item);
            }
            if let Some(keys) = javascript_key_order(map) {
                let mut source = std::mem::take(map);
                for key in keys {
                    // INFALLIBLE: every key comes from this map.
                    if let Some(item) = source.swap_remove(&key) {
                        map.insert(key, item);
                    }
                }
            }
        }
        Value::Number(number) => *value = Value::from(as_number_of(number)),
        _ => {}
    }
}

/// The keys of an object in the order JavaScript enumerates them, when that
/// is not the order they are stored in: array indexes ascending first, then
/// every other key where it was.
fn javascript_key_order(map: &Map<String, Value>) -> Option<Vec<String>> {
    let mut last_index: Option<u64> = None;
    let mut seen_other = false;
    for key in map.keys() {
        match array_index(key) {
            Some(index) => {
                if seen_other || last_index.is_some_and(|previous| previous > index) {
                    let mut keys: Vec<String> = map.keys().cloned().collect();
                    sort_object_keys(&mut keys);
                    return Some(keys);
                }
                last_index = Some(index);
            }
            None => seen_other = true,
        }
    }
    None
}

/// The number a JSON value holds, as JavaScript reads a `number`.
pub fn as_number(value: &Value) -> Option<f64> {
    value.as_number()?.as_f64()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_and_keeps_json_shapes() {
        let value = parse(r#"{"a":[1,"two",true,null],"b":{"c":{}}}"#).unwrap();
        assert_eq!(
            value,
            json!({"a": [1.0, "two", true, null], "b": {"c": {}}})
        );
        assert!(parse("{").is_err());
        assert!(parse("[1,]").is_err());
        assert_eq!(
            stringify(&value),
            r#"{"a":[1,"two",true,null],"b":{"c":{}}}"#
        );
    }

    #[test]
    fn reads_every_number_as_a_javascript_double() {
        for (text, expected) in [
            (r#"{"a":1.0}"#, r#"{"a":1}"#),
            (r#"{"a":1e2}"#, r#"{"a":100}"#),
            (r#"{"a":1E-7}"#, r#"{"a":1e-7}"#),
            (r#"{"a":-0}"#, r#"{"a":0}"#),
            (r#"{"a":0.5}"#, r#"{"a":0.5}"#),
            (
                r#"[1.5e-7,0.1,-0.30000000000000004]"#,
                r#"[1.5e-7,0.1,-0.30000000000000004]"#,
            ),
            (
                r#"[1695883772318900.2, 9007199254740991.0]"#,
                r#"[1695883772318900.2,9007199254740991]"#,
            ),
            (r#"9007199254740993"#, "9007199254740992"),
            (r#"18446744073709551616"#, "18446744073709552000"),
            (r#"1234567890123456768"#, "1234567890123456800"),
            (
                r#"[1e16,1e20,1e21,1.5e300,1e-6,5e-324]"#,
                r#"[10000000000000000,100000000000000000000,1e+21,1.5e+300,0.000001,5e-324]"#,
            ),
            (r#"8578e-74"#, "8.578e-71"),
        ] {
            assert_eq!(stringify(&parse(text).unwrap()), expected, "{text}");
        }
        let opaque: Opaque = from_str("[9007199254740993, 3]").unwrap();
        assert_eq!(opaque[0], Value::from(9007199254740992.0));
        assert_eq!(as_number(&opaque[1]), Some(3.0));
        assert_eq!(opaque[1].as_u64(), None);
    }

    #[test]
    fn opaque_works_as_a_struct_field() {
        #[derive(Debug, Serialize, Deserialize, PartialEq)]
        struct ToolCall {
            name: String,
            input: Opaque,
        }
        let call: ToolCall = from_str(
            r#"{"name":"write","input":{"count":1.0,"ratio":2.5E-8,"nested":[9007199254740993]}}"#,
        )
        .unwrap();
        assert_eq!(call.name, "write");
        assert_eq!(call.input["ratio"].as_f64(), Some(2.5e-8));
        assert_eq!(
            serde_json::to_string(&call).unwrap(),
            r#"{"name":"write","input":{"count":1,"ratio":2.5e-8,"nested":[9007199254740992]}}"#
        );
        assert_eq!(
            call,
            ToolCall {
                name: "write".to_owned(),
                input: Opaque::parse(r#"{"ratio":2.5e-8,"count":1,"nested":[9007199254740992]}"#)
                    .unwrap(),
            }
        );
        let from_derived: ToolCall = serde_json::from_value(json!({"name": "write", "input": {"count": 1, "ratio": 2.5e-8, "nested": [9007199254740992u64]}})).unwrap();
        assert_eq!(from_derived, call);
        assert_eq!(
            serde_json::to_string_pretty(&call).unwrap(),
            "{\n  \"name\": \"write\",\n  \"input\": {\n    \"count\": 1,\n    \"ratio\": 2.5e-8,\n    \"nested\": [\n      9007199254740992\n    ]\n  }\n}"
        );
    }

    #[test]
    fn a_lone_surrogate_escape_becomes_the_replacement_character() {
        // A JSON string literal that holds the two escapes of a valid pair.
        let pair = |high: u32, low: u32| format!(r#""\u{high:04x}\u{low:04x}""#);
        let replacement = "\u{FFFD}";
        let cases: Vec<(String, &str)> = vec![
            // A high surrogate with no low surrogate after it.
            (r#""\ud800""#.to_owned(), replacement),
            // A low surrogate with no high surrogate before it.
            (r#""x\udc00y""#.to_owned(), "x\u{FFFD}y"),
            // A valid pair stays, in lower and in upper case hex.
            (pair(0xd83d, 0xde00), "\u{1F600}"),
            (pair(0xd83c, 0xdf00), "\u{1F300}"),
            (pair(0x0041, 0x0042), "AB"),
            // An escaped backslash is not the start of an escape.
            (r#""\\ud800""#.to_owned(), "\\ud800"),
            // Two high surrogates, a gap, and an escaped backslash in between.
            (r#""\ud83d\ud800""#.to_owned(), "\u{FFFD}\u{FFFD}"),
            (r#""\ud83d \ude00""#.to_owned(), "\u{FFFD} \u{FFFD}"),
            (r#""\ud83dx""#.to_owned(), "\u{FFFD}x"),
            (r#""\ud83d\\ude00""#.to_owned(), "\u{FFFD}\\ude00"),
            (r#""\udc00\ud83d""#.to_owned(), "\u{FFFD}\u{FFFD}"),
            // Uppercase hex digits.
            (r#""\uD83Dx""#.to_owned(), "\u{FFFD}x"),
        ];
        for (literal, expected) in &cases {
            let document = format!(r#"{{"a":{literal}}}"#);
            assert_eq!(
                parse(&document).unwrap()["a"].as_str(),
                Some(*expected),
                "{document}"
            );
            assert_eq!(
                from_slice::<Opaque>(document.as_bytes()).unwrap()["a"].as_str(),
                Some(*expected)
            );
        }
        // A key is a string too.
        assert_eq!(
            parse(r#"{"\ud800":1}"#).unwrap(),
            json!({ "\u{FFFD}": 1.0 })
        );
        // Outside a string nothing is replaced; the parser reports it.
        assert!(parse(r#"[\ud800]"#).is_err());
        let untouched = replace_lone_surrogates(br#"{"a":"b","c":"\\"}"#);
        assert!(matches!(untouched, Cow::Borrowed(_)));
    }

    #[test]
    fn orders_array_index_keys_first() {
        let text = r#"{"b":1,"10":2,"a":3,"1":4,"01":5,"x":6}"#;
        assert_eq!(
            stringify(&parse(text).unwrap()),
            r#"{"1":4,"10":2,"b":1,"a":3,"01":5,"x":6}"#
        );
        let text = r#"{"b":1,"a":3,"x":6}"#;
        assert_eq!(stringify(&parse(text).unwrap()), text);
        let text = r#"{"1":4,"10":2,"b":1}"#;
        assert_eq!(stringify(&parse(text).unwrap()), text);
        assert_eq!(
            stringify(&json!({"b": 1, "1": 2, "a": 3, "0": 4})),
            r#"{"0":4,"1":2,"b":1,"a":3}"#
        );
    }
}
