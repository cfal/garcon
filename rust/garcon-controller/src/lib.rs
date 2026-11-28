//! The controller: configuration and the composition root (ADR-022).
//!
//! Ports `server/controller/config.ts` and `server/controller/server.ts`. The
//! Local executor is injected by the binary that composes it; this crate never
//! depends on an executor crate.

pub mod config;
