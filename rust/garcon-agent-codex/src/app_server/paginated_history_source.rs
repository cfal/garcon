use std::{
    collections::{HashMap, HashSet},
    rc::Rc,
};

use garcon_base::event_loop::EventLoopSteps;
use garcon_contract::chat_types::ChatMessage;
use garcon_interface::{
    errors::{AgentIntegrationError, AgentIntegrationErrorCode as Code},
    native_message_source::{
        NativeMessageSourceInput, NativeSourced, attach_native_message_source,
        get_native_message_source,
    },
    resources::ExecutorResult,
};
use garcon_js::{Number, to_iso_string};
use serde_json::{Map, json};
use tokio_util::sync::CancellationToken;

use crate::history_profile::check_aborted;

use super::{
    client::CodexAppServerClient,
    converter::convert_codex_app_server_item,
    paginated_user_message_evidence::{
        CodexPaginatedItemEvidence, load_paginated_user_message_evidence,
    },
    protocol::{CodexItemsView, ThreadItemEntry},
};

const HISTORY_PAGE_SIZE: usize = 100;
const MAX_HISTORY_PAGES: usize = 100_000;

type HistoryMessage = NativeSourced<ChatMessage>;

struct TurnShell {
    id: String,
    timestamp: String,
}

struct ProviderItem {
    turn_id: String,
    item_id: String,
    messages: Vec<HistoryMessage>,
}

struct ItemPosition<'a> {
    id: &'a str,
    global: usize,
    within_turn: usize,
}

pub struct PaginatedCodexHistorySource {
    pub native_path: String,
    pub thread_id: String,
    pub created_at: String,
    pub create_client: Rc<dyn Fn() -> CodexAppServerClient>,
}

impl PaginatedCodexHistorySource {
    pub async fn load(&self, signal: &CancellationToken) -> ExecutorResult<Vec<HistoryMessage>> {
        check_aborted(signal)?;
        let client = (self.create_client)();
        let loaded = self.load_with(&client, signal).await;
        let result = match loaded {
            Err(error) => match check_aborted(signal) {
                Err(abort) => Err(abort),
                Ok(()) if error.is::<AgentIntegrationError>() => Err(error),
                Ok(()) => Err(AgentIntegrationError::new(
                    Code::TRANSCRIPT_UNAVAILABLE,
                    "Codex paginated history is unavailable",
                    true,
                    Some(Map::from_iter([
                        ("operation".into(), json!("load-paginated-history")),
                        ("provider".into(), json!("codex")),
                        ("reason".into(), json!("provider-error")),
                    ])),
                )
                .into()),
            },
            loaded => loaded,
        };
        client.shutdown().await?;
        result
    }

    async fn load_with(
        &self,
        client: &CodexAppServerClient,
        signal: &CancellationToken,
    ) -> ExecutorResult<Vec<HistoryMessage>> {
        let mut steps = EventLoopSteps::new("codex-paginated-history");
        // Reading items first cannot orphan entries when a new turn appears during the scan.
        let items = collect_history_pages("item", signal, |cursor| async move {
            let page = client
                .list_thread_items(&json!({
                    "threadId": self.thread_id, "turnId": null, "cursor": cursor,
                    "limit": HISTORY_PAGE_SIZE, "sortDirection": "asc"
                }))
                .await?;
            Ok((page.data, page.next_cursor))
        })
        .await?;
        let turns = collect_history_pages("turn", signal, |cursor| async move {
            let page = client
                .list_thread_turns(&json!({
                    "threadId": self.thread_id, "cursor": cursor, "limit": HISTORY_PAGE_SIZE,
                    "sortDirection": "asc", "itemsView": "notLoaded"
                }))
                .await?;
            Ok((page.data, page.next_cursor))
        })
        .await?;
        let mut shells = Vec::new();
        let mut turn_ordinals = HashMap::new();
        for turn in turns {
            if turn.items_view != CodexItemsView::NotLoaded {
                return Err(format!(
                    "Codex returned {:?} items for turn {}",
                    turn.items_view, turn.id
                )
                .into());
            }
            if turn_ordinals
                .insert(turn.id.clone(), shells.len())
                .is_some()
            {
                return Err(format!("Codex repeated history turn {}", turn.id).into());
            }
            shells.push(TurnShell {
                id: turn.id,
                timestamp: codex_timestamp(turn.started_at.or(turn.completed_at), &self.created_at),
            });
            step(&mut steps).await;
        }
        let provider_items =
            convert_provider_items(items, &shells, &turn_ordinals, &mut steps).await?;
        let evidence = load_paginated_user_message_evidence(
            &self.native_path,
            &self.created_at,
            signal,
            &turn_ordinals.keys().map(String::as_str).collect(),
        )
        .await?;
        check_aborted(signal)?;
        merge_evidence(
            &shells,
            &turn_ordinals,
            provider_items,
            evidence,
            &mut steps,
        )
        .await
    }
}

