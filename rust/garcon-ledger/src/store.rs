use std::{
    cell::{Cell, RefCell},
    mem,
    rc::Rc,
    sync::LazyLock,
};

use garcon_base::{
    event_loop_stalls::ActivityTracker,
    log::{Logger, ScopedLogger, create_logger},
};
use garcon_contract::{
    chat_message_coercion::ChatContentMode,
    chat_row_contracts::{parse_chat_row_content, parse_chat_row_title},
    preambles::PendingPreambleBoundary,
};
use garcon_js::{
    clock::{Clock, SystemClock, to_iso_string},
    is_safe_integer,
    path::native,
};
use indexmap::IndexMap;
use rusqlite::{OptionalExtension, params};

use crate::{
    codec::{cli_row_fingerprint, parse_ledger_cli_row_notice_detail},
    connection_entry::{ConnectionCloseAttempt, ConnectionEntry},
    connection_setup::{
        LedgerSynchronous, close_connection, open_connection, rehydrate_connection,
    },
    contracts::{
        AppendChatRowRequest, AppendChatRowResult, AppendInputRequest,
        AppendSelectionChangeNoticeResult, InputComposition, LedgerCheckpoint, LedgerNoticeDetail,
        LedgerPreambleSelectionChangedNoticeDetail, LedgerRow, LedgerRowData, LedgerRowDraft,
        LedgerUserInputDetail, PREAMBLES_UPDATED_MESSAGE, TranscriptNativeActivityState,
        TranscriptPage, TranscriptView, TranscriptViewId, TranscriptViewStatus, transcript_view_id,
    },
    errors::{LedgerCodecError, LedgerError},
    failure_fences::{LedgerFailureFences, SharedLedgerFailure},
    file_stat::stat_size_if_exists,
    input_composition::{compose_input_prompt, read_resend_candidates},
    input_submission::{matching_input_submission, read_submission},
    native_activity_query::read_provider_activity_watermark,
    preamble_application::{has_preamble_boundary_proof, prepare_preamble_input},
    raw_page::read_raw_page,
    session_query::find_current_session,
    sqlite_operations::{LedgerResult, as_error, bind_ordinal, run_query, run_transaction},
    staging_views::{StagingViews, encode_drafts, insert_encoded_rows, materialize_rows},
};

mod activity;
mod anchors;
mod bulk;
mod cleanup;
mod read_pages;
pub use anchors::{TranscriptReadSignal, TranscriptWatermark};
pub use bulk::StageViewInput;

const DEFAULT_CONNECTION_CACHE_SIZE: usize = 10;
static LOGGER: LazyLock<ScopedLogger> = LazyLock::new(|| create_logger("ledger:store"));

#[derive(Default)]
pub struct TranscriptLedgerStoreOptions {
    pub connection_cache_size: Option<usize>,
    pub create_view_id: Option<Rc<dyn Fn() -> TranscriptViewId>>,
    pub now: Option<Rc<dyn Fn() -> LedgerResult<String>>>,
    pub synchronous: LedgerSynchronous,
    pub activity_tracker: Option<Rc<ActivityTracker>>,
}

pub struct InitializeViewInput<'a> {
    pub view_id: Option<TranscriptViewId>,
    pub content_start_ordinal: u64,
    pub rows: &'a [LedgerRowDraft],
}

pub struct TranscriptLedgerStore {
    state: RefCell<StoreState>,
    staging: Rc<StagingViews>,
    anchor_read_epoch: Cell<u64>,
    activity_reads: activity::ActivityReads,
    create_view_id: Rc<dyn Fn() -> LedgerResult<TranscriptViewId>>,
    now: Rc<dyn Fn() -> LedgerResult<String>>,
}

struct StoreState {
    connections: ConnectionCache,
    fences: LedgerFailureFences,
}

