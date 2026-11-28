//! Replays unit cases recorded from the TypeScript original (ADR-020).
//!
//! `bun rust/parity/cli.ts unit record` writes what the original's tests made
//! its exported functions do, with trap inputs added, as `cases.jsonl` and a
//! `manifest.json` holding the case file's SHA-256. A ported crate's test
//! hands that directory to [`replay`] with a dispatcher that calls the ported
//! function for a case's function name and arguments. Every case must match.
//!
//! Arguments reach the dispatcher as they were recorded, so a value JSON
//! cannot hold is a marker object. A dispatcher reads an argument with the
//! readers here ([`round_tripped`], [`unknown`], [`text`], [`javascript_number`],
//! [`bigint`]), which give the port the JSON the recorded value round-trips to.
//! An argument that holds a marker JSON cannot carry, such as a Date or a Map,
//! is decoded with [`markers`], which also builds the markers a result needs.
//!
//! ```no_run
//! use serde_json::json;
//!
//! use garcon_cases::{CaseError, replay, text};
//!
//! # fn parse_label(label: &str) -> Option<String> {
//! #     let label = label.trim();
//! #     (!label.is_empty()).then(|| label.to_owned())
//! # }
//! # fn main() {
//! replay("tests/cases/common/labels", |function, args| match function {
//!     "parseLabel" => Ok(json!(text(function, args.first())?.and_then(parse_label))),
//!     _ => Err(CaseError::unhandled(function)),
//! });
//! # }
//! ```

mod arguments;
mod compare;
mod manifest;
pub mod markers;
mod replay;

pub use arguments::{bigint, javascript_number, round_tripped, text, unknown};
pub use replay::{CaseError, Stats, replay};
