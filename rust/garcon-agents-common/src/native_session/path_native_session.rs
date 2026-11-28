//! Ports `server-agents/common/src/native-session/path-native-session.ts`.

use garcon_interface::errors::{AgentIntegrationError, AgentIntegrationErrorCode};
use garcon_interface::transcript::AgentNativeSessionRef;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathNativeSessionValue {
    pub path: Option<String>,
    pub agent_session_id: Option<String>,
    pub model_endpoint_id: Option<String>,
}

pub struct PathNativeSessionCodec {
    owner_id: String,
}

impl PathNativeSessionCodec {
    pub fn new(owner_id: impl Into<String>) -> Self {
        Self {
            owner_id: owner_id.into(),
        }
    }

    pub fn encode(&self, value: PathNativeSessionValue) -> Option<AgentNativeSessionRef> {
        let object: Map<String, Value> = [
            ("path", value.path),
            ("agentSessionId", value.agent_session_id),
            ("modelEndpointId", value.model_endpoint_id),
        ]
        .into_iter()
        .filter_map(|(key, value)| {
            let value = value.filter(|value| !value.is_empty())?;
            Some((key.into(), Value::String(value)))
        })
        .collect();
        (!object.is_empty()).then(|| AgentNativeSessionRef {
            owner_id: self.owner_id.clone(),
            schema_version: 1,
            value: Value::Object(object).into(),
        })
    }

    pub fn decode(
        &self,
        reference: Option<&AgentNativeSessionRef>,
    ) -> Result<PathNativeSessionValue, AgentIntegrationError> {
        let Some(reference) = reference else {
            return Ok(PathNativeSessionValue::default());
        };
        let invalid = || {
            AgentIntegrationError::new(
                AgentIntegrationErrorCode::TRANSCRIPT_UNAVAILABLE,
                format!("Invalid native session for {}", self.owner_id),
                false,
                None,
            )
        };
        if reference.owner_id != self.owner_id || reference.schema_version != 1 {
            return Err(invalid());
        }
        let string = |key| match reference.value.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok((!value.is_empty()).then(|| value.clone())),
            Some(_) => Err(invalid()),
        };
        Ok(PathNativeSessionValue {
            path: string("path")?,
            agent_session_id: string("agentSessionId")?,
            model_endpoint_id: string("modelEndpointId")?,
        })
    }
}