impl TranscriptLedgerStore {
    pub fn new(root_directory: &str, options: TranscriptLedgerStoreOptions) -> LedgerResult<Self> {
        let root_directory = crate::directories::ensure_ledger_root_directory(root_directory)?;
        let cache_size = options
            .connection_cache_size
            .unwrap_or(DEFAULT_CONNECTION_CACHE_SIZE);
        if cache_size < 1 || !is_safe_integer(cache_size as f64) {
            return Err(type_error(
                "Ledger connection cache size must be a positive integer",
            ));
        }
        let create_view_id: Rc<dyn Fn() -> LedgerResult<TranscriptViewId>> =
            match options.create_view_id {
                Some(create) => Rc::new(move || Ok(create())),
                None => Rc::new(|| Ok(transcript_view_id(&uuid::Uuid::new_v4().to_string())?)),
            };
        let staging = Rc::new(StagingViews::default());
        Ok(Self {
            state: RefCell::new(StoreState {
                connections: ConnectionCache {
                    root_directory,
                    staging: staging.clone(),
                    cache_size,
                    synchronous: options.synchronous,
                    activity_tracker: options.activity_tracker,
                    entries: IndexMap::new(),
                    failed_close: IndexMap::new(),
                    open_failures: IndexMap::new(),
                },
                fences: LedgerFailureFences::default(),
            }),
            staging,
            anchor_read_epoch: Cell::new(0),
            activity_reads: activity::ActivityReads::default(),
            create_view_id,
            now: options
                .now
                .unwrap_or_else(|| Rc::new(|| Ok(to_iso_string(SystemClock.now_ms())?))),
        })
    }

    pub fn current_view(&self, chat_id: &str) -> LedgerResult<Option<TranscriptView>> {
        self.read(chat_id, |entry| Ok(entry.current.clone()))
    }

    pub fn existing_current_view(&self, chat_id: &str) -> LedgerResult<Option<TranscriptView>> {
        validate_chat_directory_name(chat_id)?;
        {
            let state = self.state.borrow();
            let cache = &state.connections;
            if !cache.entries.contains_key(chat_id)
                && !cache.open_failures.contains_key(chat_id)
                && !state.fences.has_read_failure(chat_id)
            {
                let database_path =
                    native::join(&[&cache.root_directory, chat_id, "ledger.sqlite"]);
                if stat_size_if_exists(&database_path)?.unwrap_or(0) == 0 {
                    return Ok(None);
                }
            }
        }
        self.current_view(chat_id)
    }

    pub fn initialize_current_view(
        &self,
        chat_id: &str,
        input: InitializeViewInput<'_>,
    ) -> LedgerResult<TranscriptView> {
        validate_content_start_ordinal(input.content_start_ordinal, input.rows.len())?;
        let view_id = match input.view_id {
            Some(view_id) => view_id,
            None => (self.create_view_id)()?,
        };
        let encoded = encode_drafts(input.rows)?;
        materialize_rows(&view_id, &encoded, 1)?;
        self.write(chat_id, |entry| {
            if let Some(current) = &entry.current {
                return Ok(current.clone());
            }
            let created_at = (self.now)()?;
            run_transaction(&entry.db, || {
                entry
                    .db
                    .prepare_cached(
                        "
          INSERT INTO transcript_views(view_id, status, created_at, content_start_ordinal)
          VALUES (?, 'current', ?, ?)
        ",
                    )
                    .map_err(as_error)?
                    .execute(params![
                        view_id.as_str(),
                        created_at,
                        bind_ordinal(input.content_start_ordinal)
                    ])
                    .map_err(as_error)?;
                insert_encoded_rows(&entry.db, &view_id, &encoded, 1)
            })?;
            let view = TranscriptView {
                view_id,
                status: TranscriptViewStatus::Current,
                created_at,
                content_start_ordinal: input.content_start_ordinal,
            };
            entry.current = Some(view.clone());
            entry.next_ordinal = input.rows.len() as u64 + 1;
            Ok(view)
        })
    }

