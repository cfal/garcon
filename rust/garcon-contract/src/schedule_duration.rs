//! Ports `common/schedule-duration.ts`.

use std::sync::LazyLock;

use garcon_js::{
    clock::{InvalidTimeValue, to_iso_string},
    is_safe_integer, trim,
};
use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::scheduled_prompts::SCHEDULED_PROMPT_INTERVAL_MINUTES_MAX;

pub const SCHEDULE_IN_MIN_DELAY_MINUTES: u64 = 1;
pub const SCHEDULE_IN_MAX_DELAY_MINUTES: u64 = 365 * 24 * 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScheduleDurationError {
    Missing,
    SubMinuteUnsupported,
    InvalidFormat,
    TooShort,
    TooLong,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScheduleDuration {
    pub ok: bool,
    pub minutes: u64,
}

pub type ScheduleDurationResult = Result<ScheduleDuration, ScheduleDurationError>;

static DURATION_RE: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the original's ASCII suffixes and digits form a valid pattern.
    Regex::new(r"^(?:([0-9]+)[dD])?(?:([0-9]+)[hH])?(?:([0-9]+)[mM])?$").expect("duration pattern")
});

pub fn parse_schedule_duration(token: &str) -> ScheduleDurationResult {
    parse_bounded_duration(token, SCHEDULE_IN_MAX_DELAY_MINUTES)
}

pub fn parse_schedule_interval(token: &str) -> ScheduleDurationResult {
    parse_bounded_duration(token, SCHEDULED_PROMPT_INTERVAL_MINUTES_MAX)
}

fn parse_bounded_duration(token: &str, maximum: u64) -> ScheduleDurationResult {
    let token = trim(token);
    if token.is_empty() {
        return Err(ScheduleDurationError::Missing);
    }
    if token.contains(['s', 'S']) {
        return Err(ScheduleDurationError::SubMinuteUnsupported);
    }
    let fields = DURATION_RE
        .captures(token)
        .ok_or(ScheduleDurationError::InvalidFormat)?;
    let number = |index| -> Result<f64, ScheduleDurationError> {
        fields.get(index).map_or(Ok(0.0), |field| {
            field
                .as_str()
                .parse()
                .map_err(|_| ScheduleDurationError::TooLong)
        })
    };
    let total = number(1)? * 1440.0 + number(2)? * 60.0 + number(3)?;
    if !is_safe_integer(total) {
        return Err(ScheduleDurationError::TooLong);
    }
    let minutes = total as u64;
    if minutes < SCHEDULE_IN_MIN_DELAY_MINUTES {
        return Err(ScheduleDurationError::TooShort);
    }
    if minutes > maximum {
        return Err(ScheduleDurationError::TooLong);
    }
    Ok(ScheduleDuration { ok: true, minutes })
}

pub fn schedule_in_run_at(now_ms: i64, delay_minutes: f64) -> Result<String, InvalidTimeValue> {
    let requested = now_ms as f64 + delay_minutes * 60_000.0;
    let rounded = (requested / 60_000.0).ceil() * 60_000.0;
    if !rounded.is_finite() {
        return Err(InvalidTimeValue);
    }
    to_iso_string(rounded as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use garcon_js::date_parse::date_parse;

    #[test]
    fn parses_single_and_ordered_compound_units_case_insensitively() {
        for (token, minutes) in [
            ("1m", 1),
            ("3h", 180),
            ("1d", 1440),
            ("2h30m", 150),
            ("1D4H15M", 1695),
            ("1d24h", 2880),
        ] {
            assert_eq!(parse_schedule_duration(token).unwrap().minutes, minutes);
        }
    }

    #[test]
    fn classifies_missing_sub_minute_malformed_and_zero_durations() {
        for (token, error) in [
            ("\u{a0}", ScheduleDurationError::Missing),
            ("1S", ScheduleDurationError::SubMinuteUnsupported),
            ("30m2h", ScheduleDurationError::InvalidFormat),
            ("\u{0661}m", ScheduleDurationError::InvalidFormat),
            ("0m", ScheduleDurationError::TooShort),
            ("365d1m", ScheduleDurationError::TooLong),
        ] {
            assert_eq!(parse_schedule_duration(token), Err(error));
        }
        assert_eq!(parse_schedule_duration("365d").unwrap().minutes, 525_600);
        assert_eq!(parse_schedule_interval("3650d").unwrap().minutes, 5_256_000);
    }

    #[test]
    fn rounds_up_without_mutating_the_input_date_or_firing_early() {
        for (input, expected) in [
            ("2026-07-10T12:00:00.000Z", "2026-07-10T12:01:00.000Z"),
            ("2026-07-10T12:00:45.000Z", "2026-07-10T12:02:00.000Z"),
        ] {
            assert_eq!(
                schedule_in_run_at(date_parse(input).unwrap(), 1.0).unwrap(),
                expected
            );
        }
    }
}
