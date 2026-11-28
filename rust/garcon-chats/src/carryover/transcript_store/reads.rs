use std::collections::VecDeque;

use futures::{Stream, StreamExt};
use garcon_base::stored_json::parse_stored_json;
use garcon_contract::{
    chat_types::AgentSwitchMessage,
    transcript_seed::{
        bound_projected_message, is_projectable_message, is_publication_gap_message,
    },
};
use sha2::{Digest, Sha256};
use tokio::task::spawn_blocking;

use super::{writes::require_segment_id, *};
use crate::carryover::{
    page_codec::{check_signal, decode_carry_over_page, integrity},
    segment_types::parse_carry_over_segment_index,
    segments::{assert_segment_binding, carry_over_layout},
};

const PROJECTION_BYTE_LIMIT: usize = 64 * 1024 * 1024;
const PROJECTION_BATCH_LIMIT: u64 = 512;

impl CarryOverTranscriptStore {
    pub async fn assert_available(
        &self,
        refs: &[CarryOverSegmentRef],
        signal: Option<&CancellationToken>,
    ) -> Result<(), CarryOverStoreError> {
        let result = async {
            for reference in refs {
                check_signal(signal)?;
                if reference.stored_message_count == 0 {
                    continue;
                }
                if self.0.degraded_segments.borrow().contains(&reference.id) {
                    return Err(io::Error::other(format!(
                        "Carryover segment {} is degraded",
                        reference.id
                    ))
                    .into());
                }
                let index = self.read_index(&reference.id).await?;
                assert_segment_binding(reference, &index)?;
                self.stat_pages(&index, signal).await?;
            }
            Ok(())
        }
        .await;
        result.map_err(CarryOverStoreError::unavailable)
    }

    pub async fn load_all(
        &self,
        refs: &[CarryOverSegmentRef],
        signal: Option<&CancellationToken>,
    ) -> Result<Vec<ChatMessage>, CarryOverStoreError> {
        Ok(self
            .load_page(refs, 0, archived_logical_count(refs), signal)
            .await?
            .messages)
    }

    pub async fn load_page(
        &self,
        refs: &[CarryOverSegmentRef],
        offset: u64,
        limit: u64,
        signal: Option<&CancellationToken>,
    ) -> Result<CarryOverTranscriptPage, CarryOverStoreError> {
        let total = archived_logical_count(refs);
        let revision = carry_over_revision(refs, None);
        let mut messages = Vec::new();
        if limit != 0 && offset < total {
            let first = offset + 1;
            let last = total.min(offset.saturating_add(limit));
            for item in carry_over_layout(refs) {
                check_signal(signal)?;
                let start = first.max(item.start_sequence);
                let end = last.min(item.payload_end_sequence);
                if start <= end {
                    messages.extend(
                        self.read_segment_range(
                            item.reference,
                            start - item.start_sequence,
                            end - start + 1,
                            signal,
                        )
                        .await?,
                    );
                }
                if item
                    .boundary_sequence
                    .is_some_and(|sequence| (first..=last).contains(&sequence))
                    && let Some(target) = &item.reference.trailing_handoff
                {
                    messages.push(ChatMessage::AgentSwitch(AgentSwitchMessage {
                        timestamp: item.reference.captured_at.clone(),
                        from_agent_id: item.reference.agent_id.clone(),
                        to_agent_id: target.agent_id.clone(),
                        from_model: Some(item.reference.model.clone()),
                        to_model: Some(target.model.clone()),
                        from_executor_id: None,
                        to_executor_id: None,
                    }));
                }
            }
        }
        Ok(CarryOverTranscriptPage {
            has_more: offset.saturating_add(messages.len() as u64) < total,
            messages,
            total,
            offset,
            limit,
            revision,
        })
    }

