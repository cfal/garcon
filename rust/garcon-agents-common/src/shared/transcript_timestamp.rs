//! Ports `server-agents/common/src/shared/transcript-timestamp.ts`.

use garcon_js::clock::{InvalidTimeValue, to_iso_string};

const SOURCE_TIMESTAMP_EPOCH_MS: f64 = 946_684_800_000.0;
// A Date holds ±8.64e15 milliseconds.
const MAX_TIME_VALUE: f64 = 8_640_000_000_000_000.0;

/// A timestamp a transcript entry without one takes: the source epoch plus
/// its line number, or else its byte offset.
pub fn deterministic_transcript_timestamp(
    line_number: Option<f64>,
    byte_offset: Option<f64>,
) -> Result<String, InvalidTimeValue> {
    let source_position = line_number.or(byte_offset).unwrap_or(0.0);
    // `new Date(ms)` keeps a whole number of milliseconds and is invalid for any other value.
    let epoch_ms = (SOURCE_TIMESTAMP_EPOCH_MS + source_position).trunc();
    if !epoch_ms.is_finite() || epoch_ms.abs() > MAX_TIME_VALUE {
        return Err(InvalidTimeValue);
    }
    to_iso_string(epoch_ms as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_from_the_epoch_over_the_line_number_or_the_byte_offset() {
        assert_eq!(
            deterministic_transcript_timestamp(None, None).unwrap(),
            "2000-01-01T00:00:00.000Z"
        );
        assert_eq!(
            deterministic_transcript_timestamp(Some(1501.0), Some(9.0)).unwrap(),
            "2000-01-01T00:00:01.501Z"
        );
        assert_eq!(
            deterministic_transcript_timestamp(None, Some(61_000.0)).unwrap(),
            "2000-01-01T00:01:01.000Z"
        );
    }

    #[test]
    fn a_time_a_date_cannot_hold_is_invalid() {
        for (line_number, byte_offset) in [
            (Some(f64::NAN), None),
            (Some(f64::INFINITY), None),
            (Some(f64::NEG_INFINITY), None),
            (Some(9_000_000_000_000_000.0), None),
            (None, Some(-9_000_000_000_000_000.0)),
        ] {
            assert_eq!(
                deterministic_transcript_timestamp(line_number, byte_offset),
                Err(InvalidTimeValue),
                "{line_number:?} {byte_offset:?}"
            );
        }
    }
}
