use garcon_agents_common::{
    execution::{
        permission_modes::{is_manual_bypass_mode, provider_startup_permission_mode},
        runtime_events::runtime_rows,
    },
    native_session::provider_metadata::provider_metadata,
};
use garcon_cases::{CaseError, replay, round_tripped, text};
use garcon_contract::{
    chat_modes::PERMISSION_MODE_VALUES,
    chat_types::{AssistantMessage, ChatMessage},
};
use garcon_interface::native_message_source::{
    NativeMessageSourceInput, NativeSourced, attach_native_message_source,
};
use garcon_js::json::{as_number, from_slice};
use serde::Serialize;
use serde_json::{Value, json};

fn wire(value: impl Serialize) -> Result<Value, CaseError> {
    let bytes =
        serde_json::to_vec(&value).map_err(|error| CaseError::undeliverable(error.to_string()))?;
    from_slice(&bytes).map_err(|error| CaseError::undeliverable(error.to_string()))
}

fn source_input(raw: &Value) -> Result<Option<NativeMessageSourceInput<'_>>, CaseError> {
    if raw.is_null() {
        return Ok(None);
    }
    let object = raw
        .as_object()
        .ok_or_else(|| CaseError::undeliverable("expected a native message source"))?;
    let number = |key| {
        object
            .get(key)
            .map(|value| {
                as_number(value)
                    .ok_or_else(|| CaseError::undeliverable(format!("expected numeric {key}")))
            })
            .transpose()
    };
    let entry_id = object
        .get("entryId")
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| CaseError::undeliverable("expected text entryId"))
        })
        .transpose()?;
    Ok(Some(NativeMessageSourceInput {
        entry_id,
        line_number: number("lineNumber")?,
        byte_offset: number("byteOffset")?,
        within_source_ordinal: number("withinSourceOrdinal")?,
    }))
}

#[test]
fn recorded_permission_modes_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/permission-modes"),
        |function, args| {
            let mode = round_tripped(function, args.first())?
                .as_deref()
                .map(|mode| {
                    PERMISSION_MODE_VALUES
                        .iter()
                        .copied()
                        .find(|value| mode.as_str() == Some(value.as_str()))
                        .ok_or_else(|| {
                            CaseError::undeliverable("expected an original permission mode")
                        })
                })
                .transpose()?;
            match function {
                "isManualBypassMode" => Ok(json!(is_manual_bypass_mode(mode))),
                "providerStartupPermissionMode" => wire(provider_startup_permission_mode(mode)),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}

#[test]
fn recorded_provider_metadata_and_runtime_rows_match() {
    let stats = replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/provider-metadata"),
        |function, args| {
            let input = round_tripped(function, args.first())?
                .ok_or_else(|| CaseError::undeliverable("expected an explicit source or null"))?;
            let source = source_input(&input)?;
            match function {
                "metadataFor" => {
                    let mut message = NativeSourced::new(());
                    attach_native_message_source(&mut message, source);
                    wire(provider_metadata(&message))
                }
                "rowsFor" => {
                    let content = text(function, args.get(1))?.ok_or_else(|| {
                        CaseError::undeliverable("expected original assistant text")
                    })?;
                    let mut message =
                        NativeSourced::new(ChatMessage::Assistant(AssistantMessage {
                            timestamp: "2026-01-01T00:00:00Z".to_owned(),
                            content: content.to_owned(),
                            questions: None,
                        }));
                    attach_native_message_source(&mut message, source);
                    wire(runtime_rows([message]))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
    assert_eq!(stats.with_wildcards, 0);
}
