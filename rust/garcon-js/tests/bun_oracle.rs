//! Compares the helpers with Bun, the runtime the original runs on. The
//! inputs are fixed edge cases plus a deterministic pseudo-random sample, so
//! every run checks the same cases without a recorded file.

use std::process::Command;

use serde_json::{Value, json};

use garcon_js::json::{self as js_json, Opaque, contains_unpaired_surrogate_escape, from_str};
use garcon_js::{
    Number, math_round, number_to_string, parse_int, string_to_number, to_fixed, utf16,
};

/// A deterministic xorshift64* generator, so a failing run can be repeated.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

fn bits_of(value: f64) -> String {
    format!("{:016x}", value.to_bits())
}

fn value_of(bits: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(bits, 16).unwrap())
}

fn ask(request: Value) -> Value {
    let directory = tempfile::tempdir().unwrap();
    let request_path = directory.path().join("request.json");
    std::fs::write(&request_path, serde_json::to_vec(&request).unwrap()).unwrap();
    let output = Command::new("bun")
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/oracle.ts"))
        .arg(&request_path)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("bun runs the oracle");
    assert!(
        output.status.success(),
        "the oracle failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    garcon_js::json::parse(&String::from_utf8(output.stdout).unwrap()).unwrap()
}

/// Reports every mismatch up to a limit, so one run shows all of them.
struct Mismatches {
    shown: usize,
    total: usize,
}

impl Mismatches {
    fn new() -> Mismatches {
        Mismatches { shown: 0, total: 0 }
    }

    fn add(
        &mut self,
        input: impl std::fmt::Display,
        rust: impl std::fmt::Debug,
        bun: impl std::fmt::Debug,
    ) {
        self.total += 1;
        if self.shown < 25 {
            self.shown += 1;
            eprintln!("input {input}\n  rust {rust:?}\n  bun  {bun:?}");
        }
    }

    fn finish(self, what: &str, checked: usize) {
        assert_eq!(
            self.total, 0,
            "{what}: {} of {checked} inputs differ",
            self.total
        );
    }
}

fn section<'a>(reply: &'a Value, name: &str) -> &'a [Value] {
    reply[name].as_array().unwrap()
}

#[test]
fn string_to_number_matches_bun() {
    let mut inputs: Vec<String> =
        from_str(include_str!("fixtures/string-to-number-inputs.json")).unwrap();
    for character in [
        '\t', '\n', '\u{b}', '\u{c}', '\r', ' ', '\u{a0}', '\u{1680}', '\u{2000}', '\u{200a}',
        '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', '\u{feff}', '\u{85}',
        '\u{180e}', '\u{200b}',
    ] {
        inputs.push(character.to_string());
        inputs.push(format!("{character}+1{character}"));
    }
    let reply = ask(json!({"stringToNumber": inputs}));
    let expected = section(&reply, "stringToNumber");
    assert_eq!(inputs.len(), expected.len());
    let mut mismatches = Mismatches::new();
    for (input, expected) in inputs.iter().zip(expected) {
        let actual = string_to_number(input);
        let bits = if actual.is_nan() {
            "NaN".to_owned()
        } else {
            bits_of(actual)
        };
        if bits != string(expected) {
            mismatches.add(format!("Number({input:?})"), bits, expected);
        }
    }
    mismatches.finish("string_to_number", inputs.len());
}

fn string(item: &Value) -> &str {
    item.as_str().unwrap()
}