    pub fn append(
        &self,
        chat_id: &str,
        expected_view_id: &TranscriptViewId,
        drafts: &[LedgerRowDraft],
    ) -> LedgerResult<Vec<LedgerRow>> {
        if drafts.is_empty() {
            return Ok(Vec::new());
        }
        let encoded = encode_drafts(drafts)?;
        self.write(chat_id, |entry| {
            assert_current(entry, expected_view_id)?;
            let first_ordinal = entry.next_ordinal;
            let rows = materialize_rows(expected_view_id, &encoded, first_ordinal)?;
            run_transaction(&entry.db, || {
                insert_encoded_rows(&entry.db, expected_view_id, &encoded, first_ordinal)
            })?;
            entry.next_ordinal += drafts.len() as u64;
            Ok(rows)
        })
    }

    pub fn has_matching_input_submission(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        detail: &LedgerUserInputDetail,
    ) -> LedgerResult<bool> {
        self.read(chat_id, |entry| {
            assert_current(entry, view_id)?;
            Ok(matching_input_submission(&entry.db, view_id, detail)?.is_some())
        })
    }

    pub fn append_input_and_compose(
        &self,
        chat_id: &str,
        request: AppendInputRequest<'_>,
    ) -> LedgerResult<InputComposition> {
        self.write(chat_id, |entry| {
            assert_current(entry, request.view_id)?;
            if let Some(existing) =
                matching_input_submission(&entry.db, request.view_id, request.detail)?
            {
                return Ok(InputComposition {
                    input: existing,
                    committed_rows: Vec::new(),
                    prompt: Vec::new(),
                    provider_prefix: String::new(),
                    inserted: false,
                });
            }
            let prepared = prepare_preamble_input(
                chat_id,
                request.at,
                request.detail,
                request.preamble_boundary,
                request.preambles,
            )?;
            let encoded = encode_drafts(&prepared.drafts)?;
            let first_ordinal = entry.next_ordinal;
            let committed_rows = materialize_rows(request.view_id, &encoded, first_ordinal)?;
            // INFALLIBLE: preparing preambles always produces a final input draft.
            let input = committed_rows.last().expect("prepared input row").clone();
            let prompt = run_transaction(&entry.db, || {
                insert_encoded_rows(&entry.db, request.view_id, &encoded, first_ordinal)?;
                if prepared.detail.steer
                    || prepared
                        .detail
                        .message
                        .metadata
                        .as_ref()
                        .and_then(|metadata| metadata.content_mode)
                        == Some(ChatContentMode::Literal)
                {
                    Ok(vec![input.clone()])
                } else {
                    compose_input_prompt(entry, request.view_id, &input, request.excluded_ordinals)
                }
            })?;
            entry.next_ordinal += committed_rows.len() as u64;
            Ok(InputComposition {
                input,
                committed_rows,
                prompt,
                provider_prefix: prepared.provider_prefix,
                inserted: true,
            })
        })
    }

    pub fn has_preamble_boundary_proof(
        &self,
        chat_id: &str,
        boundary: &PendingPreambleBoundary,
    ) -> LedgerResult<bool> {
        self.read(chat_id, |entry| {
            let current = require_current(entry)?;
            has_preamble_boundary_proof(&entry.db, &current.view_id, boundary)
        })
    }

