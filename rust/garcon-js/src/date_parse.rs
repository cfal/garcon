//! Bun's Date.parse, local Date fields, and Intl calendar days.
//!
//! Offsets come from bundled IANA tzdb, not Bun's ICU data. They may differ
//! where the datasets have different historical or recent transitions.
//! For example, 1900-01-01T00:00Z in Europe/Amsterdam has local time
//! 00:19:32 in tzdb 2026b and 00:00:00 in Bun 1.4.3.
//! An unset TZ uses the host's detected IANA name, or UTC when no name can be
//! found. Like Bun, this does not interpret TZ as a POSIX rule string or as a
//! path to a zoneinfo file. An unrecognized process TZ falls back to UTC;
//! this does not emulate ICU's host-dependent fallback. As with other Rust
//! string helpers, a lone UTF-16 surrogate is not a representable input. Bun
//! can also fold vertical tabs in a Latin-1 string stored internally as UTF-16;
//! the port selects the fold by the characters present, not the storage.

mod parser;
#[cfg(test)]
mod tests;

use std::fmt;

use tz::TimeZoneRef;
use tz::datetime::{DateTime, FoundDateTimeKind};

use crate::clock::civil_from_days;

const DAY_MS: i64 = 86_400_000;
const DATE_LIMIT: i64 = 8_640_000_000_000_000;

fn valid_date(epoch_ms: i64) -> bool {
    epoch_ms.unsigned_abs() <= DATE_LIMIT as u64
}

/// Parses a date string as Bun's Date.parse does. None is JavaScript's NaN.
pub fn date_parse(text: &str) -> Option<i64> {
    let (wall_ms, offset_ms) = parser::parse(text)?;
    let utc_ms = match offset_ms {
        Some(offset) => wall_ms.checked_sub(offset)?,
        None => {
            if wall_ms.unsigned_abs() > (DATE_LIMIT + 30 * DAY_MS) as u64 {
                return None;
            }
            local_wall_time_to_utc(wall_ms, process_time_zone())?
        }
    };
    valid_date(utc_ms).then_some(utc_ms)
}

fn local_wall_time_to_utc(wall_ms: i64, zone: TimeZoneRef<'_>) -> Option<i64> {
    let fields = calendar_fields(wall_ms, 0);
    let mut first = [None; 1];
    let found = DateTime::find_n(
        &mut first,
        fields.year as i32,
        fields.month + 1,
        fields.day,
        fields.hour,
        fields.minute,
        fields.second,
        u32::from(fields.millisecond) * 1_000_000,
        zone,
    )
    .ok()?;
    // Uses the earlier instant in a fold and the pre-transition offset in a gap.
    match found.data().first().copied().flatten()? {
        FoundDateTimeKind::Normal(date) => {
            Some(date.unix_time() * 1000 + i64::from(fields.millisecond))
        }
        FoundDateTimeKind::Skipped {
            before_transition, ..
        } => Some(wall_ms - i64::from(before_transition.local_time_type().ut_offset()) * 1000),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalCalendarFields {
    pub year: i64,
    /// Zero-based, like Date.getMonth().
    pub month: u8,
    pub day: u8,
    /// Sunday is zero, like Date.getDay().
    pub weekday: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
    pub millisecond: u16,
    /// UTC minus local time in minutes, like Date.getTimezoneOffset().
    pub timezone_offset: i32,
}

/// Returns the local Date fields for an epoch millisecond instant.
pub fn local_calendar_fields(epoch_ms: i64) -> Option<LocalCalendarFields> {
    valid_date(epoch_ms).then_some(())?;
    let offset = offset_seconds(process_time_zone(), epoch_ms)?;
    Some(calendar_fields(epoch_ms, offset))
}

fn calendar_fields(epoch_ms: i64, offset_seconds: i32) -> LocalCalendarFields {
    let local_ms = epoch_ms + i64::from(offset_seconds) * 1000;
    let days = local_ms.div_euclid(DAY_MS);
    let time = local_ms.rem_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    LocalCalendarFields {
        year,
        month: month as u8 - 1,
        day: day as u8,
        weekday: (days + 4).rem_euclid(7) as u8,
        hour: (time / 3_600_000) as u8,
        minute: (time / 60_000 % 60) as u8,
        second: (time / 1_000 % 60) as u8,
        millisecond: (time % 1_000) as u16,
        timezone_offset: -offset_seconds / 60,
    }
}

fn offset_seconds(zone: TimeZoneRef<'_>, epoch_ms: i64) -> Option<i32> {
    Some(
        zone.find_local_time_type(epoch_ms.div_euclid(1000))
            .ok()?
            .ut_offset(),
    )
}

fn named_zone(name: &str) -> Option<TimeZoneRef<'static>> {
    // ICU keeps these aliases after their removal from IANA.
    if name.eq_ignore_ascii_case("US/Pacific-New") {
        return tzdb::tz_by_name("America/Los_Angeles");
    }
    if name.eq_ignore_ascii_case("Canada/East-Saskatchewan") {
        return tzdb::tz_by_name("America/Regina");
    }
    if name.eq_ignore_ascii_case("Factory") {
        return None;
    }
    tzdb::tz_by_name(name)
}

fn process_time_zone() -> TimeZoneRef<'static> {
    let Some(name) = std::env::var_os("TZ") else {
        return tzdb::local_tz().unwrap_or_else(TimeZoneRef::utc);
    };
    let Some(name) = name.to_str() else {
        return TimeZoneRef::utc();
    };
    let name = name.strip_prefix(':').unwrap_or(name);
    if let Some(zone) = named_zone(name) {
        return zone;
    }
    // ICU's three-letter compatibility names apply to the process default,
    // but Intl rejects them as explicitly supplied zone names.
    let alias = match name.to_ascii_uppercase().as_str() {
        "ACT" => "Australia/Darwin",
        "AET" => "Australia/Sydney",
        "AGT" => "America/Argentina/Buenos_Aires",
        "ART" => "Africa/Cairo",
        "AST" => "America/Anchorage",
        "BET" => "America/Sao_Paulo",
        "BST" => "Asia/Dhaka",
        "CAT" => "Africa/Maputo",
        "CNT" => "America/St_Johns",
        "CST" => "America/Chicago",
        "CTT" => "Asia/Shanghai",
        "EAT" => "Africa/Nairobi",
        "ECT" => "Europe/Paris",
        "IET" => "America/Indiana/Indianapolis",
        "IST" => "Asia/Kolkata",
        "JST" => "Asia/Tokyo",
        "MIT" => "Pacific/Apia",
        "NET" => "Asia/Yerevan",
        "NST" => "Pacific/Auckland",
        "PLT" => "Asia/Karachi",
        "PNT" => "America/Phoenix",
        "PRT" => "America/Puerto_Rico",
        "PST" => "America/Los_Angeles",
        "SST" => "Pacific/Guadalcanal",
        "VST" => "Asia/Ho_Chi_Minh",
        _ => return TimeZoneRef::utc(),
    };
    tzdb::tz_by_name(alias).unwrap_or_else(TimeZoneRef::utc)
}

