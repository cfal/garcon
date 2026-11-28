//! Ports `server-agents/common/src/acp/reconnect-policy.ts`.

use garcon_interface::resources::ExecutorResult;
use serde_json::{Map, Value};

use super::client::{AcpClient, AcpLoadSessionParams};
use super::errors::{is_recoverable_load_failure, plain_error};
use super::protocol::AcpSessionNewResult;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AcpAdvertisedCapabilities {
    pub load_session: bool,
    pub session_resume: bool,
}

/// Reconnects only to the original conversation, even if its ID is no longer recognized.
pub async fn reconnect_acp_session(
    client: &AcpClient,
    target: &AcpLoadSessionParams<'_>,
) -> ExecutorResult<AcpSessionNewResult> {
    let capabilities = client.get_advertised_capabilities();
    for resume in [true, false] {
        if (resume && !capabilities.session_resume) || (!resume && !capabilities.load_session) {
            continue;
        }
        let opened = if resume {
            client.resume_session(target).await
        } else {
            client.load_session(target).await
        };
        match opened {
            Ok(opened) => {
                let mut opened = match opened {
                    Value::Object(fields) => fields,
                    Value::Array(entries) => entries
                        .into_iter()
                        .enumerate()
                        .map(|(i, value)| (i.to_string(), value))
                        .collect(),
                    Value::String(text) => text
                        .encode_utf16()
                        .enumerate()
                        .map(|(i, unit)| {
                            (
                                i.to_string(),
                                Value::String(String::from_utf16_lossy(&[unit])),
                            )
                        })
                        .collect(),
                    _ => Map::new(),
                };
                opened.insert(
                    "sessionId".to_owned(),
                    Value::String(target.session_id.to_owned()),
                );
                return Ok(Value::Object(opened));
            }
            Err(error) if is_recoverable_load_failure(error.as_ref()) => {}
            Err(error) => return Err(error),
        }
    }
    Err(plain_error(format!(
        "Unable to restore ACP session {}. Start a new chat session.",
        target.session_id
    )))
}
