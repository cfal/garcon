//! Replays the recordings of the `common/` modules ported by the interface
//! session (ADR-020). `bun rust/parity/cli.ts unit record <module> --tests
//! <its tests> --inputs tests/inputs/common/<module>.jsonl --out
//! tests/cases/common/<module>` writes each recording, and every case must
//! match here. One file per recorded module.

mod file_contracts;
mod gh_identity;
mod git_error;
mod git_request_validation;
mod helpers;
mod terminal;
mod terminal_error;
