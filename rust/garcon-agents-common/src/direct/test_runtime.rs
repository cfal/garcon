use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

use async_trait::async_trait;
use garcon_contract::{
    api_providers::ApiProtocol,
    chat_modes::{PermissionMode, ThinkingMode},
};
use garcon_interface::{
    execution::AgentRunningSession, resources::ExecutorResult, transcript::AgentNativeSessionRef,
};
use serde_json::json;

use super::{
    router::{DirectCompatibleRuntime, DirectEndpointRouterConfig, DirectEndpointRouterRuntime},
    runtime_types::*,
};
use crate::execution::runtime_events::runtime_operation;

pub(super) const SESSION_ID: &str = "10000000-0000-4000-8000-000000000001";

pub(super) fn native_session() -> AgentNativeSessionRef {
    AgentNativeSessionRef {
        owner_id: "direct-test".into(),
        schema_version: 1,
        value: json!({"sessionId":SESSION_ID}).into(),
    }
}

#[derive(Default)]
pub(super) struct Capture {
    pub calls: RefCell<Vec<String>>,
    pub starts: RefCell<Vec<DirectStartRequest>>,
    pub resumes: RefCell<Vec<DirectResumeRequest>>,
    pub fail_start: Cell<bool>,
}

pub(super) struct Runtime {
    pub trace: Rc<Capture>,
    route: String,
}

impl Runtime {
    fn called(&self, call: &str) {
        self.trace
            .calls
            .borrow_mut()
            .push(format!("{}:{call}", self.route));
    }
}

#[async_trait(?Send)]
impl DirectCompatibleRuntime for Runtime {
    async fn start_session(
        &self,
        request: DirectStartRequest,
    ) -> ExecutorResult<DirectStartedSession> {
        self.called("start");
        self.trace.starts.borrow_mut().push(request);
        if self.trace.fail_start.replace(false) {
            return Err("replacement failed".into());
        }
        Ok(DirectStartedSession {
            agent_session_id: SESSION_ID.into(),
            native_session: native_session(),
        })
    }

    async fn run_turn(&self, request: DirectResumeRequest) -> ExecutorResult<()> {
        self.called("resume");
        self.trace.resumes.borrow_mut().push(request);
        Ok(())
    }

    fn abort(&self, _: &str) -> bool {
        false
    }
    fn is_running(&self, _: &str) -> bool {
        false
    }
    fn forget_session(&self, id: &str) -> ExecutorResult<()> {
        assert_eq!(id, SESSION_ID);
        self.called("forget");
        Ok(())
    }
    fn get_running_sessions(&self) -> Vec<AgentRunningSession> {
        Vec::new()
    }
    fn start_purge_timer(&self) {
        self.called("purge");
    }
    fn shutdown(&self) {
        self.called("shutdown");
    }
}

pub(super) fn router(trace: Rc<Capture>) -> DirectEndpointRouterRuntime<Runtime> {
    DirectEndpointRouterRuntime::new(DirectEndpointRouterConfig {
        label: "Direct fixture".into(),
        protocol: ApiProtocol::OpenAiCompatible,
        create_runtime: Box::new(move |endpoint| {
            let route = endpoint.selection.endpoint_id.clone();
            trace.calls.borrow_mut().push(format!("{route}:create"));
            Ok(Runtime {
                trace: trace.clone(),
                route,
            })
        }),
        run_single_query: Box::new(|_, _, _| {
            Box::pin(async { panic!("query reached a rejected runtime") })
        }),
    })
}

pub(super) fn endpoint(id: &str) -> DirectEndpointRuntime {
    DirectEndpointRuntime {
        selection: serde_json::from_value(json!({
            "apiProviderId":"provider", "endpointId":id, "providerLabel":"Fixture",
            "protocol":"openai-compatible", "baseUrl":"https://fixture.invalid/v1", "model":"model",
            "isLocal":false, "capabilities":null, "headers":{}, "credential":null,
        }))
        .unwrap(),
        credential: None,
    }
}

pub(super) fn execution_request(endpoint: DirectEndpointRuntime) -> DirectExecutionRequest {
    DirectExecutionRequest {
        chat_id: "chat".into(),
        project_path: "/fixture".into(),
        model: "model".into(),
        permission_mode: PermissionMode::Default,
        thinking_mode: ThinkingMode::None,
        execution_admission: None,
        command: "continue".into(),
        images: None,
        endpoint,
        operation: runtime_operation("run".into(), Rc::new(|_| {})),
    }
}
