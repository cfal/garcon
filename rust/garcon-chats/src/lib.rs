//! Chat authority for the controller.

pub mod agent_ownership_journal;
pub mod agent_ownership_journal_format;
pub mod carryover;
pub mod chat_activity_outcomes;
pub mod chat_activity_status;
pub mod chat_id_allocator;
pub mod chat_list_projector;
pub mod chat_message_reader;
pub mod chat_order_ranking;
pub mod chat_parent_mutation_service;
pub mod chat_processing_activity;
pub mod chat_row_service;
pub mod chat_snapshot;
pub mod chat_tag_mutation_service;
pub mod chat_title;
pub mod chat_transient_feed;
pub mod last_selected_chat_state;
pub mod metadata_store;
pub mod native_activity;
pub mod native_activity_page_reader;
pub mod preambles;
pub mod registry_contracts;
pub mod registry_entry_codec;
pub mod store;
pub mod task_worker;
pub mod token_fitting;