    pub fn append_chat_row(
        &self,
        chat_id: &str,
        request: AppendChatRowRequest<'_>,
    ) -> LedgerResult<AppendChatRowResult> {
        let detail_json = garcon_js::json::from_slice(&serde_json::to_vec(request.detail)?)?;
        let mut detail = parse_ledger_cli_row_notice_detail(&detail_json)?
            .ok_or_else(|| type_error("CLI row notice detail is required"))?;
        let title_json = serde_json::json!(detail.title);
        detail.title = parse_chat_row_title(&title_json)?.map(str::to_owned);
        let content_json = serde_json::json!(request.message);
        let message = parse_chat_row_content(&content_json)?;
        let draft = LedgerRowDraft {
            at: request.at.into(),
            provider_meta: None,
            data: LedgerRowData::Notice {
                message: message.into(),
                detail: LedgerNoticeDetail::CliRow(detail.clone()),
            },
        };
        let drafts = [draft];
        let encoded = encode_drafts(&drafts)?;
        self.write(chat_id, |entry| {
            assert_current(entry, request.view_id)?;
            if let Some(existing) =
                read_submission(&entry.db, request.view_id, &detail.client_message_id)?
            {
                if let LedgerRowData::Notice {
                    message: existing_message,
                    detail: LedgerNoticeDetail::CliRow(existing_detail),
                } = &existing.data
                    && existing.provider_meta.is_none()
                    && cli_row_fingerprint(existing_message, existing_detail)?
                        == cli_row_fingerprint(message, &detail)?
                {
                    return Ok(AppendChatRowResult {
                        row: existing,
                        inserted: false,
                    });
                }
                return Err(LedgerError::SubmissionConflict {
                    client_message_id: detail.client_message_id,
                }
                .into());
            }
            let row = append_notice(entry, request.view_id, &encoded)?;
            Ok(AppendChatRowResult {
                row,
                inserted: true,
            })
        })
    }

    pub fn append_selection_change_notice(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        at: &str,
        detail: &LedgerPreambleSelectionChangedNoticeDetail,
    ) -> LedgerResult<AppendSelectionChangeNoticeResult> {
        let drafts = [LedgerRowDraft {
            at: at.into(),
            provider_meta: None,
            data: LedgerRowData::Notice {
                message: PREAMBLES_UPDATED_MESSAGE.into(),
                detail: LedgerNoticeDetail::PreambleSelectionChanged(detail.clone()),
            },
        }];
        let encoded = encode_drafts(&drafts)?;
        self.write(chat_id, |entry| {
            assert_current(entry, view_id)?;
            if let Some(existing) = read_submission(&entry.db, view_id, &detail.client_message_id)?
            {
                if let LedgerRowData::Notice {
                    detail: LedgerNoticeDetail::PreambleSelectionChanged(existing_detail),
                    ..
                } = &existing.data
                    && existing.provider_meta.is_none()
                    && existing_detail.request_fingerprint == detail.request_fingerprint
                {
                    return Ok(AppendSelectionChangeNoticeResult {
                        row: existing,
                        inserted: false,
                    });
                }
                return Err(LedgerError::SubmissionConflict {
                    client_message_id: detail.client_message_id.clone(),
                }
                .into());
            }
            let row = append_notice(entry, view_id, &encoded)?;
            Ok(AppendSelectionChangeNoticeResult {
                row,
                inserted: true,
            })
        })
    }

    pub fn resend_candidates(&self, chat_id: &str) -> LedgerResult<Vec<LedgerRow>> {
        self.read(chat_id, |entry| {
            let current = require_current(entry)?;
            read_resend_candidates(entry, &current.view_id)
        })
    }

    pub fn current_session(&self, chat_id: &str) -> LedgerResult<Option<LedgerRow>> {
        self.read(chat_id, |entry| {
            let view = require_current(entry)?;
            find_current_session(&entry.db, view)
        })
    }

    pub fn native_activity_state(
        &self,
        chat_id: &str,
    ) -> LedgerResult<TranscriptNativeActivityState> {
        self.read(chat_id, |entry| {
            let view = require_current(entry)?;
            let session = find_current_session(&entry.db, view)?;
            let provider_watermark = read_provider_activity_watermark(
                &entry.db,
                &view.view_id,
                view.content_start_ordinal,
            )?;
            Ok(TranscriptNativeActivityState {
                view_id: view.view_id.clone(),
                session,
                provider_watermark,
            })
        })
    }

    pub fn find_submission_row(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        client_message_id: &str,
    ) -> LedgerResult<Option<LedgerRow>> {
        self.read(chat_id, |entry| {
            assert_current(entry, view_id)?;
            read_submission(&entry.db, view_id, client_message_id)
        })
    }

