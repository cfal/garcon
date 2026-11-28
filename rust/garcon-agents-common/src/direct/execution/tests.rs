use garcon_contract::{
    agent_execution::AgentEndpointSelection,
    agent_integration::AgentSettingsEnvelope,
    chat_modes::{PermissionMode, ThinkingMode},
};
use garcon_interface::{
    execution::AgentExecutionAdmission,
    host::{AgentResolveCredentialRequest, AgentResolvedCredential},
};
use serde_json::json;
use tokio_util::sync::CancellationToken;

use super::*;
use crate::direct::test_runtime::{Capture, Runtime, SESSION_ID, endpoint, native_session, router};

struct Providers;

#[async_trait(?Send)]
impl AgentApiProviderReader for Providers {
    async fn resolve_credential(
        &self,
        _: AgentResolveCredentialRequest,
    ) -> ExecutorResult<Option<AgentResolvedCredential>> {
        panic!("fixture endpoint has no credential reference");
    }
}

#[derive(Default)]
struct Admission(CancellationToken);

#[async_trait(?Send)]
impl AgentExecutionAdmission for Admission {
    fn signal(&self) -> &CancellationToken {
        &self.0
    }
    async fn mark_started(&self) -> ExecutorResult<()> {
        Ok(())
    }
}

fn fixture() -> (Rc<Capture>, DirectExecution<Runtime>) {
    let trace = Rc::new(Capture::default());
    let execution = DirectExecution {
        api_providers: Rc::new(Providers),
        runtime: Rc::new(router(trace.clone())),
    };
    (trace, execution)
}

fn context(run: &str, endpoint: Option<AgentEndpointSelection>) -> AgentRuntimeExecutionContext {
    AgentRuntimeExecutionContext {
        chat_id: "chat".into(),
        project_path: "/fixture".into(),
        model: "model".into(),
        permission_mode: PermissionMode::Default,
        thinking_mode: ThinkingMode::None,
        settings: AgentSettingsEnvelope {
            owner_id: "direct-test".into(),
            schema_version: 1,
            values: json!({}).into(),
        },
        endpoint,
        run_id: run.into(),
        submission: None,
        admission: Rc::new(Admission::default()),
    }
}

fn start(run: &str, carried_context: Option<CarriedContext>) -> AgentRuntimeStartRequest {
    AgentRuntimeStartRequest {
        context: context(run, Some(endpoint("a").selection)),
        prompt: "continue".into(),
        attachments: Vec::new(),
        carried_context,
    }
}

fn capture_events(events: Rc<RefCell<Vec<AgentRuntimeEvent>>>) -> AgentRuntimePublisher {
    Rc::new(move |event| events.borrow_mut().push(event))
}

#[tokio::test]
async fn prefixes_a_new_direct_session_with_carried_context_and_publishes_its_receipt() {
    let (trace, execution) = fixture();
    let events = Rc::new(RefCell::new(Vec::new()));
    let carried = CarriedContext {
        prefix: "<carried>history</carried>\n\n".into(),
        summary_truncated: None,
    };
    let result = execution
        .start(
            start("run-1", Some(carried.clone())),
            capture_events(events.clone()),
        )
        .await
        .unwrap();
    assert_eq!(
        trace.starts.borrow()[0].execution.command,
        "<carried>history</carried>\n\ncontinue"
    );
    assert_eq!(result.agent_session_id, SESSION_ID);
    assert_eq!(result.native_session, Some(native_session()));
    assert_eq!(
        result.native_seed_receipt,
        receipt_for_carried_context(
            Some(&carried),
            SESSION_ID,
            Some(NativeSeedPlacement::UserPrefix)
        )
        .unwrap()
    );
    assert!(result.native_seed_receipt.is_some());
    assert!(
        matches!(events.borrow().as_slice(), [AgentRuntimeEvent::Session { session }] if session == &result)
    );
}

#[tokio::test]
async fn resumes_from_the_exact_native_session() {
    let (trace, execution) = fixture();
    execution
        .resume(
            AgentRuntimeResumeRequest {
                context: context("run-1", Some(endpoint("b").selection)),
                agent_session_id: SESSION_ID.into(),
                native_session: Some(native_session()),
                prompt: "continue".into(),
                attachments: Vec::new(),
            },
            Rc::new(|_| {}),
        )
        .await
        .unwrap();
    let requests = trace.resumes.borrow();
    assert_eq!(requests[0].execution.command, "continue");
    assert_eq!(requests[0].native_session, Some(native_session()));
}

#[tokio::test]
async fn keeps_each_concrete_request_bound_to_the_publisher_that_created_it() {
    let (trace, execution) = fixture();
    let first = Rc::new(RefCell::new(Vec::new()));
    let second = Rc::new(RefCell::new(Vec::new()));
    execution
        .start(start("run-1", None), capture_events(first.clone()))
        .await
        .unwrap();
    trace.fail_start.set(true);
    assert_eq!(
        execution
            .start(start("run-2", None), capture_events(second.clone()))
            .await
            .unwrap_err()
            .to_string(),
        "replacement failed"
    );
    (trace.starts.borrow()[0].execution.operation.publish)(AgentRuntimeEvent::Rows {
        rows: Vec::new(),
    });
    assert!(matches!(
        first.borrow().as_slice(),
        [
            AgentRuntimeEvent::Session { .. },
            AgentRuntimeEvent::Rows { .. }
        ]
    ));
    assert!(second.borrow().is_empty());
}

#[tokio::test]
async fn rejects_a_missing_endpoint_before_dispatch_with_invalid_endpoint() {
    let (trace, execution) = fixture();
    let error = execution
        .start(
            AgentRuntimeStartRequest {
                context: context("run-1", None),
                prompt: "continue".into(),
                attachments: Vec::new(),
                carried_context: None,
            },
            Rc::new(|_| panic!("published without an endpoint")),
        )
        .await
        .unwrap_err();
    let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
    assert_eq!(error.code, AgentIntegrationErrorCode::INVALID_ENDPOINT);
    assert_eq!(
        error.message,
        "A compatible API provider endpoint is required"
    );
    assert!(trace.calls.borrow().is_empty());
}
