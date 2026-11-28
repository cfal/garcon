//! Replays the recordings of the `common/` modules ported by the interface
//! session (ADR-020). `bun rust/parity/cli.ts unit record <module> --tests
//! <its tests> --inputs tests/inputs/common/<module>.jsonl --out
//! tests/cases/common/<module>` writes each recording, and every case must
//! match here. One file per recorded module.

mod agent_cli_update;
mod bun;
mod chat_activity;
mod chat_boards;
mod chat_command_contracts;
mod chat_parentage;
mod chat_preamble_selection_contracts;
mod chat_tag_mutations;
mod command_output;
mod command_request_validation;
mod domain_wire;
mod file_contracts;
mod gh_identity;
mod git_error;
mod git_execution;
mod git_refs;
mod git_request_validation;
mod git_wire;
mod helpers;
mod preamble_prefix;
mod preambles;
mod prompt_refinement;
mod pull_request_reviews;
mod schedule_duration;
mod scheduled_prompt_render;
mod scheduled_prompts;
mod snippet_template;
mod snippets;
mod tags;
mod template_tokens;
mod terminal;
mod terminal_error;
mod tickets;
mod transcript_projection;
mod transcript_seed_projection;
mod transcript_seed_receipts;
mod usage;
