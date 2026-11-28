//! Ports the store initialization in `server/controller/preambles/setup.ts`.

use std::rc::Rc;

use garcon_base::log::{Logger, create_logger};
use garcon_js::Clock;

use crate::api_providers::assignments::RetainExecutorReferences;

use super::{Result, bundled, store::PreambleStore};

pub async fn initialize_preamble_store(
    workspace_dir: &str,
    clock: &dyn Clock,
    retain: Option<RetainExecutorReferences>,
) -> Result<Rc<PreambleStore>> {
    let store = PreambleStore::open(workspace_dir).await?;
    let installation = store
        .install_bundled(&bundled::definitions()?, clock.now_ms(), retain)
        .await?;
    if installation.deferred > 0 {
        create_logger("preambles").warn(&format!(
            "{} bundled preamble(s) could not be installed because the catalog is full",
            installation.deferred
        ));
    }
    Ok(store)
}