    pub fn stream<'a>(
        &'a self,
        refs: &'a [CarryOverSegmentRef],
        max_messages_per_batch: u64,
        signal: Option<&'a CancellationToken>,
    ) -> impl Stream<Item = Result<Vec<ChatMessage>, CarryOverStoreError>> + 'a {
        let total = archived_logical_count(refs);
        futures::stream::try_unfold(0, move |offset| async move {
            if max_messages_per_batch == 0 || max_messages_per_batch > 9_007_199_254_740_991 {
                return Err(CarryOverStoreError::InvalidBatchSize);
            }
            if offset >= total {
                return Ok(None);
            }
            check_signal(signal)?;
            let page = self
                .load_page(refs, offset, max_messages_per_batch, signal)
                .await?;
            let size = page.messages.len() as u64;
            Ok((size != 0).then_some((page.messages, offset.saturating_add(size))))
        })
    }

    pub async fn load_projection_source(
        &self,
        refs: &[CarryOverSegmentRef],
        max_bytes: Option<usize>,
        signal: Option<&CancellationToken>,
    ) -> Result<Vec<ChatMessage>, CarryOverStoreError> {
        let max_bytes = max_bytes.unwrap_or(PROJECTION_BYTE_LIMIT);
        let mut projection = ProjectionBuffer::new();
        let batches = self.stream(refs, PROJECTION_BATCH_LIMIT, signal);
        futures::pin_mut!(batches);
        while let Some(batch) = batches.next().await {
            let batch = batch?;
            projection = spawn_blocking(move || projection.add_batch(batch, max_bytes)).await??;
        }
        Ok(spawn_blocking(move || projection.finish()).await?)
    }

    pub fn resolve_cutoff(
        &self,
        refs: &[CarryOverSegmentRef],
        inclusive_sequence: u64,
    ) -> Vec<CarryOverSegmentRef> {
        if inclusive_sequence == 0 {
            return Vec::new();
        }
        for (index, item) in carry_over_layout(refs).into_iter().enumerate() {
            if inclusive_sequence < item.start_sequence {
                return refs[..index].to_vec();
            }
            if inclusive_sequence <= item.payload_end_sequence {
                let mut cutoff = refs[..index].to_vec();
                cutoff.push(CarryOverSegmentRef {
                    visible_message_count: inclusive_sequence - item.start_sequence + 1,
                    trailing_handoff: None,
                    ..item.reference.clone()
                });
                return cutoff;
            }
            if item.boundary_sequence == Some(inclusive_sequence) {
                return refs[..=index].to_vec();
            }
        }
        refs.to_vec()
    }

    pub async fn read_index(
        &self,
        id: &str,
    ) -> Result<Rc<CarryOverSegmentIndex>, CarryOverStoreError> {
        let id = require_segment_id(id)?;
        {
            let mut cache = self.0.index_cache.borrow_mut();
            if let Some((key, index)) = cache.shift_remove_entry(id) {
                cache.insert(key, Rc::clone(&index));
                return Ok(index);
            }
        }
        let index = self
            .read_uncached_index(&self.segment_dir(id), id)
            .await
            .map_err(|error| {
                if matches!(
                    error,
                    CarryOverStoreError::InvalidJson(_) | CarryOverStoreError::InvalidIndex(_)
                ) {
                    self.0.degraded_segments.borrow_mut().insert(id.into());
                }
                error.unavailable()
            })?;
        let index = Rc::new(index);
        let mut cache = self.0.index_cache.borrow_mut();
        cache.insert(id.into(), Rc::clone(&index));
        while cache.len() > self.0.options.index_cache_size {
            cache.shift_remove_index(0);
        }
        Ok(index)
    }

    pub(super) async fn read_uncached_index(
        &self,
        dir: &Path,
        id: &str,
    ) -> Result<CarryOverSegmentIndex, CarryOverStoreError> {
        let raw = fs::read(dir.join("segment.json")).await?;
        let json = parse_stored_json(&String::from_utf8_lossy(&raw), "Carryover segment index")?;
        Ok(parse_carry_over_segment_index(&json, Some(id))?)
    }

    pub async fn verify_segment(
        &self,
        reference: &CarryOverSegmentRef,
        signal: Option<&CancellationToken>,
    ) -> Result<(), CarryOverStoreError> {
        if reference.stored_message_count == 0 {
            return Ok(());
        }
        let index = self.read_index(&reference.id).await?;
        assert_segment_binding(reference, &index)?;
        let mut digest = Sha256::new_with_prefix(b"[");
        let mut count = 0;
        for page in &index.pages {
            check_signal(signal)?;
            let messages =
                decode_carry_over_page(&self.segment_dir(&index.id).join(&page.file), page, signal)
                    .await?;
            (digest, count) = spawn_blocking(move || {
                for message in messages {
                    if count != 0 {
                        digest.update(b",");
                    }
                    digest.update(serde_json::to_vec(&message)?);
                    count += 1;
                }
                Ok::<_, serde_json::Error>((digest, count))
            })
            .await??;
        }
        digest.update(b"]");
        if count != index.message_count
            || format!("{:x}", digest.finalize()) != index.canonical_messages_sha256
        {
            self.0
                .degraded_segments
                .borrow_mut()
                .insert(reference.id.clone());
            return Err(
                CarryOverHistoryUnavailableError::new(io::Error::other(format!(
                    "Carryover segment {} canonical digest mismatch",
                    reference.id
                )))
                .into(),
            );
        }
        Ok(())
    }

    async fn read_segment_range(
        &self,
        reference: &CarryOverSegmentRef,
        start: u64,
        count: u64,
        signal: Option<&CancellationToken>,
    ) -> Result<Vec<ChatMessage>, CarryOverStoreError> {
        let end = reference
            .visible_message_count
            .min(start.saturating_add(count));
        if reference.stored_message_count == 0 || start >= end {
            return Ok(Vec::new());
        }
        let result = async {
            let index = self.read_index(&reference.id).await?;
            assert_segment_binding(reference, &index)?;
            let mut messages = Vec::new();
            for page in &index.pages {
                check_signal(signal)?;
                let first = page.first_sequence;
                let last = first + page.message_count;
                if last <= start || first >= end {
                    continue;
                }
                let decoded = decode_carry_over_page(
                    &self.segment_dir(&index.id).join(&page.file),
                    page,
                    signal,
                )
                .await?;
                let start = start.saturating_sub(first).min(decoded.len() as u64);
                let end = end.saturating_sub(first).min(decoded.len() as u64);
                messages.extend(
                    decoded
                        .into_iter()
                        .skip(start as usize)
                        .take((end - start) as usize),
                );
            }
            if messages.len() as u64 != end - start {
                return Err(integrity("Carryover page range is incomplete").into());
            }
            Ok(messages)
        }
        .await;
        result.map_err(|error: CarryOverStoreError| {
            if matches!(
                error,
                CarryOverStoreError::Page(CarryOverPageCodecError::Integrity(_))
            ) {
                self.0
                    .degraded_segments
                    .borrow_mut()
                    .insert(reference.id.clone());
            }
            error.unavailable()
        })
    }

    async fn stat_pages(
        &self,
        index: &CarryOverSegmentIndex,
        signal: Option<&CancellationToken>,
    ) -> Result<(), CarryOverStoreError> {
        for page in &index.pages {
            check_signal(signal)?;
            let stat = fs::metadata(self.segment_dir(&index.id).join(&page.file)).await?;
            if !stat.is_file() || stat.len() != page.compressed_bytes {
                self.0
                    .degraded_segments
                    .borrow_mut()
                    .insert(index.id.clone());
                return Err(io::Error::other(format!(
                    "Carryover page metadata mismatch in {}",
                    index.id
                ))
                .into());
            }
        }
        Ok(())
    }
}

