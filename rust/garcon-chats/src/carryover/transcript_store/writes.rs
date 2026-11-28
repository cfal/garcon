use std::{cell::Cell, future::Future, path::PathBuf};

use garcon_base::json_file_store::{JsonFileStore, JsonWriteOptions};

use super::*;
use crate::carryover::{
    page_codec::{check_signal, digest, encode_segment_pages, write_encoded_carry_over_page},
    segment_types::{CARRYOVER_MESSAGE_SCHEMA_VERSION, CARRYOVER_SEGMENT_VERSION, has_segment_id},
};

impl CarryOverTranscriptStore {
    pub async fn prepare_segment(
        &self,
        request: PrepareCarryOverSegmentRequest<'_>,
    ) -> Result<PreparedCarryOverSegment, CarryOverStoreError> {
        check_signal(request.signal)?;
        let id = require_segment_id(request.id)?;
        if request.messages.is_empty() {
            return Err(CarryOverStoreError::EmptySegment);
        }
        let operation_dir = self.0.tmp_dir.join(digest(request.operation_id.as_bytes()));
        let prepared_dir = operation_dir.join(id);
        {
            let _roots = self.lock_writer_roots().await;
            *self
                .0
                .writer_root_counts
                .borrow_mut()
                .entry(id.into())
                .or_default() += 1;
        }

        let result = self.write_prepared(&prepared_dir, request).await;
        match result {
            Ok(index) => Ok(PreparedCarryOverSegment {
                store: self.clone(),
                index: Rc::new(index),
                operation_dir,
                prepared_dir,
                committed: Cell::new(false),
                installed: Cell::new(false),
                released: Cell::new(false),
            }),
            Err(error) => {
                let _ = remove_dir(&prepared_dir).await;
                let _roots = self.lock_writer_roots().await;
                self.release_count(id);
                Err(error)
            }
        }
    }

    async fn write_prepared(
        &self,
        dir: &Path,
        request: PrepareCarryOverSegmentRequest<'_>,
    ) -> Result<CarryOverSegmentIndex, CarryOverStoreError> {
        remove_dir(dir).await?;
        let pages_dir = dir.join("pages");
        create_dir(&pages_dir).await?;
        let message_count = request.messages.len() as u64;
        let encoded = encode_segment_pages(request.messages, request.signal).await?;
        for page in &encoded.pages {
            check_signal(request.signal)?;
            write_encoded_carry_over_page(&dir.join(&page.descriptor.file), page).await?;
        }
        sync_directory(&pages_dir).await?;
        let index = CarryOverSegmentIndex {
            version: CARRYOVER_SEGMENT_VERSION,
            message_schema_version: CARRYOVER_MESSAGE_SCHEMA_VERSION,
            id: request.id.into(),
            seed_sanitation: request.seed_sanitation,
            message_count,
            canonical_messages_sha256: encoded.canonical_messages_sha256,
            pages: encoded
                .pages
                .into_iter()
                .map(|page| page.descriptor)
                .collect(),
        };
        let path = dir.join("segment.json");
        let writer = JsonFileStore::new(SystemClock, || (self.0.options.uuid)());
        writer
            .write_json_file_atomic(
                &path.to_string_lossy(),
                &index,
                JsonWriteOptions {
                    mode: Some(0o600),
                    trailing_newline: None,
                },
            )
            .await?;
        sync_directory(dir).await?;
        Ok(index)
    }

    pub async fn cleanup_temporary(
        &self,
        retained_segment_ids: &IndexSet<String>,
    ) -> io::Result<usize> {
        let mut removed = 0;
        let mut entries = fs::read_dir(&self.0.tmp_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            if !entry.file_type().await?.is_dir() {
                continue;
            }
            let path = entry.path();
            let retained = contains_retained_segment(&path, retained_segment_ids)
                .await
                .unwrap_or(false);
            if !retained {
                remove_dir(&path).await?;
                removed += 1;
            }
        }
        if removed > 0 {
            sync_directory(&self.0.tmp_dir).await?;
        }
        Ok(removed)
    }

