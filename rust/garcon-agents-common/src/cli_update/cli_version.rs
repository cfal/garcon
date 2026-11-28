use std::{cmp::Ordering, sync::LazyLock};

use garcon_js::collation::Collation;
use regress::Regex;

static CLI_VERSION: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: The fixed ECMAScript expression is valid.
    Regex::with_flags(
        r"(?:^|[\s(])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?=[\s)]|$)",
        "m",
    )
    .expect("CLI version pattern")
});

static VERSION_PARTS: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: The fixed ECMAScript expression is valid.
    Regex::new(r"^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$").expect("version parts pattern")
});

pub fn parse_cli_version(output: &str) -> Option<&str> {
    Some(&output[CLI_VERSION.find(output)?.group(1)?])
}

pub fn is_cli_version(value: &str) -> bool {
    VERSION_PARTS.find(value).is_some()
}

pub fn compare_cli_versions(left: &str, right: &str) -> Option<f64> {
    let a = VERSION_PARTS.find(left)?;
    let b = VERSION_PARTS.find(right)?;
    for index in 1..=3 {
        let difference =
            decimal_number(&left[a.group(index)?]) - decimal_number(&right[b.group(index)?]);
        if difference != 0.0 {
            return Some(js_sign(difference));
        }
    }
    Some(
        match (
            a.group(4).map(|range| &left[range]),
            b.group(4).map(|range| &right[range]),
        ) {
            (left, right) if left == right => 0.0,
            (None, _) => 1.0,
            (_, None) => -1.0,
            (Some(left), Some(right)) => compare_prerelease(left, right),
        },
    )
}

fn decimal_number(value: &str) -> f64 {
    value.parse().unwrap_or(f64::NAN)
}

fn js_sign(value: f64) -> f64 {
    if value.is_nan() || value == 0.0 {
        value
    } else {
        value.signum()
    }
}

fn prerelease_number(value: &str) -> Option<f64> {
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| decimal_number(value))
}

fn compare_prerelease(left: &str, right: &str) -> f64 {
    let mut a = left.split('.');
    let mut b = right.split('.');
    loop {
        match (a.next(), b.next()) {
            (None, None) => return 0.0,
            (None, Some(_)) => return -1.0,
            (Some(_), None) => return 1.0,
            (Some(a), Some(b)) => match (prerelease_number(a), prerelease_number(b)) {
                (Some(a), Some(b)) if a != b => return js_sign(a - b),
                (Some(_), Some(_)) => {}
                (Some(_), None) => return -1.0,
                (None, Some(_)) => return 1.0,
                (None, None) => match Collation::english().compare(a, b) {
                    Ordering::Less => return -1.0,
                    Ordering::Greater => return 1.0,
                    Ordering::Equal => {}
                },
            },
        }
    }
}