async fn collect_history_pages<T, F>(
    kind: &str,
    signal: &CancellationToken,
    mut list: impl FnMut(Option<String>) -> F,
) -> ExecutorResult<Vec<T>>
where
    F: Future<Output = ExecutorResult<(Vec<T>, Option<String>)>>,
{
    let mut rows = Vec::new();
    let mut seen_cursors = HashSet::new();
    let mut cursor = None;
    for page_index in 0..MAX_HISTORY_PAGES {
        check_aborted(signal)?;
        let (data, next_cursor) = list(cursor).await?;
        check_aborted(signal)?;
        rows.extend(data);
        let Some(next) = next_cursor.filter(|cursor| !cursor.is_empty()) else {
            return Ok(rows);
        };
        if !seen_cursors.insert(next.clone()) {
            return Err(format!("Codex repeated history {kind} cursor {next}").into());
        }
        if page_index + 1 >= MAX_HISTORY_PAGES {
            return Err(format!("Codex paginated {kind} history exceeded the page limit").into());
        }
        cursor = Some(next);
    }
    Ok(rows)
}

async fn convert_provider_items(
    entries: Vec<ThreadItemEntry>,
    shells: &[TurnShell],
    ordinals: &HashMap<String, usize>,
    steps: &mut EventLoopSteps,
) -> ExecutorResult<Vec<ProviderItem>> {
    let mut seen = HashSet::new();
    let mut items = Vec::with_capacity(entries.len());
    for ThreadItemEntry { turn_id, item } in entries {
        let Some(turn) = ordinals
            .get(&turn_id)
            .and_then(|ordinal| shells.get(*ordinal))
        else {
            return Err(format!("Codex item {} refers to unknown turn {turn_id}", item.id).into());
        };
        if !seen.insert(item_key(&turn_id, &item.id)) {
            return Err(format!("Codex repeated history item {}", item.id).into());
        }
        let entry_id = format!("turn:{turn_id}:item:{}", item.id);
        let messages = convert_codex_app_server_item(item.payload(), &turn.timestamp)
            .into_iter()
            .enumerate()
            .map(|(ordinal, message)| {
                let mut row = NativeSourced::new(message);
                attach_native_message_source(
                    &mut row,
                    Some(NativeMessageSourceInput {
                        entry_id: Some(&entry_id),
                        within_source_ordinal: Some(ordinal as f64),
                        ..Default::default()
                    }),
                );
                row
            })
            .collect();
        items.push(ProviderItem {
            turn_id,
            item_id: item.id,
            messages,
        });
        step(steps).await;
    }
    Ok(items)
}

