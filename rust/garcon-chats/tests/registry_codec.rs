use std::{io, path::Path, rc::Rc};

use garcon_cases::{CaseError, markers, replay, round_tripped, unknown};
use garcon_chats::{
    carryover::segment_types::is_carry_over_segment_id,
    chat_id_allocator::{AllocationError, ChatIdAllocator},
    registry_entry_codec::{
        RegistryCodecError, normalize_chat_registry_entry, parse_carry_over_segment_refs,
    },
    store::{ChatRegistry, ChatRegistryPatch, NewChatRegistryEntry},
};
use garcon_contract::{
    chat_id::{InvalidChatIdError, InvalidChatIdValue, parse_chat_id},
    preambles::{ChatPreambleSelection, PendingPreambleBoundary},
};
use garcon_js::{
    clock::ManualClock,
    json::{Opaque, from_str},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{runtime::Runtime, task::LocalSet};

const CHAT_ID: &str = "1783725900000200";

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum BoundaryMutation {
    Add,
    Live,
    Phased,
}

async fn existing_bytes(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

async fn commit_boundary(
    mode: BoundaryMutation,
    ownership_epoch: String,
    boundary_epoch: String,
) -> Result<Value, Box<dyn std::error::Error>> {
    let directory = tempfile::Builder::new()
        .prefix("garcon-registry-boundary-")
        .tempdir()?;
    let registry = ChatRegistry::open(directory.path()).await?;
    let mut entry = NewChatRegistryEntry::new(
        parse_chat_id(&json!(CHAT_ID))?,
        "codex".into(),
        "fixture".into(),
        "/workspace/project".into(),
        ChatPreambleSelection {
            revision: 0,
            ordered_preamble_ids: Vec::new(),
        },
    );
    entry.entry.agent_ownership_epoch = "epoch-a".into();
    let boundary = PendingPreambleBoundary::SelectionChange {
        ownership_epoch: boundary_epoch,
        selection_revision: 0,
    };
    if !matches!(mode, BoundaryMutation::Add) {
        registry.add_chat(entry.clone())?;
        registry.flush().await?;
    }
    let before = existing_bytes(registry.path()).await?;
    let previous = registry.get_chat(CHAT_ID);
    let patch = ChatRegistryPatch {
        agent_ownership_epoch: Some(ownership_epoch.clone()),
        pending_preamble_boundary: Some(Some(boundary.clone())),
        ..Default::default()
    };
    let result = match mode {
        BoundaryMutation::Add => {
            entry.entry.agent_ownership_epoch = ownership_epoch;
            entry.entry.pending_preamble_boundary = Some(boundary);
            registry.add_chat(entry).map(|_| ())
        }
        BoundaryMutation::Live => registry.update_chat(CHAT_ID, patch).map(|_| ()),
        BoundaryMutation::Phased => registry
            .update_chat_phased(CHAT_ID, patch)
            .await
            .map(|_| ()),
    };
    if let Err(error) = result {
        return Ok(
            json!({ "mutationError": error.to_string(), "unchanged": existing_bytes(registry.path()).await? == before && registry.get_chat(CHAT_ID) == previous }),
        );
    }
    registry.flush().await?;
    let reopened = ChatRegistry::open(directory.path()).await?;
    Ok(
        json!({ "live": registry.get_chat(CHAT_ID).unwrap().pending_preamble_boundary,
        "reopened": reopened.get_chat(CHAT_ID).unwrap().pending_preamble_boundary }),
    )
}

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

fn dispatch(
    runtime: &Runtime,
    local: &LocalSet,
    function: &str,
    args: &[Value],
) -> Result<Value, CaseError> {
    match function {
        "decodeEntry" => {
            let input = unknown(function, args.first())?;
            let raw = input
                .as_object()
                .ok_or_else(|| CaseError::unhandled(function))?;
            normalize_chat_registry_entry(raw, CHAT_ID)
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
        "commitBoundary" => {
            let mode = read(function, args.first())?;
            let epoch = read(function, args.get(1))?;
            let boundary = read(function, args.get(2))?;
            local
                .block_on(runtime, commit_boundary(mode, epoch, boundary))
                .map_err(|error| CaseError::new("Error", error.to_string()))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn registry_codecs_and_allocator_match_bun() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = LocalSet::new();
    let statistics = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/registry-codec"
        ),
        |function, args| dispatch(&runtime, &local, function, args),
    );
    assert_eq!(statistics.total, statistics.passed);
    assert_eq!(statistics.with_wildcards, 0);
}
