//! Ports `server/remote/transport/rpc-lane.ts`.

use garcon_contract::executors::is_remote_executor_id;
use garcon_js::json::Opaque;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RpcLane {
    Primary,
    Bulk,
}

pub const RPC_LANES: [RpcLane; 2] = [RpcLane::Primary, RpcLane::Bulk];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BulkControlType {
    Prepare,
    Prepared,
    Connect,
    Activate,
    Active,
    Lost,
}

impl BulkControlType {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Prepare => "bulk-prepare",
            Self::Prepared => "bulk-prepared",
            Self::Connect => "bulk-connect",
            Self::Activate => "bulk-activate",
            Self::Active => "bulk-active",
            Self::Lost => "bulk-lost",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "bulk-prepare" => Some(Self::Prepare),
            "bulk-prepared" => Some(Self::Prepared),
            "bulk-connect" => Some(Self::Connect),
            "bulk-activate" => Some(Self::Activate),
            "bulk-active" => Some(Self::Active),
            "bulk-lost" => Some(Self::Lost),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkConnectionControl {
    #[serde(rename = "type")]
    control_type: Opaque,
    pub session_id: String,
}

impl BulkConnectionControl {
    pub fn new(control_type: BulkControlType, session_id: String) -> Self {
        Self {
            control_type: Opaque::from_value(Value::String(control_type.as_str().to_owned())),
            session_id,
        }
    }

    pub fn control_type(&self) -> Option<BulkControlType> {
        self.control_type.as_str().and_then(BulkControlType::parse)
    }
}

pub fn is_session_id(value: &Value) -> bool {
    is_remote_executor_id(value)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("Invalid bulk connection control")]
pub struct InvalidBulkConnectionControl;

pub fn parse_bulk_control(
    value: &Value,
) -> Result<BulkConnectionControl, InvalidBulkConnectionControl> {
    let fields = value
        .as_object()
        .filter(|fields| fields.len() == 2)
        .ok_or(InvalidBulkConnectionControl)?;
    let control_type = fields.get("type").ok_or(InvalidBulkConnectionControl)?;
    let id = fields
        .get("sessionId")
        .filter(|id| is_session_id(id))
        .and_then(Value::as_str)
        .ok_or(InvalidBulkConnectionControl)?;
    // String(array) also accepts nested singleton arrays; the parser returns the original field.
    let mut text = control_type;
    while let Some([item]) = text.as_array().map(Vec::as_slice) {
        text = item;
    }
    text.as_str()
        .and_then(BulkControlType::parse)
        .ok_or(InvalidBulkConnectionControl)?;
    Ok(BulkConnectionControl {
        control_type: Opaque::from_value(control_type.clone()),
        session_id: id.to_owned(),
    })
}
