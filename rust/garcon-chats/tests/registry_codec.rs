use std::rc::Rc;

use garcon_cases::{CaseError, markers, replay, round_tripped, unknown};
use garcon_chats::{
    carryover::segment_types::is_carry_over_segment_id,
    chat_id_allocator::{AllocationError, ChatIdAllocator},
    registry_entry_codec::{
        RegistryCodecError, normalize_chat_registry_entry, parse_carry_over_segment_refs,
    },
};
use garcon_contract::chat_id::{InvalidChatIdError, InvalidChatIdValue};
use garcon_js::{
    clock::ManualClock,
    json::{Opaque, from_str},
};
use serde::Serialize;
use serde_json::{Value, json};

fn value(item: &impl Serialize) -> Value {
    from_str(&serde_json::to_string(item).unwrap()).unwrap()
}

fn id_error(error: InvalidChatIdError) -> CaseError {
    let message = error.to_string();
    let detail = match error.value {
        InvalidChatIdValue::Undefined => markers::undefined(),
        InvalidChatIdValue::Number(number) => markers::number(number),
        InvalidChatIdValue::Json(json) => value(&json),
    };
    CaseError::new("InvalidChatIdError", message).with_property("value", detail)
}

fn codec_error(error: RegistryCodecError) -> CaseError {
    match error {
        RegistryCodecError::ChatId(error) => id_error(error),
        RegistryCodecError::Invalid(message) => CaseError::new("Error", message),
    }
}

fn read<T: serde::de::DeserializeOwned>(
    function: &str,
    arg: Option<&Value>,
) -> Result<T, CaseError> {
    let js = Opaque::from_value(unknown(function, arg)?.into_owned());
    from_str(&serde_json::to_string(&js).unwrap())
        .map_err(|error| CaseError::new("InputError", error.to_string()))
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "decodeEntry" => {
            let input = unknown(function, args.first())?;
            let raw = input
                .as_object()
                .ok_or_else(|| CaseError::unhandled(function))?;
            normalize_chat_registry_entry(raw, "1783725900000200")
                .map(|entry| value(&entry))
                .map_err(codec_error)
        }
        "parseSegments" => {
            let input = unknown(function, args.first())?;
            parse_carry_over_segment_refs(&input)
                .map(|entries| value(&entries))
                .map_err(codec_error)
        }
        "validSegmentId" => Ok(json!(
            round_tripped(function, args.first())?
                .as_deref()
                .is_some_and(is_carry_over_segment_id)
        )),
        "allocateIds" => {
            let times: Vec<i64> = read(function, args.first())?;
            let existing: Vec<String> = read(function, args.get(1))?;
            let clock = Rc::new(ManualClock::new(0));
            let allocate = ChatIdAllocator::new(clock.clone());
            let result: Result<Vec<_>, _> = times
                .into_iter()
                .map(|time| {
                    clock.set(time);
                    allocate.allocate(|candidate| existing.iter().any(|id| id == candidate))
                })
                .collect();
            result.map(|ids| value(&ids)).map_err(|error| match error {
                AllocationError::Invalid(error) => id_error(error),
                AllocationError::Exhausted => CaseError::new("Error", error.to_string()),
            })
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn registry_codecs_and_allocator_match_bun() {
    let statistics = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/registry-codec"
        ),
        dispatch,
    );
    assert_eq!(statistics.total, statistics.passed);
    assert_eq!(statistics.with_wildcards, 0);
}