    pub fn page(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        limit: u64,
        before: Option<u64>,
    ) -> LedgerResult<TranscriptPage> {
        read_pages::validate_page_limit(limit)?;
        if before.is_some_and(|value| value < 1 || !is_safe_integer(value as f64)) {
            return Err(type_error(
                "Transcript page cursor must be a positive integer",
            ));
        }
        self.read(chat_id, |entry| {
            assert_current(entry, view_id)?;
            read_raw_page(&entry.db, view_id, limit, before)
        })
    }

    pub fn advance_content_start(
        &self,
        chat_id: &str,
        view_id: &TranscriptViewId,
        content_start_ordinal: u64,
    ) -> LedgerResult<TranscriptView> {
        self.write(chat_id, |entry| {
            let mut current = assert_current(entry, view_id)?.clone();
            if !is_safe_integer(content_start_ordinal as f64)
                || content_start_ordinal < current.content_start_ordinal
                || content_start_ordinal > entry.next_ordinal
            {
                return Err(type_error(
                    "Content-start ordinal is outside the current transcript",
                ));
            }
            entry
                .db
                .prepare_cached(
                    "
        UPDATE transcript_views SET content_start_ordinal = ?
        WHERE view_id = ? AND status = 'current'
      ",
                )
                .map_err(as_error)?
                .execute(params![
                    bind_ordinal(content_start_ordinal),
                    view_id.as_str()
                ])
                .map_err(as_error)?;
            current.content_start_ordinal = content_start_ordinal;
            entry.current = Some(current.clone());
            Ok(current)
        })
    }

    pub fn checkpoint_for_handoff(&self, chat_id: &str) -> LedgerResult<LedgerCheckpoint> {
        self.write(chat_id, |entry| {
            let current = require_current(entry)?;
            let checkpoint = run_query(|| {
                entry
                    .db
                    .query_row("PRAGMA wal_checkpoint(FULL)", [], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, i64>(2)?,
                        ))
                    })
                    .optional()
            })?;
            let Some((busy_frames, log_frames, checkpointed_frames)) = checkpoint else {
                return Err(
                    LedgerError::Schema("Transcript checkpoint returned no result".into()).into(),
                );
            };
            if busy_frames != 0 || log_frames != checkpointed_frames {
                return Err(LedgerError::IncompleteCheckpoint {
                    busy_frames,
                    log_frames,
                    checkpointed_frames,
                }
                .into());
            }
            Ok(LedgerCheckpoint {
                view_id: current.view_id.clone(),
                ordinal: entry.next_ordinal - 1,
                log_frames,
                checkpointed_frames,
            })
        })
    }

    pub fn close_chat(&self, chat_id: &str) -> LedgerResult<()> {
        self.activity_reads.retire(chat_id);
        self.staging.abandon(chat_id);
        let mut state = self.state.borrow_mut();
        let cache = &mut state.connections;
        let entry = cache
            .entries
            .shift_remove(chat_id)
            .or_else(|| cache.failed_close.shift_remove(chat_id));
        entry.map(|entry| cache.close_entry(entry)).transpose()?;
        Ok(())
    }

    pub fn close(&self) -> LedgerResult<()> {
        self.anchor_read_epoch.set(self.anchor_read_epoch.get() + 1);
        self.activity_reads.close();
        self.staging.abandon_all();
        let mut state = self.state.borrow_mut();
        let cache = &mut state.connections;
        let mut entries = mem::take(&mut cache.failed_close);
        entries.extend(mem::take(&mut cache.entries));
        let mut first_failure = None;
        for (_, entry) in entries {
            if let Err(error) = cache.close_entry(entry)
                && first_failure.is_none()
            {
                first_failure = Some(error);
            }
        }
        if cache.failed_close.is_empty() {
            cache.open_failures.clear();
            state.fences.clear();
        }
        first_failure.map_or(Ok(()), Err)
    }

    pub(crate) fn activity_tracker(&self) -> Option<Rc<ActivityTracker>> {
        self.state.borrow().connections.activity_tracker.clone()
    }

    pub(crate) fn read<T>(
        &self,
        chat_id: &str,
        work: impl FnOnce(&mut ConnectionEntry) -> LedgerResult<T>,
    ) -> LedgerResult<T> {
        let StoreState {
            connections,
            fences,
        } = &mut *self.state.borrow_mut();
        fences.read(chat_id, || connections.available(chat_id), work)
    }

    pub(crate) fn write<T>(
        &self,
        chat_id: &str,
        work: impl FnOnce(&mut ConnectionEntry) -> LedgerResult<T>,
    ) -> LedgerResult<T> {
        let StoreState {
            connections,
            fences,
        } = &mut *self.state.borrow_mut();
        fences.write(
            chat_id,
            || connections.available(chat_id),
            work,
            rehydrate_connection,
        )
    }
}