    pub async fn sweep(
        &self,
        roots: impl FnOnce() -> IndexSet<String>,
    ) -> Result<CarryOverSweepResult, CarryOverStoreError> {
        let _roots = self.lock_writer_roots().await;
        let roots = roots();
        let started_at = self.0.options.clock.now_ms();
        let mut reachable = IndexSet::new();
        for id in roots.into_iter().chain(self.writer_roots()) {
            require_segment_id(&id)?;
            reachable.insert(id);
        }
        let mut compressed_bytes = 0;
        let mut declared_uncompressed_bytes = 0;
        for id in &reachable {
            // Corrupt roots are still retained and must not prevent collection.
            if let Ok(index) = self.read_index(id).await {
                for page in &index.pages {
                    compressed_bytes += u128::from(page.compressed_bytes);
                    declared_uncompressed_bytes += u128::from(page.uncompressed_bytes);
                }
            }
        }
        let mut entries = fs::read_dir(&self.0.segments_dir).await?;
        let mut candidates = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let Some(id) = name.to_str() else { continue };
            if entry.file_type().await?.is_dir() && has_segment_id(id) && !reachable.contains(id) {
                candidates.push(id.to_owned());
            }
        }
        let mut removed_segment_count = 0;
        for id in &candidates {
            let trash_path = self
                .0
                .trash_dir
                .join(format!("{id}-{}", (self.0.options.uuid)()));
            match fs::rename(self.segment_dir(id), &trash_path).await {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            }
            self.remove_cached(id);
            remove_dir(&trash_path).await?;
            removed_segment_count += 1;
        }
        if removed_segment_count != 0 {
            tokio::try_join!(
                sync_directory(&self.0.segments_dir),
                sync_directory(&self.0.trash_dir)
            )?;
        }
        Ok(CarryOverSweepResult {
            reachable_segment_count: reachable.len(),
            unreachable_segment_count: candidates.len(),
            removed_segment_count,
            compressed_bytes,
            declared_uncompressed_bytes,
            duration_ms: self.0.options.clock.now_ms() - started_at,
        })
    }

    async fn lock_writer_roots(&self) -> WriterRootLock<'_> {
        WriterRootLock {
            store: self,
            _guard: self.0.root_state_lock.lock().await,
        }
    }

    fn release_count(&self, id: &str) {
        let mut counts = self.0.writer_root_counts.borrow_mut();
        if let Some(count) = counts.get_mut(id) {
            *count -= 1;
            if *count == 0 {
                counts.shift_remove(id);
            }
        }
    }
}

struct WriterRootLock<'a> {
    store: &'a CarryOverTranscriptStore,
    _guard: tokio::sync::MutexGuard<'a, ()>,
}

impl Drop for WriterRootLock<'_> {
    fn drop(&mut self) {
        for id in self.store.0.pending_releases.borrow_mut().drain(..) {
            self.store.release_count(&id);
        }
    }
}

pub struct PreparedCarryOverSegment {
    store: CarryOverTranscriptStore,
    index: Rc<CarryOverSegmentIndex>,
    operation_dir: PathBuf,
    prepared_dir: PathBuf,
    committed: Cell<bool>,
    installed: Cell<bool>,
    released: Cell<bool>,
}

impl PreparedCarryOverSegment {
    pub fn id(&self) -> &str {
        &self.index.id
    }

    pub fn message_count(&self) -> u64 {
        self.index.message_count
    }

    pub fn canonical_messages_sha256(&self) -> &str {
        &self.index.canonical_messages_sha256
    }

    pub async fn commit(&self) -> Result<(), CarryOverStoreError> {
        self.commit_with_sync(sync_directory).await
    }

    async fn commit_with_sync<F: Future<Output = io::Result<()>>>(
        &self,
        sync: impl FnOnce(PathBuf) -> F,
    ) -> Result<(), CarryOverStoreError> {
        if self.committed.get() {
            return Ok(());
        }
        let final_dir = self.store.segment_dir(self.id());
        match fs::rename(&self.prepared_dir, &final_dir).await {
            Ok(()) => {
                self.installed.set(true);
                sync(self.store.0.segments_dir.clone()).await?;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::AlreadyExists | io::ErrorKind::DirectoryNotEmpty
                ) =>
            {
                self.assert_idempotent_collision(&final_dir).await?;
                remove_dir(&self.prepared_dir).await?;
            }
            Err(error) => return Err(error.into()),
        }
        self.committed.set(true);
        self.store
            .0
            .index_cache
            .borrow_mut()
            .insert(self.id().into(), Rc::clone(&self.index));
        let _ = fs::remove_dir(&self.operation_dir).await;
        Ok(())
    }

    pub async fn discard(&self) -> io::Result<()> {
        if self.released.get() {
            return Ok(());
        }
        remove_dir(&self.prepared_dir).await?;
        if self.committed.get() && self.installed.get() {
            remove_dir(&self.store.segment_dir(self.id())).await?;
            self.store.remove_cached(self.id());
            sync_directory(&self.store.0.segments_dir).await?;
        }
        {
            let _roots = self.store.lock_writer_roots().await;
            self.store.release_count(self.id());
        }
        self.released.set(true);
        let _ = fs::remove_dir(&self.operation_dir).await;
        Ok(())
    }

