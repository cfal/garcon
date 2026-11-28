//! The durable preamble catalog and its workspace rules.

type Result<T, E = Box<dyn std::error::Error>> = std::result::Result<T, E>;

mod bundled;
mod catalog_budget;
pub mod errors;
pub mod matching;
mod project_path_service;
pub mod service;
pub mod setup;
pub mod store;
