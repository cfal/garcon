//! Initializes the two catalog stores in the original startup order.

use std::rc::Rc;

use garcon_js::Clock;

use crate::{
    api_providers::assignments::RetainExecutorReferences,
    preambles::{setup::initialize_preamble_store, store::PreambleStore},
};

use super::{Result, short_name_coordinator::assert_catalogs_do_not_overlap, store::SnippetStore};

pub struct SnippetAndPreambleStores {
    pub snippets: Rc<SnippetStore>,
    pub preambles: Rc<PreambleStore>,
}

pub async fn initialize_snippet_and_preamble_stores(
    workspace_dir: &str,
    clock: &dyn Clock,
    retain: Option<RetainExecutorReferences>,
) -> Result<SnippetAndPreambleStores> {
    let snippets = SnippetStore::open(workspace_dir).await?;
    let preambles = initialize_preamble_store(workspace_dir, clock, retain).await?;
    assert_catalogs_do_not_overlap(&snippets, &preambles)?;
    Ok(SnippetAndPreambleStores {
        snippets,
        preambles,
    })
}

#[cfg(test)]
mod tests {
    use garcon_js::ManualClock;
    use tokio::fs;

    use super::*;

    #[tokio::test]
    async fn real_catalogs_reject_a_shared_short_name_in_startup() {
        tokio::task::LocalSet::new().run_until(async {
            let root = tempfile::tempdir().unwrap();
            let workspace = root.path().to_str().unwrap();
            let stamp = "2026-11-28T00:00:00.000Z";
            let timestamp = garcon_js::date_parse::date_parse(stamp).unwrap();
            fs::write(root.path().join("snippets.json"), serde_json::to_vec(&serde_json::json!({
                "version": 2, "revision": 1, "snippets": [{
                    "id": "seeded-snippet", "shortName": "shared", "template": "Synthetic snippet",
                    "defaultArguments": "", "createdAt": stamp, "updatedAt": stamp
                }]
            })).unwrap()).await.unwrap();
            let contents = serde_json::json!({
                "version": 2, "revision": 2, "retiredPreambleIds": [], "preambles": [{
                    "id": "11111111-1111-4111-8111-111111111111", "enabled": false,
                    "title": "Synthetic preamble", "snippetShortName": "shared", "content": "Synthetic content",
                    "scope": {"type": "global"}, "createdAt": stamp, "updatedAt": stamp
                }]
            });
            let path = root.path().join("preambles.json");
            fs::write(&path, serde_json::to_vec(&contents).unwrap()).await.unwrap();
            let now = ManualClock::new(timestamp);
            let error = initialize_snippet_and_preamble_stores(workspace, &now, None).await.err().unwrap();
            assert_eq!(error.to_string(), "Snippet and preamble catalogs contain the same short name: shared");
            let mut fixed = contents;
            fixed["preambles"][0]["snippetShortName"] = serde_json::json!("separate");
            fs::write(&path, serde_json::to_vec(&fixed).unwrap()).await.unwrap();
            let ready = initialize_snippet_and_preamble_stores(workspace, &now, None).await.unwrap();
            assert_eq!(ready.snippets.snapshot().revision, 1);
            assert_eq!(ready.preambles.snapshot().revision, 3);
            assert_eq!(ready.preambles.get_by_snippet_short_name("separate").unwrap().definition.title, "Synthetic preamble");
        }).await;
    }
}
