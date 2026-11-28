//! The provider interface conformance kit (ADR-027).
//!
//! Call this from the provider crate's current-thread test on a `LocalSet`,
//! passing its real integration class and an isolated fixture host:
//!
//! ```no_run
//! use garcon_interface::{
//!     host::AgentHost,
//!     integration::AgentIntegrationClass,
//!     testing::{AgentIntegrationConformanceOptions, run_agent_integration_conformance},
//! };
//!
//! async fn check_provider(class: &dyn AgentIntegrationClass, host: AgentHost) {
//!     let integration = class.create(host);
//!     run_agent_integration_conformance(AgentIntegrationConformanceOptions {
//!         integration_id: class.integration_id(),
//!         api_version: class.api_version(),
//!         integration: &integration,
//!     })
//!     .await
//!     .expect("provider conforms");
//! }
//! ```
//!
//! Advertising both literal execution and a single-query facet reports
//! `Agent integration other has an invalid literal execution contract` for
//! integration `other`. Removing that check makes
//! `rejects_incompatible_literal_execution_capabilities` fail because the
//! contradictory facets incorrectly pass validation.

mod conformance;

pub use conformance::{
    AgentIntegrationConformanceOptions, run_agent_integration_conformance,
    validate_agent_integration,
};
