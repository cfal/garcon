//! Controller-owned stores.
//!
//! Ports the stores under `server/controller/` (auth, settings, and the workspace
//! catalogs), one module per TypeScript file.

pub mod auth;
pub mod settings;