struct ConnectionCache {
    root_directory: String,
    staging: Rc<StagingViews>,
    cache_size: usize,
    synchronous: LedgerSynchronous,
    activity_tracker: Option<Rc<ActivityTracker>>,
    entries: IndexMap<String, ConnectionEntry>,
    failed_close: IndexMap<String, ConnectionEntry>,
    open_failures: IndexMap<String, SharedLedgerFailure>,
}

impl ConnectionCache {
    fn available(&mut self, chat_id: &str) -> LedgerResult<&mut ConnectionEntry> {
        if let Some(open_failure) = self.open_failures.get(chat_id) {
            return Err(open_failure.fenced(chat_id));
        }
        if let Err(error) = self.ensure_connection(chat_id) {
            let failure = SharedLedgerFailure::new(error);
            self.open_failures.insert(chat_id.into(), failure.clone());
            return Err(failure.fenced(chat_id));
        }
        // INFALLIBLE: ensure_connection inserts or touches this entry with a positive cache size.
        Ok(self
            .entries
            .get_mut(chat_id)
            .expect("available connection was just inserted"))
    }

    fn ensure_connection(&mut self, chat_id: &str) -> LedgerResult<()> {
        validate_chat_directory_name(chat_id)?;
        if let Some((key, entry)) = self.entries.shift_remove_entry(chat_id) {
            self.entries.insert(key, entry);
            return Ok(());
        }
        let finish = self
            .activity_tracker
            .as_ref()
            .map(|tracker| tracker.track_activity("ledger open"));
        let opened = open_connection(
            &self.root_directory,
            chat_id,
            self.synchronous,
            &self.staging.retained(chat_id),
        );
        if let Some(finish) = finish {
            finish();
        }
        self.entries.insert(chat_id.into(), opened?);
        while self.entries.len() > self.cache_size {
            let Some((id, entry)) = self.entries.shift_remove_index(0) else {
                break;
            };
            if let Err(error) = self.close_entry(entry) {
                LOGGER.error(&format!(
                    "Ledger connection eviction failed; chat is fenced {id} {error}"
                ));
            }
        }
        Ok(())
    }

    fn close_entry(&mut self, entry: ConnectionEntry) -> LedgerResult<()> {
        let chat_id = entry.chat_id.clone();
        match close_connection(entry) {
            ConnectionCloseAttempt::Closed { checkpoint_failure } => {
                self.failed_close.shift_remove(&chat_id);
                if let Some(error) = checkpoint_failure {
                    LOGGER.warn(&format!(
                        "Passive checkpoint failed on ledger close {chat_id} {error}"
                    ));
                }
                Ok(())
            }
            ConnectionCloseAttempt::Failed { entry, failure } => {
                self.failed_close.insert(chat_id.clone(), *entry);
                self.open_failures
                    .insert(chat_id, SharedLedgerFailure::new(Box::new(failure.clone())));
                Err(Box::new(failure))
            }
        }
    }
}

pub(crate) fn require_current(entry: &ConnectionEntry) -> LedgerResult<&TranscriptView> {
    entry.current.as_ref().ok_or_else(|| {
        LedgerError::ViewNotInitialized {
            chat_id: entry.chat_id.clone(),
        }
        .into()
    })
}

