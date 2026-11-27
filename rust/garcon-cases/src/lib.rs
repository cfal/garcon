//! Replays unit cases recorded from the TypeScript original (ADR-020).
//!
//! `bun rust/parity/cli.ts unit record` writes what the original's tests made
//! its exported functions do, with trap inputs added, as `cases.jsonl` and a
//! `manifest.json` holding the case file's SHA-256. A ported crate's test
//! hands that directory to [`replay`] with a dispatcher that calls the ported
//! function for a case's function name and arguments. Every case must match.
//!
//! Arguments reach the dispatcher as they were recorded, so a value JSON
//! cannot hold is a marker object. A function that takes JSON or `undefined`
//! reads an argument with [`json_argument`]; anything else reads markers with
//! [`markers`] and builds the ones a result needs with it too.
//!
//! ```no_run
//! use serde_json::json;
//!
//! use garcon_cases::{CaseError, json_argument, replay};
//!
//! # fn parse_label(value: Option<&serde_json::Value>) -> Option<String> {
//! #     value?.as_str().map(|label| label.trim().to_owned()).filter(|label| !label.is_empty())
//! # }
//! # fn main() {
//! replay("tests/cases/common/labels", |function, args| match function {
//!     "parseLabel" => Ok(json!(parse_label(json_argument(function, args.first())?))),
//!     _ => Err(CaseError::unhandled(function)),
//! });
//! # }
//! ```

mod compare;
mod manifest;
pub mod markers;
mod replay;

pub use markers::json_argument;
pub use replay::{CaseError, Stats, replay};
