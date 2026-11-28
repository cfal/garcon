use std::error::Error;

use rusqlite::Connection;

use crate::contracts::TranscriptView;

#[derive(Debug)]
pub struct ViewRecord {
    pub view_id: String,
    pub status: String,
    pub created_at: String,
    pub content_start_ordinal: u64,
}

#[derive(Debug)]
pub enum ConnectionCloseAttempt {
    Closed {
        checkpoint_failure: Option<Box<dyn Error>>,
    },
    Failed {
        entry: Box<ConnectionEntry>,
        failure: Box<dyn Error>,
    },
}

#[derive(Debug)]
pub struct ConnectionEntry {
    pub chat_id: String,
    pub directory: String,
    pub db: Connection,
    pub current: Option<TranscriptView>,
    pub next_ordinal: u64,
}
