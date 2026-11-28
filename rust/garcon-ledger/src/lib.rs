//! Controller-owned transcript storage.

pub mod codec;
pub mod connection_entry;
pub mod connection_setup;
pub mod contracts;
pub mod directories;
pub mod errors;
pub mod failure_fences;
pub mod file_stat;
pub mod input_composition;
pub mod input_submission;
pub mod preamble_application;
pub mod raw_page;
pub mod session_query;
pub mod sqlite_operations;
pub mod staging_views;
pub mod store;
pub mod ticket_outcome_query;
