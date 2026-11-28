use std::{collections::HashSet, process::Command};

use garcon_js::{collation::Collation, json::from_slice};
use serde::Deserialize;

fn oracle_command() -> Command {
    let mut command = Command::new("bun");
    command.arg(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/collation-oracle.ts"
    ));
    command
}

fn oracle<T: serde::de::DeserializeOwned>(mut command: Command) -> T {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    from_slice(&output.stdout).unwrap()
}

#[derive(Debug, PartialEq, Eq, Deserialize)]
struct LocaleProbe {
    locale: String,
    comparisons: Vec<i8>,
}

#[test]
fn bun_default_locale_is_independent_of_locale_environment() {
    let expected = LocaleProbe {
        locale: "en-US".to_owned(),
        comparisons: vec![-1, 1, -1, 0],
    };
    let probe = |variable: &str, locale: &str| {
        let mut command = oracle_command();
        command
            .arg("--locale")
            .env_remove("LANG")
            .env_remove("LC_ALL")
            .env_remove("LC_COLLATE");
        if !variable.is_empty() {
            command.env(variable, locale);
        }
        let actual: LocaleProbe = oracle(command);
        assert_eq!(actual, expected, "{variable}={locale}");
    };
    probe("", "");
    for variable in ["LANG", "LC_ALL", "LC_COLLATE"] {
        for locale in ["C", "en_US.UTF-8", "de_DE.UTF-8", "sv_SE.UTF-8"] {
            probe(variable, locale);
        }
    }
}

#[derive(Deserialize)]
struct Corpus {
    strings: Vec<String>,
    pairs: Vec<(usize, usize, i8, i8)>,
    malformed: Vec<(String, String, i8, i8)>,
    han: HashSet<char>,
}

#[test]
fn english_collations_match_bun() {
    let Corpus {
        strings,
        pairs,
        malformed,
        han,
    } = oracle(oracle_command());
    let count = strings.len();
    assert!(count >= 290);
    assert_eq!(pairs.len(), count * (count + 1) / 2);
    assert_eq!(malformed.len(), 4);

    let mut differences = 0;
    let mut diagnostics = Vec::new();
    let mut han_differences = [0; 2];
    let mut check = |left: &str, right: &str, standard, numeric| {
        for (mode, (name, collator, expected)) in [
            ("standard", Collation::english(), standard),
            ("numeric/base", Collation::english_numeric_base(), numeric),
        ]
        .into_iter()
        .enumerate()
        {
            let actual = collator.compare(left, right) as i8;
            if actual != expected {
                let first_difference = left.chars().zip(right.chars()).find(|(a, b)| a != b);
                // This Han-to-Han difference was accepted by the user on 2026-11-28.
                if first_difference.is_some_and(|(a, b)| han.contains(&a) && han.contains(&b)) {
                    han_differences[mode] += 1;
                } else {
                    differences += 1;
                    if diagnostics.len() < 20 {
                        diagnostics.push(format!(
                            "{name} {left:?} vs {right:?}: ICU4X {actual}, Bun {expected}"
                        ));
                    }
                }
            }
        }
    };
    let pairs_count = pairs.len();
    for (i, j, standard, numeric) in pairs {
        check(&strings[i], &strings[j], standard, numeric);
    }
    for (json, projected, standard, numeric) in malformed {
        let rust: String = from_slice(json.as_bytes()).unwrap();
        assert_eq!(rust, projected);
        check(&rust, "a", standard, numeric);
    }
    eprintln!(
        "{} pairs per mode; Han differences accepted by the user on 2026-11-28: {} standard, {} numeric/base",
        pairs_count + 4,
        han_differences[0],
        han_differences[1]
    );
    assert_eq!(
        differences,
        0,
        "unexpected collation differences (first 20):\n{}",
        diagnostics.join("\n")
    );
    assert!(
        han_differences.iter().all(|&count| count > 0),
        "oracle did not exercise the Han rule accepted by the user on 2026-11-28"
    );
}