    pub fn release_root(&self) {
        if self.released.replace(true) {
            return;
        }
        // A sweep must retain its original writer roots through the final delete.
        if let Ok(_roots) = self.store.0.root_state_lock.try_lock() {
            self.store.release_count(self.id());
        } else {
            self.store
                .0
                .pending_releases
                .borrow_mut()
                .push(self.id().into());
        }
    }

    async fn assert_idempotent_collision(&self, dir: &Path) -> Result<(), CarryOverStoreError> {
        let result = async {
            let actual = self.store.read_uncached_index(dir, self.id()).await?;
            if actual != *self.index {
                return Err(io::Error::other("Index differs").into());
            }
            self.store
                .verify_segment(
                    &CarryOverSegmentRef {
                        id: actual.id,
                        agent_id: "collision-check".into(),
                        model: String::new(),
                        captured_at: "1970-01-01T00:00:00.000Z".into(),
                        stored_message_count: actual.message_count,
                        visible_message_count: actual.message_count,
                        trailing_handoff: None,
                    },
                    None,
                )
                .await
        }
        .await;
        result.map_err(|cause| {
            CarryOverTranscriptCollision {
                id: self.id().into(),
                cause: Box::new(cause),
            }
            .into()
        })
    }
}

async fn contains_retained_segment(dir: &Path, roots: &IndexSet<String>) -> io::Result<bool> {
    let mut entries = fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        if let Some(id) = name.to_str()
            && has_segment_id(id)
            && roots.contains(id)
            && entry.file_type().await?.is_dir()
        {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn require_segment_id(id: &str) -> Result<&str, CarryOverStoreError> {
    if has_segment_id(id) {
        Ok(id)
    } else {
        Err(CarryOverStoreError::InvalidSegmentId)
    }
}

#[cfg(test)]
mod tests {
    use garcon_contract::chat_types::{ChatMessage, UserMessage};

    use super::*;

    #[tokio::test]
    async fn a_rename_without_directory_sync_keeps_the_candidate_for_sweep() {
        let workspace = tempfile::tempdir().unwrap();
        let store = CarryOverTranscriptStore::new(workspace.path(), Default::default());
        store.initialize().await.unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        let prepared = store
            .prepare_segment(PrepareCarryOverSegmentRequest {
                operation_id: "synthetic",
                id,
                seed_sanitation: SeedSanitationOutcome::NotApplicable,
                messages: vec![ChatMessage::User(UserMessage {
                    timestamp: "2026-01-01T00:00:00.000Z".into(),
                    content: "Synthetic ask".into(),
                    images: None,
                    metadata: None,
                    presentation: None,
                })],
                signal: None,
            })
            .await
            .unwrap();
        let error = prepared
            .commit_with_sync(|_| async {
                Err(io::Error::other("injected directory sync failure"))
            })
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "injected directory sync failure");
        assert!(store.writer_roots().contains(id));
        assert!(store.segment_dir(id).is_dir());
        prepared.discard().await.unwrap();
        assert!(!store.writer_roots().contains(id));
        assert!(store.segment_dir(id).is_dir());
        assert_eq!(
            store
                .sweep(IndexSet::new)
                .await
                .unwrap()
                .removed_segment_count,
            1
        );
    }

    #[tokio::test]
    async fn a_release_during_sweep_keeps_the_writer_in_the_captured_roots() {
        let workspace = tempfile::tempdir().unwrap();
        let store = CarryOverTranscriptStore::new(workspace.path(), Default::default());
        store.initialize().await.unwrap();
        let id = "11111111-1111-4111-8111-111111111111";
        let prepared = store
            .prepare_segment(PrepareCarryOverSegmentRequest {
                operation_id: "synthetic",
                id,
                seed_sanitation: SeedSanitationOutcome::NotApplicable,
                messages: vec![ChatMessage::User(UserMessage {
                    timestamp: "2026-01-01T00:00:00.000Z".into(),
                    content: "Synthetic ask".into(),
                    images: None,
                    metadata: None,
                    presentation: None,
                })],
                signal: None,
            })
            .await
            .unwrap();
        prepared.commit().await.unwrap();
        let first = store
            .sweep(|| {
                prepared.release_root();
                assert!(store.writer_roots().contains(id));
                IndexSet::new()
            })
            .await
            .unwrap();
        assert_eq!(first.reachable_segment_count, 1);
        assert_eq!(first.removed_segment_count, 0);
        assert!(!store.writer_roots().contains(id));
        assert_eq!(
            store
                .sweep(IndexSet::new)
                .await
                .unwrap()
                .removed_segment_count,
            1
        );
    }
}
