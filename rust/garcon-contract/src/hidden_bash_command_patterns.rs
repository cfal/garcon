//! Ports common/hidden-bash-command-patterns.ts.

use std::collections::HashSet;

use garcon_js::{trim, utf16};
use serde::Serialize;
use serde_json::Value;

pub const HIDDEN_BASH_COMMAND_PATTERN_MODE_VALUES: [HiddenBashCommandPatternMode; 2] = [
    HiddenBashCommandPatternMode::Regex,
    HiddenBashCommandPatternMode::Glob,
];
pub const HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT: usize = 200;
pub const HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HiddenBashCommandPatternMode {
    Regex,
    Glob,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HiddenBashCommandPattern {
    pub pattern: String,
    pub mode: HiddenBashCommandPatternMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HiddenBashCommandPatternValidation {
    Ok,
    Empty,
    TooLong,
    InvalidRegex,
}

pub fn is_hidden_bash_command_pattern_mode(value: &Value) -> Option<HiddenBashCommandPatternMode> {
    match value.as_str()? {
        "regex" => Some(HiddenBashCommandPatternMode::Regex),
        "glob" => Some(HiddenBashCommandPatternMode::Glob),
        _ => None,
    }
}

pub fn validate_hidden_bash_command_pattern(
    pattern: &str,
    mode: HiddenBashCommandPatternMode,
) -> HiddenBashCommandPatternValidation {
    use HiddenBashCommandPatternValidation::{Empty, InvalidRegex, Ok, TooLong};
    if trim(pattern).is_empty() {
        return Empty;
    }
    if utf16::len(pattern) > HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH {
        return TooLong;
    }
    // Match Bun's UTF-16 parsing, but skip optimization for this syntax check.
    if mode == HiddenBashCommandPatternMode::Regex
        && regress::Regex::from_unicode(
            pattern.encode_utf16().map(u32::from),
            regress::Flags {
                no_opt: true,
                ..regress::Flags::default()
            },
        )
        .is_err()
    {
        return InvalidRegex;
    }
    Ok
}

pub fn dedupe_hidden_bash_command_patterns(
    patterns: &[HiddenBashCommandPattern],
) -> Vec<HiddenBashCommandPattern> {
    let mut seen = HashSet::new();
    patterns
        .iter()
        .filter(|entry| seen.insert((entry.mode, entry.pattern.as_str())))
        .cloned()
        .collect()
}

pub fn parse_hidden_bash_command_patterns(value: &Value) -> Option<Vec<HiddenBashCommandPattern>> {
    let value = value.as_array()?;
    if value.len() > HIDDEN_BASH_COMMAND_PATTERN_MAX_COUNT {
        return None;
    }
    let mut parsed = Vec::with_capacity(value.len());
    for entry in value {
        let entry = entry.as_object()?;
        let pattern = entry.get("pattern")?.as_str()?;
        let mode = is_hidden_bash_command_pattern_mode(entry.get("mode")?)?;
        if validate_hidden_bash_command_pattern(pattern, mode)
            != HiddenBashCommandPatternValidation::Ok
        {
            return None;
        }
        parsed.push(HiddenBashCommandPattern {
            pattern: pattern.to_owned(),
            mode,
        });
    }
    Some(dedupe_hidden_bash_command_patterns(&parsed))
}

#[cfg(test)]
mod tests {
    use super::HiddenBashCommandPatternMode::{Glob, Regex};
    use super::HiddenBashCommandPatternValidation::{Empty, InvalidRegex, Ok, TooLong};
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_valid_regex_and_glob_entries_without_changing_their_text() {
        let patterns = json!([
            {"pattern":"^git (status|log)","mode":"regex"},
            {"pattern":"  cargo *  ","mode":"glob"},
        ]);
        assert_eq!(
            json!(parse_hidden_bash_command_patterns(&patterns)),
            patterns
        );
    }

    #[test]
    fn deduplicates_exact_entries_globally_while_preserving_first_occurrence_order() {
        let patterns = json!([
            {"pattern":"git *","mode":"glob"},
            {"pattern":"^cargo","mode":"regex"},
            {"pattern":"git *","mode":"glob"},
            {"pattern":"git *","mode":"regex"},
            {"pattern":"^cargo","mode":"regex"},
        ]);
        let parsed = parse_hidden_bash_command_patterns(&patterns).unwrap();
        assert_eq!(
            json!(parsed),
            json!([&patterns[0], &patterns[1], &patterns[3]])
        );
        assert_eq!(dedupe_hidden_bash_command_patterns(&parsed), parsed);
    }

    #[test]
    fn rejects_malformed_lists_and_entries() {
        for value in [
            Value::Null,
            json!("git *"),
            json!([null]),
            json!([["git *"]]),
            json!([{}]),
            json!([{"pattern":42,"mode":"glob"}]),
            json!([{"pattern":"git *","mode":"shell"}]),
            json!([{"pattern":"","mode":"glob"}]),
            json!([{"pattern":"   ","mode":"regex"}]),
            json!([{"pattern":"([unclosed","mode":"regex"}]),
        ] {
            assert_eq!(parse_hidden_bash_command_patterns(&value), None, "{value}");
        }
    }

    #[test]
    fn enforces_raw_list_and_pattern_length_limits_at_their_boundaries() {
        let mut values: Vec<_> = (0..200)
            .map(|index| json!({"pattern":format!("command-{index}"),"mode":"glob"}))
            .collect();
        assert_eq!(
            parse_hidden_bash_command_patterns(&json!(values))
                .unwrap()
                .len(),
            200
        );
        values.push(values[0].clone());
        assert_eq!(parse_hidden_bash_command_patterns(&json!(values)), None);
        assert!(
            parse_hidden_bash_command_patterns(
                &json!([{"pattern":"\u{1f600}".repeat(500),"mode":"glob"}])
            )
            .is_some()
        );
        assert_eq!(
            parse_hidden_bash_command_patterns(
                &json!([{"pattern":"x".repeat(1_001),"mode":"glob"}])
            ),
            None
        );
    }

    #[test]
    fn reports_validation_failures_by_cause() {
        assert_eq!(validate_hidden_bash_command_pattern(" ", Glob), Empty);
        assert_eq!(
            validate_hidden_bash_command_pattern(&"x".repeat(1_001), Glob),
            TooLong
        );
        assert_eq!(
            validate_hidden_bash_command_pattern("([unclosed", Regex),
            InvalidRegex
        );
        assert_eq!(validate_hidden_bash_command_pattern("git *", Glob), Ok);
        assert_eq!(
            validate_hidden_bash_command_pattern(r"(?<=git )([a-z]+)\1", Regex),
            Ok
        );
        assert_eq!(
            validate_hidden_bash_command_pattern("[\u{1f600}-\u{1f601}]", Regex),
            InvalidRegex
        );
    }

    #[test]
    fn validates_long_regex_families_without_running_them() {
        let width = HIDDEN_BASH_COMMAND_PATTERN_MAX_LENGTH;
        let mut patterns = vec![
            (format!("[{}]", "ab".repeat((width - 2) / 2)), Ok),
            ("a|".repeat(width / 2), Ok),
            ("(a)".repeat(width / 3), Ok),
            (
                format!("{}a{}", "(".repeat(300), ")".repeat(300)),
                InvalidRegex,
            ),
            ("a{99999999}".repeat(width / 11), Ok),
        ];
        for group in ["(", "(?:"] {
            for depth in [1, 16, 32, 64, 100] {
                for suffix in ["){1,3}", ")+", ")?"] {
                    let mut pattern = group.repeat(depth);
                    pattern.push('a');
                    pattern.push_str(&suffix.repeat(depth));
                    pattern.push_str(&"z".repeat(width - pattern.len()));
                    patterns.push((pattern, Ok));
                }
            }
        }
        for (pattern, expected) in patterns {
            assert!(utf16::len(&pattern) <= width);
            assert_eq!(
                validate_hidden_bash_command_pattern(&pattern, Regex),
                expected
            );
        }
    }
}
