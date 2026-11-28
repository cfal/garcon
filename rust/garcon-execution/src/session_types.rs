//! Controller-side session option types. Runtime and registry implementations stay outside.

use std::rc::Rc;

use garcon_contract::{
    agent_execution::AgentEndpointSelection,
    agent_integration::AgentSettingsEnvelope,
    api_providers::ApiProtocol,
    async_user_questions::AsyncQuestionReply,
    chat_modes::{PermissionMode, ThinkingMode},
    ws_requests::AgentCommandImage,
};
use garcon_interface::execution::AgentExecutionAdmission;
use garcon_js::{Number, OptionalNullable};

use crate::turn_identity::{TurnCommandType, TurnIdentity};

#[derive(Clone)]
pub struct RunAgentTurnOptions {
    pub images: Option<Vec<AgentCommandImage>>,
    pub model: Option<String>,
    pub api_provider_id: OptionalNullable<String>,
    pub model_endpoint_id: OptionalNullable<String>,
    pub model_protocol: OptionalNullable<ApiProtocol>,
    pub permission_mode: Option<PermissionMode>,
    pub thinking_mode: Option<ThinkingMode>,
    pub agent_settings: Option<AgentSettingsEnvelope>,
    pub question_reply: Option<AsyncQuestionReply>,
    pub client_request_id: Option<String>,
    pub client_message_id: Option<String>,
    pub transcript_view_id: Option<String>,
    pub excluded_resend_ordinals: Option<Vec<Number>>,
    pub turn_id: Option<String>,
    pub command_type: Option<TurnCommandType>,
    pub execution_admission: Option<Rc<dyn AgentExecutionAdmission>>,
    pub integration_endpoint: OptionalNullable<AgentEndpointSelection>,
}

impl Default for RunAgentTurnOptions {
    fn default() -> Self {
        Self {
            images: None,
            model: None,
            api_provider_id: OptionalNullable::ABSENT,
            model_endpoint_id: OptionalNullable::ABSENT,
            model_protocol: OptionalNullable::ABSENT,
            permission_mode: None,
            thinking_mode: None,
            agent_settings: None,
            question_reply: None,
            client_request_id: None,
            client_message_id: None,
            transcript_view_id: None,
            excluded_resend_ordinals: None,
            turn_id: None,
            command_type: None,
            execution_admission: None,
            integration_endpoint: OptionalNullable::ABSENT,
        }
    }
}

impl RunAgentTurnOptions {
    pub(crate) fn identity(&self) -> TurnIdentity {
        TurnIdentity {
            turn_id: self.turn_id.clone(),
            client_request_id: self.client_request_id.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentSteerOptions {
    pub question_reply: Option<AsyncQuestionReply>,
    pub client_request_id: String,
    pub client_message_id: String,
    pub transcript_view_id: String,
}