/// A zone accepted by Intl.DateTimeFormat('en-US', { timeZone }).
#[derive(Clone, Copy, Debug)]
pub struct IntlTimeZone(Zone);

#[derive(Clone, Copy, Debug)]
enum Zone {
    Offset(i32),
    Iana(TimeZoneRef<'static>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidTimeZone(String);

impl fmt::Display for InvalidTimeZone {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "invalid time zone: {}", self.0)
    }
}

impl std::error::Error for InvalidTimeZone {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidCalendarInstant;

impl fmt::Display for InvalidCalendarInstant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("date value is not finite in DateTimeFormat formatToParts()")
    }
}

impl std::error::Error for InvalidCalendarInstant {}

/// Numeric Gregorian date parts as formatted by Intl with 'en-US' and 'latn'.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CalendarDay {
    /// Year of era, not the astronomical year: 1 BCE is 1.
    pub year: u64,
    pub month: u8,
    pub day: u8,
}

impl fmt::Display for CalendarDay {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

impl IntlTimeZone {
    pub fn parse(name: &str) -> Result<Self, InvalidTimeZone> {
        let zone = match name.as_bytes().first() {
            Some(b'+' | b'-') => parse_offset(name).map(Zone::Offset),
            _ => named_zone(name).map(Zone::Iana),
        };
        zone.map(Self)
            .ok_or_else(|| InvalidTimeZone(name.to_owned()))
    }

    pub fn calendar_day(self, epoch_ms: i64) -> Result<CalendarDay, InvalidCalendarInstant> {
        if !valid_date(epoch_ms) {
            return Err(InvalidCalendarInstant);
        }
        let offset = match self.0 {
            Zone::Offset(seconds) => seconds,
            Zone::Iana(zone) => offset_seconds(zone, epoch_ms).ok_or(InvalidCalendarInstant)?,
        };
        let days = (epoch_ms + i64::from(offset) * 1000).div_euclid(DAY_MS);
        let (year, month, day) = civil_from_days(days);
        Ok(CalendarDay {
            year: if year > 0 {
                year as u64
            } else {
                1 + year.unsigned_abs()
            },
            month: month as u8,
            day: day as u8,
        })
    }
}

fn parse_offset(name: &str) -> Option<i32> {
    fn pair(a: u8, b: u8) -> Option<i32> {
        (a.is_ascii_digit() && b.is_ascii_digit())
            .then(|| i32::from(a - b'0') * 10 + i32::from(b - b'0'))
    }

    let (sign, hour, minute) = match *name.as_bytes() {
        [sign, a, b] => (sign, pair(a, b)?, 0),
        [sign, a, b, c, d] | [sign, a, b, b':', c, d] => (sign, pair(a, b)?, pair(c, d)?),
        _ => return None,
    };
    if hour > 23 || minute > 59 {
        return None;
    }
    let sign = if sign == b'-' { -1 } else { 1 };
    Some(sign * (hour * 60 + minute) * 60)
}
