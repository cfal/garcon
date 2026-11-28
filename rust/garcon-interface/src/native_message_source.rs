//! Ports `server-agents/interface/src/native-message-source.ts`.

use garcon_js::{Number, is_integer, is_safe_integer, trim};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMessageSource {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_number: Option<Number>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub byte_offset: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub within_source_ordinal: Option<u64>,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct NativeMessageSourceInput<'a> {
    pub entry_id: Option<&'a str>,
    pub line_number: Option<f64>,
    pub byte_offset: Option<f64>,
    pub within_source_ordinal: Option<f64>,
}

/// Carries the original's non-enumerable symbol separately from the message JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NativeSourced<T> {
    pub value: T,
    #[serde(skip)]
    source: Option<NativeMessageSource>,
}

impl<T> NativeSourced<T> {
    pub fn new(value: T) -> Self {
        Self {
            value,
            source: None,
        }
    }
}

pub fn attach_native_message_source<'a, T>(
    target: &'a mut NativeSourced<T>,
    source: Option<NativeMessageSourceInput<'_>>,
) -> &'a mut NativeSourced<T> {
    if let Some(source) = source.and_then(normalize_source) {
        target.source = Some(source);
    }
    target
}

pub fn attach_native_source_to_messages<'a, T>(
    messages: &'a mut [NativeSourced<T>],
    source: Option<NativeMessageSourceInput<'_>>,
) -> &'a mut [NativeSourced<T>] {
    for message in &mut *messages {
        attach_native_message_source(message, source);
    }
    messages
}

pub fn get_native_message_source<T>(target: &NativeSourced<T>) -> Option<NativeMessageSource> {
    let mut source = get_native_message_revision_source(target)?;
    source.within_source_ordinal = None;
    Some(source)
}

pub fn get_native_message_revision_source<T>(
    target: &NativeSourced<T>,
) -> Option<NativeMessageSource> {
    target.source.clone()
}

fn normalize_source(input: NativeMessageSourceInput<'_>) -> Option<NativeMessageSource> {
    let entry_id = input.entry_id.filter(|text| !trim(text).is_empty());
    let line_number = input
        .line_number
        .filter(|&number| is_integer(number) && number > 0.0)
        .map(Number);
    let byte_offset = input.byte_offset.and_then(non_negative_safe_integer);
    let within_source_ordinal = input
        .within_source_ordinal
        .and_then(non_negative_safe_integer);
    if entry_id.is_none()
        && line_number.is_none()
        && byte_offset.is_none()
        && within_source_ordinal.is_none()
    {
        return None;
    }
    Some(NativeMessageSource {
        entry_id: entry_id.map(str::to_owned),
        line_number,
        byte_offset,
        within_source_ordinal,
    })
}

fn non_negative_safe_integer(number: f64) -> Option<u64> {
    (is_safe_integer(number) && number >= 0.0).then_some(number as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retains_the_zero_byte_offset_of_a_source_file_first_record() {
        let mut message = NativeSourced::new("first");
        attach_native_message_source(
            &mut message,
            Some(NativeMessageSourceInput {
                line_number: Some(1.0),
                byte_offset: Some(0.0),
                ..Default::default()
            }),
        );
        assert_eq!(
            get_native_message_source(&message),
            Some(NativeMessageSource {
                entry_id: None,
                line_number: Some(Number(1.0)),
                byte_offset: Some(0),
                within_source_ordinal: None,
            }),
        );
    }
}
