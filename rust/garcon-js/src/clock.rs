//! The clock the ported code reads, injected so tests control it, and the
//! formats JavaScript writes time in.

use std::cell::Cell;
use std::fmt;
use std::time::{SystemTime, UNIX_EPOCH};

/// The wall clock the original reads with `Date.now()` and `new Date()`.
pub trait Clock {
    /// `Date.now()`: milliseconds since the Unix epoch.
    fn now_ms(&self) -> i64;
}

/// The system wall clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        match SystemTime::now().duration_since(UNIX_EPOCH) {
            Ok(since_epoch) => i64::try_from(since_epoch.as_millis()).unwrap_or(i64::MAX),
            Err(before_epoch) => {
                -i64::try_from(before_epoch.duration().as_millis()).unwrap_or(i64::MAX)
            }
        }
    }
}

/// A clock that reads one value until a test moves it.
#[derive(Debug, Default)]
pub struct ManualClock(Cell<i64>);

impl ManualClock {
    pub fn new(now_ms: i64) -> ManualClock {
        ManualClock(Cell::new(now_ms))
    }

    /// Moves the clock to `now_ms`.
    pub fn set(&self, now_ms: i64) {
        self.0.set(now_ms);
    }

    /// Moves the clock forward by `milliseconds`.
    pub fn advance(&self, milliseconds: i64) {
        self.0.set(self.0.get() + milliseconds);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.get()
    }
}

impl<T: Clock + ?Sized> Clock for &'_ T {
    fn now_ms(&self) -> i64 {
        (**self).now_ms()
    }
}

/// `new Date(epochMs).toISOString()` was called on a time outside the range a
/// `Date` holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidTimeValue;

impl fmt::Display for InvalidTimeValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Invalid Date")
    }
}

impl std::error::Error for InvalidTimeValue {}

/// `Date.prototype.toISOString()`: `YYYY-MM-DDTHH:mm:ss.sssZ` with exactly
/// three fractional digits.
pub fn to_iso_string(epoch_ms: i64) -> Result<String, InvalidTimeValue> {
    // A Date holds ±8.64e15 milliseconds.
    if epoch_ms.unsigned_abs() > 8_640_000_000_000_000 {
        return Err(InvalidTimeValue);
    }
    let (year, month, day) = civil_from_days(epoch_ms.div_euclid(86_400_000));
    let time = epoch_ms.rem_euclid(86_400_000);
    let (hour, minute, second, millisecond) = (
        time / 3_600_000,
        time % 3_600_000 / 60_000,
        time % 60_000 / 1_000,
        time % 1_000,
    );
    let mut text = String::with_capacity(30);
    if (0..=9999).contains(&year) {
        text.push_str(&format!("{year:04}"));
    } else {
        // Years beyond four digits carry a sign and six digits.
        let sign = if year < 0 { '-' } else { '+' };
        text.push_str(&format!("{sign}{:06}", year.unsigned_abs()));
    }
    text.push_str(&format!(
        "-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millisecond:03}Z"
    ));
    Ok(text)
}

/// Splits a day count since the Unix epoch into a proleptic Gregorian date.
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    // Howard Hinnant's `civil_from_days`.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = month_index + if month_index < 10 { 3 } else { -9 };
    (
        if month <= 2 { year + 1 } else { year },
        month as u32,
        day as u32,
    )
}

thread_local! {
    /// Where `performance.now()` starts on this thread.
    static TIME_ORIGIN: Cell<Option<(tokio::time::Instant, SystemTime)>> = const { Cell::new(None) };
}

/// `performance.now()`: milliseconds on the monotonic clock the tokio timers
/// of the calling thread use, so a paused test clock moves it too.
pub fn performance_now_ms() -> f64 {
    let now = tokio::time::Instant::now();
    TIME_ORIGIN.with(|origin| {
        let started = origin.get().unwrap_or_else(|| {
            let started = (now, SystemTime::now());
            origin.set(Some(started));
            started
        });
        now.duration_since(started.0).as_secs_f64() * 1000.0
    })
}

/// `performance.timeOrigin`: the wall clock, in milliseconds since the Unix
/// epoch, at the moment `performance.now()` was zero.
pub fn performance_time_origin_ms() -> f64 {
    let now = tokio::time::Instant::now();
    TIME_ORIGIN.with(|origin| {
        let started = origin.get().unwrap_or_else(|| {
            let started = (now, SystemTime::now());
            origin.set(Some(started));
            started
        });
        match started.1.duration_since(UNIX_EPOCH) {
            Ok(since_epoch) => since_epoch.as_secs_f64() * 1000.0,
            Err(before_epoch) => -(before_epoch.duration().as_secs_f64() * 1000.0),
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_iso_timestamps_with_three_fractional_digits() {
        for (epoch_ms, expected) in [
            (0, "1970-01-01T00:00:00.000Z"),
            (1_000_000_000_123, "2001-09-09T01:46:40.123Z"),
            (-1, "1969-12-31T23:59:59.999Z"),
            (8_640_000_000_000_000, "+275760-09-13T00:00:00.000Z"),
            (-8_640_000_000_000_000, "-271821-04-20T00:00:00.000Z"),
            (951_782_400_000, "2000-02-29T00:00:00.000Z"),
            (1_709_164_800_000, "2024-02-29T00:00:00.000Z"),
        ] {
            assert_eq!(
                to_iso_string(epoch_ms),
                Ok(expected.to_owned()),
                "{epoch_ms}"
            );
        }
        assert_eq!(to_iso_string(8_640_000_000_000_001), Err(InvalidTimeValue));
        assert_eq!(to_iso_string(-8_640_000_000_000_001), Err(InvalidTimeValue));
        assert_eq!(InvalidTimeValue.to_string(), "Invalid Date");
    }

    #[test]
    fn manual_clock_reads_what_the_test_sets() {
        let clock = ManualClock::new(1_000);
        assert_eq!(clock.now_ms(), 1_000);
        clock.advance(250);
        assert_eq!(clock.now_ms(), 1_250);
        clock.set(5);
        assert_eq!(clock.now_ms(), 5);
    }

    #[test]
    fn performance_clock_starts_near_zero() {
        assert!(performance_now_ms() < 1_000.0);
        let origin = performance_time_origin_ms();
        assert!(origin > 1_600_000_000_000.0);
    }
}