#[test]
fn unpaired_surrogate_escapes_match_bun_for_generated_json_documents() {
    let fragments = [
        "",
        "plain",
        r"\\",
        r#"\""#,
        r"\\uD800",
        r"\uD800",
        r"\udbff",
        r"\udc00",
        r"\uDFFF",
        r"\uFFFD",
        r"\u0041",
        r"\n",
        r"\uD83D\uDE80",
        "\u{fffd}",
        "\u{1f680}",
    ];
    let mut inputs = Vec::new();
    for left in fragments {
        for right in fragments {
            inputs.push(format!(r#""{left}{right}""#));
            inputs.push(format!(r#"{{"outer":[{{"{left}{right}":null}},3]}}"#));
            inputs.push(format!(r#"[null,{{"first":"{left}","second":"{right}"}}]"#));
        }
    }
    let reply = ask(json!({"jsonUnpairedSurrogate": inputs}));
    let expected = section(&reply, "jsonUnpairedSurrogate");
    assert_eq!(expected.len(), inputs.len());
    let mut differences = Mismatches::new();
    for (input, expected) in inputs.iter().zip(expected) {
        let actual = contains_unpaired_surrogate_escape(input.as_bytes());
        let expected = expected.as_bool().unwrap();
        if actual != expected {
            differences.add(input, actual, expected);
        }
    }
    differences.finish("unpaired JSON surrogate escapes", inputs.len());
}

#[test]
fn replacing_unpaired_surrogate_values_matches_bun() {
    let literals = [
        r#""\ud800""#,
        r#""x\udc00\ud800y""#,
        r#""\ufffd""#,
        r#""\ud83d\ude80""#,
        r#""\\ud800""#,
        r#""\u0061\"b\n""#,
    ];
    let mut texts = vec![
        r#"{"\ud800" : "\ud800", "__proto__":{"value":"\ud800"}}"#.to_owned(),
        r#"{"z":[1.0,9007199254740993,"\ud800"],"2":null,"1":"\udc00"}"#.to_owned(),
        r#""\ud800\q""#.to_owned(),
        r#""\q\ud800""#.to_owned(),
        r#""\ud800\u00ZZ""#.to_owned(),
        r#""\ud800"#.to_owned(),
        "[\"\\ud800\u{0000}\"]".to_owned(),
        r#"["\ud800",]"#.to_owned(),
        r#"{"\ud800":"\ud800""#.to_owned(),
        r#"["\ud800"true]"#.to_owned(),
    ];
    for first in literals {
        for last in literals {
            texts.push(format!(
                r#"{{"input":{first},"unchanged":"\ufffd","\u0069nput":{{"title":{first},"\u0074itle":{last},"labels":[{first},{{"assignee":{{"ownerKey":{last}}}}}]}},"patch":{{"x":{last}}},"patch":{first}}}"#
            ));
        }
    }
    let inputs: Vec<_> = texts
        .iter()
        .flat_map(|text| [(text, true), (text, false)])
        .collect();
    let reply = ask(json!({ "jsonReplaceUnpairedValues": inputs }));
    let expected = section(&reply, "jsonReplaceUnpairedValues");
    assert_eq!(expected.len(), inputs.len());
    let mut differences = Mismatches::new();
    for ((text, marker), expected) in inputs.iter().zip(expected) {
        let expected = outcome(expected).map(|text| js_json::parse(text).unwrap());
        let actual = js_json::parse_replacing_unpaired_surrogate_values(text, *marker);
        let matches = match (&actual, &expected) {
            (Ok(actual), Ok(expected)) => actual == expected,
            (Err(_), Err((name, _))) => *name == "SyntaxError",
            _ => false,
        };
        if !matches {
            differences.add(
                format_args!("{text:?} with marker {marker}"),
                actual,
                expected,
            );
        }
    }
    differences.finish("replacing unpaired surrogate values", inputs.len());
}

fn outcome(item: &Value) -> Result<&str, (&str, &str)> {
    if let Some(value) = item.get("value") {
        Ok(string(value))
    } else {
        let error = item
            .get("error")
            .expect("oracle outcome has a value or an error");
        Err((string(&error["name"]), string(&error["message"])))
    }
}

/// Values the number formatter must get right: boundaries of the notation
/// forms, the extremes of the type, and decimal fractions with long digits.
fn sample_doubles(rng: &mut Rng, count: usize) -> Vec<f64> {
    let mut values: Vec<f64> = vec![
        0.0,
        -0.0,
        1.0,
        -1.0,
        0.5,
        0.1,
        0.1 + 0.2,
        1.0 / 3.0,
        100.0 / 3.0,
        1e-6,
        1e-7,
        123e-20,
        1e15,
        1e16,
        1e17,
        1e20,
        1.5e20,
        123_456_789_012_345_670_000.0,
        1e21,
        1.5e21,
        1e22,
        1e23,
        1.5e300,
        f64::MAX,
        f64::MIN_POSITIVE,
        f64::from_bits(1),
        9_007_199_254_740_991.0,
        9_007_199_254_740_992.0,
        9_007_199_254_740_993.0,
        9_007_199_254_740_995.0,
        18_446_744_073_709_551_616.0,
        0.499_999_999_999_999_94,
        4.35,
        8.345,
        1.005,
        0.615,
        10.075,
        5e-324,
        2.225_073_858_507_201_4e-308,
        f64::NAN,
        f64::INFINITY,
        f64::NEG_INFINITY,
        123.456,
        6.022_140_76e23,
        1.660_539_066_6e-27,
    ];
    for _ in 0..count / 3 {
        values.push(f64::from_bits(rng.next()));
    }
    for _ in 0..count / 3 {
        // A decimal fraction with up to 25 significant digits.
        let digits = 1 + rng.below(25);
        let mut text: String = (0..digits)
            .map(|_| char::from(b'0' + rng.below(10) as u8))
            .collect();
        let negative = rng.below(2) == 0;
        if negative {
            text.insert(0, '-');
        }
        let point = rng.below(digits + 1);
        text.insert(point + usize::from(negative), '.');
        values.push(text.parse().unwrap());
    }
    for _ in 0..count / 3 {
        // A power of ten with a short mantissa.
        let mantissa = 1.0 + rng.below(100_000) as f64 / 100_000.0;
        let exponent = rng.below(620) as i32 - 310;
        values.push(mantissa * 10f64.powi(exponent));
    }
    values
}

#[test]
fn numbers_print_as_bun_prints_them() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let values = sample_doubles(&mut rng, 60_000);
    let bits: Vec<String> = values.iter().map(|value| bits_of(*value)).collect();
    let reply = ask(json!({ "numberToString": bits, "jsonStringify": bits }));
    let mut mismatches = Mismatches::new();
    let printed = section(&reply, "numberToString");
    let serialized = section(&reply, "jsonStringify");
    for ((index, value), expected) in values.iter().enumerate().zip(printed) {
        let printed = number_to_string(*value);
        if printed != string(expected) {
            mismatches.add(
                format!("{value:?} ({})", bits[index]),
                printed,
                string(expected),
            );
        }
        let serialized_printed = serde_json::to_string(&Number(*value)).unwrap();
        if serialized_printed != string(&serialized[index]) {
            mismatches.add(
                format!("stringify {value:?} ({})", bits[index]),
                serialized_printed,
                string(&serialized[index]),
            );
        }
    }
    mismatches.finish("number_to_string", values.len());
}

#[test]
fn rounding_and_fixed_digits_match_bun() {
    let mut rng = Rng(0xA076_1D64_78BD_642F);
    let values = sample_doubles(&mut rng, 40_000);
    let bits: Vec<String> = values.iter().map(|value| bits_of(*value)).collect();
    let mut fixed: Vec<(String, u32)> = values
        .iter()
        .map(|value| (bits_of(*value), rng.below(101) as u32))
        .collect();
    fixed.extend([
        (bits_of(1.0), 101),
        (bits_of(f64::NAN), 101),
        (bits_of(1.0), u32::MAX),
    ]);
    let reply = ask(json!({ "mathRound": bits, "toFixed": fixed }));
    let mut mismatches = Mismatches::new();
    for (value, item) in values.iter().zip(section(&reply, "mathRound")) {
        let expected = value_of(string(item));
        let rounded = math_round(*value);
        let same = rounded == expected
            || rounded.is_nan() && expected.is_nan()
            // Zero carries its sign.
            || rounded == 0.0 && expected == 0.0 && rounded.is_sign_negative() == expected.is_sign_negative();
        if !same {
            mismatches.add(
                format!("round {value:?}"),
                bits_of(rounded),
                bits_of(expected),
            );
        }
    }
    for ((value, digits), item) in fixed
        .iter()
        .map(|(bits, digits)| (value_of(bits), *digits))
        .zip(section(&reply, "toFixed"))
    {
        let ours = to_fixed(value, digits).map_err(|error| ("RangeError", error.to_string()));
        let actual = ours
            .as_ref()
            .map(String::as_str)
            .map_err(|(name, message)| (*name, message.as_str()));
        if actual != outcome(item) {
            mismatches.add(format!("toFixed {value:?}.{digits}"), ours, item);
        }
    }
    mismatches.finish("math_round and to_fixed", values.len() + fixed.len());
}

#[test]
fn parse_int_reads_what_bun_reads() {
    let mut rng = Rng(0xE703_7ED1_A0B4_28DB);
    let alphabet: Vec<char> =
        "0123456789abcdefxABCDEFX+- .z\u{00a0}\u{feff}\u{3000}\u{2028}\u{0085}\u{200b}\u{0661}\u{00bd}"
            .chars()
            .collect();
    let mut cases: Vec<(String, u32)> = vec![
        ("  0x1f".into(), 0),
        ("0x10".into(), 16),
        ("-0x10".into(), 0),
        ("0x".into(), 0),
        ("-0".into(), 10),
        ("+0x10".into(), 0),
        ("0b101".into(), 0),
        ("1".repeat(400), 10),
        ("9".repeat(30), 10),
        ("1".repeat(310), 10),
        ("-99999999999999999999".into(), 10),
        (
            "77777777777777777777777777777777777777777777777770".into(),
            8,
        ),
    ];
    let radices = [0, 0, 2, 8, 10, 10, 16, 36, 1, 37];
    for _ in 0..30_000 {
        let length = rng.below(34);
        let text: String = (0..length).map(|_| *rng.pick(&alphabet)).collect();
        cases.push((text, *rng.pick(&radices)));
    }
    for _ in 0..10_000 {
        // Long digit runs, which need rounding to a double.
        let length = 1 + rng.below(330);
        let radix = *rng.pick(&[2, 8, 10, 16, 36]);
        let digits: &[char] = match radix {
            2 => &['0', '1'],
            8 => &['0', '1', '2', '3', '4', '5', '6', '7'],
            16 => &['0', '1', '9', 'a', 'f', 'F'],
            36 => &['0', '5', 'z', 'Z', 'a'],
            _ => &['0', '1', '5', '9'],
        };
        let mut text: String = (0..length).map(|_| *rng.pick(digits)).collect();
        if rng.below(2) == 0 {
            text.insert(0, *rng.pick(&['+', '-']));
        }
        cases.push((text, radix));
    }
    let reply = ask(json!({ "parseInt": cases }));
    let mut mismatches = Mismatches::new();
    for ((text, radix), item) in cases.iter().zip(section(&reply, "parseInt")) {
        let expected = match item {
            Value::Object(result) if result.contains_key("value") => {
                Some(value_of(string(&result["value"])))
            }
            _ => None,
        };
        let ours = parse_int(text, *radix);
        let same = match (ours, expected) {
            (None, None) => true,
            (Some(ours), Some(expected)) => {
                ours == expected
                    && (ours != 0.0 || ours.is_sign_negative() == expected.is_sign_negative())
            }
            _ => false,
        };
        if !same {
            mismatches.add(format!("parseInt({text:?}, {radix})"), ours, expected);
        }
    }
    mismatches.finish("parse_int", cases.len());
}

/// Path strings over the characters that drive the lexical rules.
fn sample_paths(rng: &mut Rng, count: usize) -> Vec<String> {
    let tokens: Vec<&str> = vec![
        "/",
        "//",
        "///",
        "a",
        "b",
        "ab",
        ".a",
        "a.b",
        ".",
        "..",
        "...",
        "",
        " ",
        "\\",
        "C:",
        "C:/",
        "D:\\",
        "//host",
        "/share",
        "a/",
        "/a",
        "../",
        "./",
        "/../",
        "x//",
        "\u{e9}",
        "\u{1F600}",
    ];
    let mut paths: Vec<String> = [
        "",
        "/",
        "//",
        "///",
        "/a",
        "//a",
        "//a/",
        "//a/b",
        "//a/b/",
        "//a/b/c",
        "///a/b",
        "/a/",
        "a/",
        "a//",
        "a//b",
        "a//b//",
        "a//b//c",
        "a/..",
        "a/b/c/../../..",
        "../../..",
        "a/...",
        "a/....",
        "a/..b",
        "..a",
        "./",
        "../",
        ".",
        "..",
        "/..",
        "/../..",
        "/a/../..",
        "C:",
        "C:/",
        "C://",
        "C:a",
        "C:/a",
        "C:\\a",
        "\\\\",
        "\\\\a",
        "\\\\a\\",
        "\\\\a\\b",
        "\\\\a\\b\\c",
        "//a//b//c",
        "//a//b//c/",
        "C:/a/../../b",
    ]
    .iter()
    .map(|path| (*path).to_owned())
    .collect();
    for _ in 0..count {
        let parts = 1 + rng.below(9);
        let mut path = String::new();
        for _ in 0..parts {
            path.push_str(rng.pick(&tokens));
        }
        paths.push(path);
    }
    paths
}

#[test]
fn posix_paths_match_bun() {
    let mut rng = Rng(0x94D0_49BB_1331_11EB);
    let paths = sample_paths(&mut rng, 40_000);
    let joins: Vec<Vec<String>> = paths
        .as_chunks::<3>()
        .0
        .iter()
        .map(|chunk| chunk.to_vec())
        .collect();
    let cwd = env!("CARGO_MANIFEST_DIR");
    let resolves: Vec<(String, Vec<String>)> = joins
        .iter()
        .map(|parts| (cwd.to_owned(), parts.clone()))
        .collect();
    let relatives: Vec<(String, String, String)> = paths
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| (cwd.to_owned(), pair[0].clone(), pair[1].clone()))
        .collect();
    let reply = ask(json!({
        "posixNormalize": paths, "posixDirname": paths, "posixBasename": paths,
        "posixJoin": joins, "posixResolve": resolves, "posixRelative": relatives,
    }));
    let mut mismatches = Mismatches::new();
    let normalized = section(&reply, "posixNormalize");
    let dirnames = section(&reply, "posixDirname");
    let basenames = section(&reply, "posixBasename");
    for ((index, path), expected) in paths.iter().enumerate().zip(normalized) {
        let ours = garcon_js::path::posix::normalize(path);
        if ours != string(expected) {
            mismatches.add(format!("normalize({path:?})"), ours, string(expected));
        }
        let expected = string(&dirnames[index]);
        let ours = garcon_js::path::posix::dirname(path);
        if ours != expected {
            mismatches.add(format!("dirname({path:?})"), ours, expected);
        }
        let expected = string(&basenames[index]);
        let ours = garcon_js::path::posix::basename(path);
        if ours != expected {
            mismatches.add(format!("basename({path:?})"), ours, expected);
        }
    }
    for (parts, expected) in joins.iter().zip(section(&reply, "posixJoin")) {
        let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
        let ours = garcon_js::path::posix::join(&refs);
        if ours != string(expected) {
            mismatches.add(format!("join({parts:?})"), ours, string(expected));
        }
    }
    for ((cwd, parts), expected) in resolves.iter().zip(section(&reply, "posixResolve")) {
        let refs: Vec<&str> = parts.iter().map(String::as_str).collect();
        let ours = garcon_js::path::posix::resolve(cwd, &refs);
        if ours != string(expected) {
            mismatches.add(format!("resolve({parts:?})"), ours, string(expected));
        }
    }
    for ((cwd, from, to), expected) in relatives.iter().zip(section(&reply, "posixRelative")) {
        let ours = garcon_js::path::posix::relative(cwd, from, to);
        if ours != string(expected) {
            mismatches.add(
                format!("relative({from:?}, {to:?})"),
                ours,
                string(expected),
            );
        }
    }
    mismatches.finish("path.posix", paths.len());
}

#[test]
fn win32_paths_match_bun() {
    let mut rng = Rng(0x5851_F42D_4C95_7F2D);
    let paths = sample_paths(&mut rng, 40_000);
    let reply = ask(json!({
        "win32IsAbsolute": paths, "win32Normalize": paths,
        "win32Dirname": paths, "win32ParseRoot": paths,
    }));
    let mut mismatches = Mismatches::new();
    let absolutes = section(&reply, "win32IsAbsolute");
    let normalized = section(&reply, "win32Normalize");
    let dirnames = section(&reply, "win32Dirname");
    let roots = section(&reply, "win32ParseRoot");
    for (index, path) in paths.iter().enumerate() {
        let ours = garcon_js::path::win32::is_absolute(path);
        if Some(ours) != absolutes[index].as_bool() {
            mismatches.add(
                format!("win32.isAbsolute({path:?})"),
                ours,
                &absolutes[index],
            );
        }
        let ours = garcon_js::path::win32::normalize(path);
        if ours != string(&normalized[index]) {
            mismatches.add(
                format!("win32.normalize({path:?})"),
                ours,
                string(&normalized[index]),
            );
        }
        let ours = garcon_js::path::win32::dirname(path);
        if ours != string(&dirnames[index]) {
            mismatches.add(
                format!("win32.dirname({path:?})"),
                ours,
                string(&dirnames[index]),
            );
        }
        let ours = garcon_js::path::win32::parse_root(path);
        if ours != string(&roots[index]) {
            mismatches.add(
                format!("win32.parse({path:?}).root"),
                ours,
                string(&roots[index]),
            );
        }
    }
    mismatches.finish("path.win32", paths.len());
}

/// A JSON number text in one of the forms a producer may write.
fn random_number_text(rng: &mut Rng) -> String {
    let digits = 1 + rng.below(24);
    let mut number: String = (0..digits)
        .map(|_| char::from(b'0' + rng.below(10) as u8))
        .collect();
    let negative = rng.below(2) == 0;
    if negative {
        number.insert(0, '-');
    }
    if rng.below(3) != 0 {
        let point = rng.below(digits + 1);
        number.insert(point + usize::from(negative), '.');
    }
    if rng.below(3) != 0 {
        let exponent = rng.below(420) as i64 - 210;
        number.push(if rng.below(2) == 0 { 'e' } else { 'E' });
        number.push_str(&exponent.to_string());
    }
    number
}

#[test]
fn json_round_trips_as_bun_round_trips_it() {
    let mut rng = Rng(0x1405_7B7E_F767_814F);
    let keys = [
        "1",
        "10",
        "2",
        "01",
        "x",
        "b",
        "4294967294",
        "4294967295",
        "0",
        "-1",
        "1.5",
        "a",
        "9007199254740990",
    ];
    let mut texts: Vec<String> = Vec::new();
    for _ in 0..12_000 {
        let members = 1 + rng.below(7);
        let mut members_text: Vec<String> = Vec::new();
        for _ in 0..members {
            let key = rng.pick(&keys);
            let number = random_number_text(&mut rng);
            members_text.push(match rng.below(7) {
                0 => format!("\"{key}\":{number}"),
                1 => format!("\"{key}\":\"{}\"", rng.pick(&keys)),
                2 => format!("\"{key}\":{}", rng.below(2) == 0),
                3 => format!("\"{key}\":null"),
                4 => format!("\"{key}\":[{number},\"s\"]"),
                5 => format!("\"{key}\":{{\"9\":{number},\"z\":{{}}}}"),
                _ => format!("\"{key}\":{{}}"),
            });
        }
        texts.push(format!("{{{}}}", members_text.join(",")));
        let numbers = (0..1 + rng.below(5))
            .map(|_| random_number_text(&mut rng))
            .collect::<Vec<_>>();
        texts.push(format!("[{}]", numbers.join(",")));
    }
    // Numbers at and beyond the limits of the notations JavaScript chooses.
    for number in [
        "1.0",
        "1E2",
        "3.0e0",
        "-0",
        "0.5",
        "1e15",
        "1e16",
        "1e17",
        "1e18",
        "1e19",
        "1e20",
        "9999999999999999",
        "9007199254740991",
        "9007199254740992",
        "9007199254740993",
        "18446744073709551615",
        "18446744073709551616",
        "99999999999999999999",
        "1234567890123456768",
        "1234567890123456800",
        "999999999999999999999",
        "1e21",
        "1.5e21",
        "1e22",
        "1.7976931348623157e308",
        "1e-6",
        "1e-7",
        "5e-324",
        "1695883772318900.2",
        "8578e-74",
        "2.6534099E-127",
        "286687.77204225e-205",
    ] {
        texts.push(format!("[{number}]"));
    }
    texts.extend([
        "{\"b\":1,\"10\":2,\"a\":3,\"1\":4,\"01\":5,\"x\":6}".to_owned(),
        "{\"a\":1,\"b\":2,\"a\":3}".to_owned(),
        "\"\\u2028\\t\\u001f\\\"\\\\\\/é😀\"".to_owned(),
        "[1,2.5,true,false,null,\"s\",{\"z\":{},\"a\":[]}]".to_owned(),
    ]);
    // Every sample is within the `f64` range: a number beyond it is a known
    // difference, where the original reads an infinity and prints `null`.
    let reply = ask(json!({ "jsonRoundTrip": texts }));
    let mut mismatches = Mismatches::new();
    let mut checked = 0;
    for (text, item) in texts.iter().zip(section(&reply, "jsonRoundTrip")) {
        checked += 1;
        let ours = from_str::<Opaque>(text).map(|opaque| serde_json::to_string(&opaque).unwrap());
        let matches = match (&ours, outcome(item)) {
            (Ok(actual), Ok(expected)) => actual == expected,
            // The JSON helper returns serde diagnostics. The server translates
            // them to its own errors rather than publishing Bun syntax text.
            (Err(error), Err(("SyntaxError", _))) => error.is_syntax() || error.is_eof(),
            _ => false,
        };
        if !matches {
            mismatches.add(format!("JSON {text}"), ours, item);
        }
    }
    mismatches.finish("JSON.parse then JSON.stringify", checked);
}

/// Replays the recorded `String(x)` of the original for every bit pattern in
/// `tests/fixtures/number-to-string.jsonl`.
#[test]
fn replays_the_recorded_number_output_of_the_original() {
    let fixture = include_str!("fixtures/number-to-string.jsonl");
    let mut checked = 0;
    let mut mismatches = Mismatches::new();
    for line in fixture.lines().filter(|line| !line.is_empty()) {
        let recorded: Value = garcon_js::json::parse(line).unwrap();
        let bits = u64::from_str_radix(recorded["bits"].as_str().unwrap(), 16).unwrap();
        let ours = number_to_string(f64::from_bits(bits));
        let theirs = recorded["output"].as_str().unwrap();
        if ours != theirs {
            mismatches.add(format!("{bits:016x}"), ours, theirs);
        }
        checked += 1;
    }
    assert_eq!(checked, 2290);
    mismatches.finish("number_to_string against the fixture", checked);
}

#[test]
fn iso_dates_and_default_sort_match_bun() {
    let mut rng = Rng(0x27BB_2EE6_87B9_B2D1);
    let mut milliseconds: Vec<i64> = vec![
        0,
        -1,
        1,
        1_000_000_000_123,
        -1_000_000_000_001,
        951_782_400_000,
        1_709_164_800_000,
        253_402_300_799_999,
        253_402_300_800_000,
        -62_198_755_200_000,
        -62_198_755_200_001,
        -62_198_755_136_000,
        8_640_000_000_000_000,
        -8_640_000_000_000_000,
        8_640_000_000_000_001,
        -8_640_000_000_000_001,
        86_399_999,
        86_400_000,
        -86_400_000,
        31_536_000_000,
        1_000,
    ];
    for _ in 0..30_000 {
        let magnitude = rng.next() % 9_000_000_000_000_000;
        milliseconds.push(if rng.below(2) == 0 {
            magnitude as i64
        } else {
            -(magnitude as i64)
        });
    }
    let encoded: Vec<String> = milliseconds.iter().map(i64::to_string).collect();
    let alphabet: Vec<char> =
        "abAB\\~\u{e9}\u{ff5e}\u{1f600}\u{e000}\u{5c}\u{10000}\u{d7ff}0\u{3000}"
            .chars()
            .collect();
    let mut groups: Vec<Vec<String>> = Vec::new();
    for _ in 0..2_000 {
        let length = 2 + rng.below(12);
        groups.push(
            (0..length)
                .map(|_| (*rng.pick(&alphabet)).to_string())
                .collect(),
        );
    }
    let reply = ask(json!({ "iso": encoded, "defaultSort": groups }));
    let mut mismatches = Mismatches::new();
    for (value, item) in milliseconds.iter().zip(section(&reply, "iso")) {
        let ours =
            garcon_js::to_iso_string(*value).map_err(|error| ("RangeError", error.to_string()));
        let actual = ours
            .as_ref()
            .map(String::as_str)
            .map_err(|(name, message)| (*name, message.as_str()));
        if actual != outcome(item) {
            mismatches.add(format!("toISOString({value})"), ours, item);
        }
    }
    for (group, sorted) in groups.iter().zip(section(&reply, "defaultSort")) {
        let mut ours = group.clone();
        ours.sort_by(|left, right| utf16::cmp(left, right));
        let theirs: Vec<&str> = sorted.as_array().unwrap().iter().map(string).collect();
        if ours != theirs {
            mismatches.add(format!("sort({group:?})"), ours, theirs);
        }
    }
    mismatches.finish("toISOString and default sort", milliseconds.len());
}

#[test]
fn windows_lexical_storage_paths_match_bun() {
    use garcon_js::path::win32;

    let basenames = [
        r"C:\workspace\state.json",
        "c:",
        r"\\server\share",
        r"\root\",
        "file.json",
        "",
    ];
    let joins: &[&[&str]] = &[
        &[r"C:\workspace", ".state.json.42.tmp"],
        &[r"\\server\share", "..", "outside"],
        &["//server", "share", "file"],
        &["//", "server", "share"],
        &["", "", ""],
    ];
    let resolve: &[(&str, &[&str])] = &[
        (r"C:\workspace", &[r"..\documents", "file.json"]),
        (r"C:\workspace", &[r"\outside\name"]),
        (r"C:\workspace", &[r"c:inside\..\file"]),
        (r"C:\workspace", &[r"D:\root", r"\subfolder"]),
        (r"\\server\share\workspace", &[r"..\a"]),
        (env!("CARGO_MANIFEST_DIR"), &[r"d:elsewhere"]),
    ];
    let relative = [
        (r"C:\workspace", r"C:\workspace", r"c:\WORKSPACE\inside"),
        (r"C:\workspace", r"C:\workspace", r"C:\outside"),
        (r"C:\workspace", r"C:\workspace", r"D:\outside"),
        (
            r"\\server\share",
            r"\\server\share\a\b",
            r"\\SERVER\share\a\c",
        ),
        (r"\\server\share", r"\\server\share\a", r"\\server\other\a"),
        (r"C:\workspace", r"C:\", r"C:\workspace"),
    ];
    let reply = ask(json!({
        "win32Basename": basenames, "win32Join": joins,
        "win32Resolve": resolve, "win32Relative": relative
    }));
    for (input, expected) in basenames.into_iter().zip(section(&reply, "win32Basename")) {
        assert_eq!(win32::basename(input), string(expected), "{input:?}");
    }
    for (input, expected) in joins.iter().zip(section(&reply, "win32Join")) {
        assert_eq!(win32::join(input), string(expected), "{input:?}");
    }
    for ((cwd, input), expected) in resolve.iter().zip(section(&reply, "win32Resolve")) {
        assert_eq!(win32::resolve(cwd, input), string(expected), "{input:?}");
    }
    for ((cwd, from, to), expected) in relative.into_iter().zip(section(&reply, "win32Relative")) {
        assert_eq!(
            win32::relative(cwd, from, to),
            string(expected),
            "{from:?} to {to:?}"
        );
    }
}

#[test]
fn windows_generated_lexical_paths_match_bun() {
    use garcon_js::path::win32;

    let mut rng = Rng(0x08a3_75b1_4f87_fead);
    let mut basenames = sample_paths(&mut rng, 12_000);
    let letters = [
        "a", "A", "\u{c4}", "\u{e4}", "\u{130}", "i", "\u{df}", "\u{1e9e}", "\u{3a3}", "\u{3c3}",
        "\u{3c2}", "\u{212a}", "K", "k",
    ];
    let separators = ["/", "\\", "/\\", "\\/"];
    let mut relative = Vec::new();
    let mut joins = Vec::new();
    let mut resolves = Vec::new();

    for a in letters {
        for b in letters {
            for sep in separators {
                let drive_root = format!("C:{sep}{a}");
                let drive_target = format!("c:{sep}{b}");
                let unc_root = format!("//{a}{sep}share");
                let unc_target = format!("\\\\{b}{sep}SHARE");
                for (from, to) in [(&drive_root, &drive_target), (&unc_root, &unc_target)] {
                    relative.push((from.clone(), to.clone()));
                    relative.push((from.clone(), format!("{to}{sep}child")));
                    relative.push((format!("{from}{sep}old"), format!("{to}{sep}new")));
                    joins.push(vec![
                        from.clone(),
                        format!("{b}{sep}."),
                        String::from(".."),
                        to.clone(),
                    ]);
                    resolves.push((
                        from.clone(),
                        vec![
                            String::from("branch"),
                            to.clone(),
                            format!("{sep}root"),
                            a.to_owned(),
                        ],
                    ));
                    basenames.push(format!("{from}{sep}{b}{sep}"));
                }
                resolves.push((
                    drive_root,
                    vec![format!("c:{b}"), a.to_owned(), String::from("..")],
                ));
            }
        }
    }
    for _ in 0..12_000 {
        let a = rng.pick(&letters);
        let b = rng.pick(&letters);
        let sep = rng.pick(&separators);
        let c = rng.pick(&letters);
        let root = match rng.below(4) {
            0 => format!("C:{sep}{a}"),
            1 => format!("d:{sep}{a}"),
            2 => format!("//{a}{sep}share"),
            _ => format!("\\\\host\\{a}"),
        };
        let target = match rng.below(4) {
            0 => format!("c:{sep}{b}{sep}{c}"),
            1 => format!("D:{sep}{b}"),
            2 => format!("\\\\{b}{sep}share{sep}{c}"),
            _ => format!("//HOST/{b}"),
        };
        let path = format!("{a}{sep}..{sep}{b}{sep}{c}");
        basenames.push(format!("{root}{sep}{path}{sep}"));
        relative.push((format!("{root}{sep}{c}"), target));
        resolves.push((
            root.clone(),
            vec![path.clone(), format!("{sep}{b}{sep}.."), a.to_string()],
        ));
        joins.push(vec![root, path, format!("{sep}{c}"), String::from("..")]);
    }

    let cwd = r"C:\synthetic\base";
    let relative: Vec<_> = relative.into_iter().map(|(a, b)| (cwd, a, b)).collect();
    let reply = ask(json!({
        "win32Basename": basenames, "win32Join": joins,
        "win32Resolve": resolves, "win32Relative": relative,
    }));
    let mut differences = Mismatches::new();
    for (input, answer) in basenames.iter().zip(section(&reply, "win32Basename")) {
        let actual = win32::basename(input);
        if actual != string(answer) {
            differences.add(format!("win32.basename({input:?})"), actual, answer);
        }
    }
    for (parts, answer) in joins.iter().zip(section(&reply, "win32Join")) {
        let parts: Vec<_> = parts.iter().map(String::as_str).collect();
        let actual = win32::join(&parts);
        if actual != string(answer) {
            differences.add(format!("win32.join({parts:?})"), actual, answer);
        }
    }
    for ((cwd, parts), answer) in resolves.iter().zip(section(&reply, "win32Resolve")) {
        let parts: Vec<_> = parts.iter().map(String::as_str).collect();
        let actual = win32::resolve(cwd, &parts);
        if actual != string(answer) {
            differences.add(format!("win32.resolve({cwd:?}, {parts:?})"), actual, answer);
        }
    }
    for ((cwd, from, to), answer) in relative.iter().zip(section(&reply, "win32Relative")) {
        let actual = win32::relative(cwd, from, to);
        if actual != string(answer) {
            differences.add(format!("win32.relative({from:?}, {to:?})"), actual, answer);
        }
    }
    let checked = basenames.len() + joins.len() + resolves.len() + relative.len();
    assert_eq!(section(&reply, "win32Basename").len(), basenames.len());
    assert_eq!(section(&reply, "win32Join").len(), joins.len());
    assert_eq!(section(&reply, "win32Resolve").len(), resolves.len());
    assert_eq!(section(&reply, "win32Relative").len(), relative.len());
    eprintln!("win32 generated comparisons: {checked}");
    differences.finish("path.win32 lexical", checked);
}

#[test]
fn number_classes_match_bun() {
    let mut rng = Rng(0x5DEE_CE66_D1CE_5E1D);
    let values = sample_doubles(&mut rng, 40_000);
    let bits: Vec<String> = values.iter().map(|value| bits_of(*value)).collect();
    let reply = ask(json!({ "numberClass": bits }));
    let mut mismatches = Mismatches::new();
    for (value, item) in values.iter().zip(section(&reply, "numberClass")) {
        let ours = [
            garcon_js::is_integer(*value),
            garcon_js::is_safe_integer(*value),
            garcon_js::is_finite_number(*value),
        ];
        let theirs: Vec<bool> = item
            .as_array()
            .unwrap()
            .iter()
            .map(Value::as_bool)
            .map(|flag| flag.unwrap())
            .collect();
        if ours != theirs[..] {
            mismatches.add(format!("{value:?} ({})", bits_of(*value)), ours, theirs);
        }
    }
    mismatches.finish("Number.isInteger, isSafeInteger, isFinite", values.len());
}
