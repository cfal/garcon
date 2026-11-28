//! Ports `server/controller/chats/carryover/garbage-collector.ts`.

use std::{cell::RefCell, rc::Rc, time::Duration};

use garcon_base::log::{Logger, create_logger};
use indexmap::IndexSet;
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

use super::transcript_store::{
    CarryOverStoreError, CarryOverSweepResult, CarryOverTranscriptStore,
};
use crate::registry_contracts::CarryOverSegmentRef;

const CARRYOVER_GC_DELAY: Duration = Duration::from_secs(1);

pub struct CarryOverGarbageCollectorDeps {
    pub registry_segments: Rc<dyn Fn() -> Vec<CarryOverSegmentRef>>,
    pub journal_roots: Rc<dyn Fn() -> IndexSet<String>>,
    pub store: CarryOverTranscriptStore,
}

#[derive(Clone)]
pub struct CarryOverGarbageCollector {
    deps: Rc<CarryOverGarbageCollectorDeps>,
    scheduled: Rc<RefCell<Option<CancellationToken>>>,
}

impl CarryOverGarbageCollector {
    pub fn new(deps: CarryOverGarbageCollectorDeps) -> Self {
        Self {
            deps: Rc::new(deps),
            scheduled: Rc::default(),
        }
    }

    pub async fn initialize(&self) -> Result<(), CarryOverStoreError> {
        let removed = self.deps.store.cleanup_temporary(&self.roots()).await?;
        let result = self.deps.store.sweep(|| self.roots()).await?;
        create_logger("chats:carryover-gc").info(&format!(
            "startup sweep complete {} removedTemporaryDirectories={removed}",
            summary(&result),
        ));
        Ok(())
    }

    pub fn schedule(&self) {
        let mut scheduled = self.scheduled.borrow_mut();
        if scheduled.is_some() {
            return;
        }
        let cancelled = CancellationToken::new();
        *scheduled = Some(cancelled.clone());
        let collector = self.clone();
        let when = Instant::now() + CARRYOVER_GC_DELAY;
        tokio::task::spawn_local(async move {
            tokio::select! {
                biased;
                () = cancelled.cancelled() => return,
                () = sleep_until(when) => (),
            }
            collector.scheduled.borrow_mut().take();
            if let Err(error) = collector.sweep().await {
                create_logger("chats:carryover-gc")
                    .warn(&format!("scheduled sweep failed: {error}"));
            }
        });
    }

    pub fn shutdown(&self) {
        if let Some(cancel) = self.scheduled.borrow_mut().take() {
            cancel.cancel();
        }
    }

    pub async fn sweep(&self) -> Result<(), CarryOverStoreError> {
        let result = self.deps.store.sweep(|| self.roots()).await?;
        create_logger("chats:carryover-gc").info(&format!("sweep complete {}", summary(&result)));
        Ok(())
    }

    fn roots(&self) -> IndexSet<String> {
        let mut roots = (self.deps.journal_roots)();
        roots.extend(
            (self.deps.registry_segments)()
                .into_iter()
                .filter(|reference| reference.stored_message_count > 0)
                .map(|reference| reference.id),
        );
        roots
    }
}

fn summary(result: &CarryOverSweepResult) -> String {
    format!(
        "reachableSegmentCount={} unreachableSegmentCount={} removedSegmentCount={} compressedBytes={} declaredUncompressedBytes={} durationMs={}",
        result.reachable_segment_count,
        result.unreachable_segment_count,
        result.removed_segment_count,
        result.compressed_bytes,
        result.declared_uncompressed_bytes,
        result.duration_ms,
    )
}