pub(crate) fn assert_current<'a>(
    entry: &'a ConnectionEntry,
    expected: &TranscriptViewId,
) -> LedgerResult<&'a TranscriptView> {
    let current = require_current(entry)?;
    if current.view_id != *expected {
        return Err(LedgerError::StaleView {
            chat_id: entry.chat_id.clone(),
            requested_view_id: expected.to_string(),
            current_view_id: current.view_id.to_string(),
        }
        .into());
    }
    Ok(current)
}

fn validate_chat_directory_name(chat_id: &str) -> LedgerResult<()> {
    if !is_chat_directory_name(chat_id) {
        return Err(type_error("Chat ID is not a safe ledger directory name"));
    }
    Ok(())
}

fn is_chat_directory_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(crate) fn validate_content_start_ordinal(value: u64, row_count: usize) -> LedgerResult<()> {
    if !is_safe_integer(value as f64) || value < 1 || value > row_count as u64 + 1 {
        return Err(type_error(
            "Content-start ordinal must address the view or its append boundary",
        ));
    }
    Ok(())
}

fn type_error(message: &str) -> Box<dyn std::error::Error> {
    LedgerCodecError::Type(message.into()).into()
}

fn append_notice(
    entry: &mut ConnectionEntry,
    view_id: &TranscriptViewId,
    encoded: &[crate::staging_views::EncodedDraft<'_>],
) -> LedgerResult<LedgerRow> {
    let ordinal = entry.next_ordinal;
    let mut rows = materialize_rows(view_id, encoded, ordinal)?;
    run_transaction(&entry.db, || {
        insert_encoded_rows(&entry.db, view_id, encoded, ordinal)
    })?;
    entry.next_ordinal += 1;
    // INFALLIBLE: the notice append paths each pass one draft.
    Ok(rows.pop().expect("materialized notice"))
}

#[cfg(test)]
mod close_tests {
    use std::ptr;

    use garcon_base::errors::DiagnosticError;
    use rusqlite::ffi;

    use super::*;
    use crate::{errors::safe_fence_diagnostic, sqlite_operations::SqliteError};

    #[test]
    fn close_errors_remain_concrete_and_the_chat_keeps_its_fence() {
        for close_all in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let store = TranscriptLedgerStore::new(
                root.path().to_str().unwrap(),
                TranscriptLedgerStoreOptions::default(),
            )
            .unwrap();
            let mut statement = ptr::null_mut();
            store
                .read("test", |entry| {
                    // SAFETY: The handle is live during preparation. The raw, uncached
                    // statement is finalized below, after SQLite refuses to close the
                    // connection while it owns that statement.
                    let code = unsafe {
                        ffi::sqlite3_prepare_v2(
                            entry.db.handle(),
                            c"SELECT 1".as_ptr(),
                            -1,
                            &mut statement,
                            ptr::null_mut(),
                        )
                    };
                    assert_eq!(code, ffi::SQLITE_OK);
                    assert!(!statement.is_null());
                    Ok(())
                })
                .unwrap();
            let result = if close_all {
                store.close()
            } else {
                store.close_chat("test")
            };
            // SAFETY: A live statement prevents SQLite from closing its connection.
            // The prepare above succeeded; this is the only finalization.
            let finalized = unsafe { ffi::sqlite3_finalize(statement) };
            assert_eq!(finalized, ffi::SQLITE_OK);
            let error = result.unwrap_err();
            let sqlite = error
                .downcast_ref::<SqliteError>()
                .expect("close returns its SQLite failure");
            assert_eq!(sqlite.diagnostic_metadata().code, Some("SQLITE_BUSY"));
            let fenced = store.read("test", |_| Ok(())).unwrap_err();
            assert_eq!(
                safe_fence_diagnostic(fenced.as_ref()).cause_code,
                "SQLITE_BUSY"
            );
            store.close().unwrap();
        }
    }
}
