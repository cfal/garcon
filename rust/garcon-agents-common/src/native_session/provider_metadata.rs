//! Ports `server-agents/common/src/native-session/provider-metadata.ts`.

use garcon_interface::native_message_source::{NativeSourced, get_native_message_revision_source};
use garcon_js::json::Opaque;
use serde_json::{Map, Value};

pub fn provider_metadata<T>(message: &NativeSourced<T>) -> Option<Opaque> {
    let source = get_native_message_revision_source(message)?;
    let mut metadata = Map::new();
    if let Some(id) = source.entry_id {
        metadata.insert("entryId".to_owned(), Value::String(id));
    }
    if let Some(line) = source
        .line_number
        .and_then(|line| serde_json::Number::from_f64(line.0))
    {
        metadata.insert("lineNumber".to_owned(), Value::Number(line));
    }
    if let Some(offset) = source.byte_offset {
        metadata.insert("byteOffset".to_owned(), Value::from(offset));
    }
    if let Some(ordinal) = source.within_source_ordinal {
        metadata.insert("withinSourceOrdinal".to_owned(), Value::from(ordinal));
    }
    Some(Opaque::from_value(Value::Object(metadata)))
}
