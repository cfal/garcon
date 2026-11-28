//! Ports `server-agents/common/src/acp/`: the runtime shared by the ACP integrations.

pub mod client;
pub mod errors;
pub mod event_converter;
pub mod in_band_failure;
pub mod policy;
pub mod protocol;
pub mod reconnect_policy;
pub mod transport;
pub mod turn_prompts;

/// JavaScript semantics of the JSON values the ACP modules read.
mod json_values;
#[cfg(test)]
pub(crate) mod testing;
mod timers;
