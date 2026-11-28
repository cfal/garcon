//! Registry-facing slice of `chats/carryover/segment-types.ts`. The carryover
//! unit ports the segment index/page types and parsers.

use serde_json::Value;

pub fn is_carry_over_segment_id(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, &byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            14 => matches!(byte, b'1'..=b'5'),
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b'),
            _ => matches!(byte, b'0'..=b'9' | b'a'..=b'f'),
        })
}
