use garcon_cases::{CaseError, replay, unknown};
use garcon_chats::{
    chat_order_ranking::build_chat_order_comparator,
    metadata_store::{ChatMetadata, MetadataSource},
};
use garcon_contract::chat_order_sort::ChatOrderSortKey;
use indexmap::IndexMap;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Times {
    created_at: Option<String>,
    last_activity: Option<String>,
}

fn decode<T: DeserializeOwned>(function: &str, arg: Option<&Value>) -> Result<T, CaseError> {
    serde_json::from_value(unknown(function, arg)?.into_owned())
        .map_err(|error| CaseError::new("InputError", error.to_string()))
}

fn dispatch(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    if function != "sortChatIds" {
        return Err(CaseError::unhandled(function));
    }
    let sort_key: ChatOrderSortKey = decode(function, args.first())?;
    let mut ids: Vec<String> = decode(function, args.get(1))?;
    let timestamps: IndexMap<String, Times> = decode(function, args.get(2))?;
    let metadata = timestamps
        .into_iter()
        .map(|(id, times)| {
            let entry = ChatMetadata {
                chat_id: id.clone(),
                transcript_view_id: None,
                created_at: times.created_at,
                last_activity: times.last_activity,
                last_message: String::new(),
                first_message: String::new(),
                source: MetadataSource::Live,
                identity: None,
            };
            (id, entry)
        })
        .collect();
    let compare = build_chat_order_comparator(sort_key, &metadata);
    ids.sort_by(|left, right| compare(left, right).total_cmp(&0.0));
    Ok(json!(ids))
}

#[test]
fn order_ranking_matches_bun() {
    let statistics = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/server-common/chat-order"
        ),
        dispatch,
    );
    assert_eq!(statistics.total, statistics.passed);
    assert_eq!(statistics.with_wildcards, 0);
}