async fn merge_evidence(
    turns: &[TurnShell],
    turn_ordinals: &HashMap<String, usize>,
    provider: Vec<ProviderItem>,
    evidence: CodexPaginatedItemEvidence,
    steps: &mut EventLoopSteps,
) -> ExecutorResult<Vec<HistoryMessage>> {
    let mut provider_keys = HashSet::new();
    let mut claimed = HashSet::new();
    let mut positions_by_turn: HashMap<&str, Vec<ItemPosition<'_>>> = HashMap::new();
    for (global, item) in provider.iter().enumerate() {
        provider_keys.insert(item_key(&item.turn_id, &item.item_id));
        let positions = positions_by_turn.entry(&item.turn_id).or_default();
        positions.push(ItemPosition {
            id: &item.item_id,
            global,
            within_turn: positions.len(),
        });
        claimed.extend(
            item.messages
                .iter()
                .filter_map(upstream_request_id)
                .map(str::to_owned),
        );
        step(steps).await;
    }
    let mut unrepresented: HashMap<_, Vec<HistoryMessage>> = HashMap::new();
    for row in evidence.messages {
        if let Some(key) = get_native_message_source(&row)
            .and_then(|source| source.entry_id)
            .as_deref()
            .and_then(source_item_identity)
            .map(|(turn, item)| item_key(turn, item))
            && !provider_keys.contains(&key)
            && upstream_request_id(&row).is_none_or(|id| claimed.insert(id.into()))
        {
            unrepresented.entry(key).or_default().push(row);
        }
        step(steps).await;
    }

    let mut insertions: HashMap<usize, Vec<HistoryMessage>> = HashMap::new();
    for (ordinal, turn) in turns.iter().enumerate() {
        let positions = positions_by_turn
            .get(turn.id.as_str())
            .map_or(&[][..], Vec::as_slice);
        if let Some(ids) = evidence.ordered_item_ids_by_turn.get(&turn.id) {
            let anchors = positions
                .iter()
                .filter_map(|position| {
                    ids.get_index_of(position.id)
                        .map(|evidence_index| (evidence_index, position))
                })
                .collect::<Vec<_>>();
            if anchors.windows(2).any(|pair| pair[0].0 >= pair[1].0) {
                return Err(format!(
                    "Codex item evidence conflicts with provider order for turn {}",
                    turn.id
                )
                .into());
            }
            if positions.is_empty() {
                let mut rows = Vec::new();
                for id in ids {
                    rows.extend(
                        unrepresented
                            .remove(&item_key(&turn.id, id))
                            .unwrap_or_default(),
                    );
                }
                if !rows.is_empty() {
                    let index = empty_turn_index(&turn.id, ordinal, turn_ordinals, &provider)?;
                    insertions.entry(index).or_default().append(&mut rows);
                }
            } else {
                for (index, id) in ids.iter().enumerate() {
                    let Some(rows) = unrepresented.remove(&item_key(&turn.id, id)) else {
                        continue;
                    };
                    if anchors.is_empty() {
                        return Err(format!(
                            "Codex item evidence has no provider anchor for turn {}",
                            turn.id
                        )
                        .into());
                    }
                    let gap =
                        anchors.partition_point(|(evidence_index, _)| *evidence_index < index);
                    let start = gap
                        .checked_sub(1)
                        .and_then(|index| anchors.get(index))
                        .map_or(0, |(_, position)| position.within_turn + 1);
                    let next = anchors.get(gap).map(|(_, position)| *position);
                    if start != next.map_or(positions.len(), |position| position.within_turn) {
                        return Err(format!(
                            "Codex item evidence has an ambiguous position for turn {}",
                            turn.id
                        )
                        .into());
                    }
                    let insertion = next.map(|position| position.global).unwrap_or_else(|| {
                        positions
                            .last()
                            .map_or(provider.len(), |position| position.global + 1)
                    });
                    insertions.entry(insertion).or_default().extend(rows);
                }
            }
        }
        step(steps).await;
    }
    let count = provider.len();
    let mut merged = Vec::new();
    for (index, item) in provider.into_iter().enumerate() {
        merged.extend(insertions.remove(&index).unwrap_or_default());
        merged.extend(item.messages);
        step(steps).await;
    }
    merged.extend(insertions.remove(&count).unwrap_or_default());
    Ok(merged)
}

fn empty_turn_index(
    turn_id: &str,
    turn_ordinal: usize,
    ordinals: &HashMap<String, usize>,
    provider: &[ProviderItem],
) -> ExecutorResult<usize> {
    let mut previous = None;
    let mut next = provider.len();
    for (index, item) in provider.iter().enumerate() {
        let Some(ordinal) = ordinals.get(&item.turn_id) else {
            continue;
        };
        if *ordinal < turn_ordinal {
            previous = Some(index);
        }
        if *ordinal > turn_ordinal {
            next = next.min(index);
        }
    }
    if previous.is_some_and(|previous| previous >= next) {
        return Err(
            format!("Codex item evidence has an ambiguous position for turn {turn_id}").into(),
        );
    }
    Ok(next)
}

fn source_item_identity(entry_id: &str) -> Option<(&str, &str)> {
    let (turn, item) = entry_id.strip_prefix("turn:")?.split_once(":item:")?;
    (!turn.is_empty() && !item.is_empty()).then_some((turn, item))
}

fn item_key(turn: &str, item: &str) -> String {
    format!("{turn}\0{item}")
}

fn codex_timestamp(value: Option<Number>, fallback: &str) -> String {
    value
        .filter(|value| value.0.is_finite() && value.0 >= 0.0)
        .map(|value| {
            if value.0 < 100_000_000_000.0 {
                value.0 * 1000.0
            } else {
                value.0
            }
        })
        .filter(|ms| *ms <= 8.64e15)
        .and_then(|ms| to_iso_string(ms as i64).ok())
        .unwrap_or_else(|| fallback.into())
}

fn upstream_request_id(row: &HistoryMessage) -> Option<&str> {
    match &row.value {
        ChatMessage::User(message) => message
            .metadata
            .as_ref()?
            .upstream_request_id
            .as_deref()
            .filter(|id| !id.is_empty()),
        _ => None,
    }
}

async fn step(steps: &mut EventLoopSteps) {
    if steps.due() {
        steps.next().await;
    }
}