struct ProjectionItem {
    order: usize,
    bytes: usize,
    message: ChatMessage,
}

struct ProjectionBuffer {
    gap: Option<ChatMessage>,
    asks: VecDeque<ProjectionItem>,
    others: VecDeque<ProjectionItem>,
    order: usize,
    bytes: usize,
}

impl ProjectionBuffer {
    fn new() -> Self {
        Self {
            gap: None,
            asks: VecDeque::new(),
            others: VecDeque::new(),
            order: 0,
            bytes: 2,
        }
    }

    fn add_batch(
        mut self,
        messages: Vec<ChatMessage>,
        max_bytes: usize,
    ) -> Result<Self, serde_json::Error> {
        for message in messages {
            if is_publication_gap_message(&message) {
                self.gap.get_or_insert(message);
            } else if is_projectable_message(&message) {
                let message = bound_projected_message(message);
                let bytes = serde_json::to_vec(&message)?.len() + 1;
                self.bytes += bytes;
                self.order += 1;
                let target = if matches!(message, ChatMessage::User(_)) {
                    &mut self.asks
                } else {
                    &mut self.others
                };
                target.push_back(ProjectionItem {
                    order: self.order,
                    bytes,
                    message,
                });
            }
        }
        // The oldest non-ask is evicted first; asks are the irreducible floor.
        while self.bytes > max_bytes
            && let Some(item) = self.others.pop_front()
        {
            self.bytes -= item.bytes;
        }
        Ok(self)
    }

    fn finish(mut self) -> Vec<ChatMessage> {
        let mut messages = Vec::with_capacity(
            self.asks.len() + self.others.len() + usize::from(self.gap.is_some()),
        );
        messages.extend(self.gap);
        while let (Some(ask), Some(other)) = (self.asks.front(), self.others.front()) {
            let next = if ask.order < other.order {
                &mut self.asks
            } else {
                &mut self.others
            };
            if let Some(item) = next.pop_front() {
                messages.push(item.message);
            }
        }
        messages.extend(
            self.asks
                .into_iter()
                .chain(self.others)
                .map(|item| item.message),
        );
        messages
    }
}
