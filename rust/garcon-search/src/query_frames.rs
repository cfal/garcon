//! Frames a reader request without changing allowlist priority.

use garcon_contract::chat_search::TranscriptSearchAllowedChat;

use crate::worker_protocol::{
    MAX_ALLOWLIST_PER_FRAME, MAX_FRAME_BYTES, ReaderFrame, ReaderSearch, WorkerFailure,
    json_bytes_within,
};

pub fn search_frames(
    search: ReaderSearch,
    allowed_chats: Vec<TranscriptSearchAllowedChat>,
) -> Result<Vec<ReaderFrame>, WorkerFailure> {
    let mut frames = vec![ReaderFrame::SearchStart(search)];
    let mut remaining = allowed_chats.into_iter();
    let mut chunk_index = 0;
    loop {
        let allowed_chats: Vec<_> = remaining.by_ref().take(MAX_ALLOWLIST_PER_FRAME).collect();
        if !json_bytes_within(&allowed_chats, MAX_FRAME_BYTES) {
            return Err(WorkerFailure::new("SEARCH_ALLOWLIST_TOO_LARGE", false));
        }
        let done = remaining.len() == 0;
        frames.push(ReaderFrame::SearchAllowlistChunk {
            chunk_index,
            allowed_chats,
            done,
        });
        if done {
            return Ok(frames);
        }
        chunk_index += 1;
    }
}
