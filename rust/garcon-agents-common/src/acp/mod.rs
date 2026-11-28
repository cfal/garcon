//! Ports `server-agents/common/src/acp/`: the runtime shared by the ACP integrations.

pub mod errors;
pub mod event_converter;
pub mod in_band_failure;
pub mod protocol;
pub mod transport;

/// JavaScript semantics of the JSON values the ACP modules read.
mod json_values;
#[cfg(test)]
pub(crate) mod testing;
mod timers;
