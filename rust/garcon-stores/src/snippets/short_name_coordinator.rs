//! The startup check from `server/controller/snippets/short-name-coordinator.ts`.

use std::collections::HashSet;

use crate::preambles::store::PreambleStore;

use super::{Result, store::SnippetStore};

pub(super) fn assert_catalogs_do_not_overlap(
    snippets: &SnippetStore,
    preambles: &PreambleStore,
) -> Result<()> {
    let names: HashSet<_> = snippets
        .snapshot()
        .snippets
        .into_iter()
        .map(|entry| entry.definition.short_name)
        .collect();
    let conflict = preambles
        .snapshot()
        .preambles
        .into_iter()
        .filter_map(|entry| entry.definition.snippet_short_name)
        .find(|name| names.contains(name));
    if let Some(name) = conflict {
        return Err(
            format!("Snippet and preamble catalogs contain the same short name: {name}").into(),
        );
    }
    Ok(())
}
