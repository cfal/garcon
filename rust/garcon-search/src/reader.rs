use std::collections::HashMap;

use garcon_contract::chat_search::TranscriptSearchAllowedChat;
use garcon_js::Number;
use rusqlite::Connection;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::{
    query::{SearchError, SearchIndexOptions, search_transcript_index_v1},
    schema::{SearchSchemaError, open_search_read_database},
    worker_protocol::{
        ReaderEvent, ReaderFrame, ReaderRequest, ReaderSearch, WorkerFailure, valid_reader_event,
        valid_reader_request,
    },
    worker_supervisor::{Command, Reply, SearchWorker, WorkerError, WorkerSlot},
};

pub type ReaderWorker = SearchWorker<ReaderRequest, ReaderEvent>;
pub type ReaderSlot = WorkerSlot<ReaderRequest, ReaderEvent>;

pub fn reader_slot() -> ReaderSlot {
    WorkerSlot::new(
        spawn_reader,
        ReaderRequest::Open,
        || ReaderRequest::Close,
        |event| matches!(event, ReaderEvent::Opened),
        |event| matches!(event, ReaderEvent::Closed),
    )
}

pub fn spawn_reader(epoch: u64) -> std::io::Result<ReaderWorker> {
    SearchWorker::spawn(
        "garcon-transcript-search-reader",
        epoch,
        "SEARCH_TIMEOUT",
        move |receiver, retired| run(epoch, receiver, &retired),
    )
}

struct PendingSearch {
    options: ReaderSearch,
    allowed_chats: Vec<TranscriptSearchAllowedChat>,
    next_chunk_index: u64,
    reply: Reply<ReaderEvent>,
}

#[derive(Default)]
struct Reader {
    db: Option<Connection>,
    searches: HashMap<u64, PendingSearch>,
}

fn run(
    epoch: u64,
    mut receiver: mpsc::Receiver<Command<ReaderRequest, ReaderEvent>>,
    retired: &CancellationToken,
) {
    let mut reader = Reader::default();
    while let Some(command) = receiver.blocking_recv() {
        if retired.is_cancelled() {
            break;
        }
        if command.identity.epoch != epoch {
            continue;
        }
        if reader.handle(command, retired) {
            break;
        }
    }
}

impl Reader {
    fn handle(
        &mut self,
        Command {
            identity,
            request,
            reply,
        }: Command<ReaderRequest, ReaderEvent>,
        retired: &CancellationToken,
    ) -> bool {
        if !valid_reader_request(&request) {
            let _ = reply.send.blocking_send((
                identity,
                Err(WorkerFailure::new("INVALID_READER_REQUEST", false).into()),
            ));
            return false;
        }
        let close = matches!(request, ReaderRequest::Close);
        let search = matches!(request, ReaderRequest::Search(_));
        self.searches
            .retain(|_, active| !active.reply.send.is_closed());
        let response = self.process(identity.request_id, request, &reply);
        if search && response.is_err() {
            self.searches.remove(&identity.request_id);
        }
        if retired.is_cancelled() {
            return true;
        }
        let value = match response {
            Ok(Some(event)) if !valid_reader_event(&event, identity) => {
                Err(WorkerError::InvalidMessage)
            }
            Ok(Some(event)) => Ok(event),
            Ok(None) => return close,
            Err(error) => Err(error.into()),
        };
        let _ = reply.send.blocking_send((identity, value));
        close
    }

    fn process(
        &mut self,
        request_id: u64,
        request: ReaderRequest,
        reply: &Reply<ReaderEvent>,
    ) -> Result<Option<ReaderEvent>, WorkerFailure> {
        match request {
            ReaderRequest::Open(path) => {
                self.db = Some(
                    open_search_read_database(&path).map_err(|error| match error {
                        SearchSchemaError::InvalidSchema => {
                            WorkerFailure::new("SEARCH_SCHEMA_INVALID", false)
                        }
                        _ => WorkerFailure::new("READER_INTERNAL", true),
                    })?,
                );
                Ok(Some(ReaderEvent::Opened))
            }
            ReaderRequest::Search(ReaderFrame::SearchStart(options)) => {
                self.db.as_ref().ok_or_else(unavailable)?;
                if self.searches.contains_key(&request_id) {
                    return Err(WorkerFailure::new("INVALID_SEARCH_REQUEST", false));
                }
                self.searches.insert(
                    request_id,
                    PendingSearch {
                        options,
                        allowed_chats: Vec::new(),
                        next_chunk_index: 0,
                        reply: reply.clone(),
                    },
                );
                Ok(None)
            }
            ReaderRequest::Search(ReaderFrame::SearchAllowlistChunk {
                chunk_index,
                allowed_chats,
                done,
            }) => {
                let connection = self.db.as_ref().ok_or_else(unavailable)?;
                let search = self
                    .searches
                    .get_mut(&request_id)
                    .filter(|search| search.next_chunk_index == chunk_index)
                    .ok_or_else(|| WorkerFailure::new("INVALID_SEARCH_FRAME", false))?;
                search.allowed_chats.extend(allowed_chats);
                search.next_chunk_index += 1;
                if !done {
                    return Ok(None);
                }
                let search = self
                    .searches
                    .remove(&request_id)
                    .expect("checked search request");
                let options = search.options;
                let result = search_transcript_index_v1(
                    connection,
                    SearchIndexOptions {
                        query: &options.query,
                        allowed_chats: &search.allowed_chats,
                        order: options.order,
                        mode: options.mode,
                        offset: Some(Number(options.offset as f64)),
                        limit: Some(Number(options.limit as f64)),
                        snippet_limit: Some(Number(options.snippet_limit as f64)),
                    },
                )
                .map_err(|error| match error {
                    SearchError::Sql(_) | SearchError::Json(_) => {
                        WorkerFailure::new("READER_INTERNAL", true)
                    }
                    _ => WorkerFailure::new("INVALID_SEARCH_REQUEST", false),
                })?;
                Ok(Some(ReaderEvent::SearchResult(result)))
            }
            ReaderRequest::Close => {
                self.searches.clear();
                self.db.take();
                Ok(Some(ReaderEvent::Closed))
            }
        }
    }
}

fn unavailable() -> WorkerFailure {
    WorkerFailure::new("READER_UNAVAILABLE", true)
}
