//! Adapts a stable metadata snapshot to the shared ordering rules.

use std::{cell::RefCell, collections::HashMap};

use garcon_contract::chat_order_sort::{
    ChatOrderSortKey, ChatOrderTimestamps, compare_chat_order_newest_first,
};
use indexmap::IndexMap;

use crate::metadata_store::ChatMetadata;

pub fn build_chat_order_comparator(
    sort_key: ChatOrderSortKey,
    metadata: &IndexMap<String, ChatMetadata>,
) -> impl Fn(&str, &str) -> f64 + '_ {
    let compare = compare_chat_order_newest_first(sort_key);
    let timestamps = RefCell::new(HashMap::<String, ChatOrderTimestamps>::new());
    move |left, right| {
        let mut timestamps = timestamps.borrow_mut();
        for id in [left, right] {
            if !timestamps.contains_key(id) {
                let preview = metadata.get(id);
                timestamps.insert(
                    id.to_owned(),
                    ChatOrderTimestamps {
                        id: id.to_owned(),
                        created_at: preview.and_then(|entry| entry.created_at.clone()),
                        last_activity_at: preview.and_then(|entry| entry.last_activity.clone()),
                    },
                );
            }
        }
        // INFALLIBLE: both entries were populated above.
        compare(&timestamps[left], &timestamps[right])
    }
}
