use garcon_agents_common::execution::runtime_events::{
    AgentRuntimeEvent, RuntimePermissionResponse, runtime_operation,
};
use garcon_interface::{
    host::AgentLogger,
    producer::{
        AgentProviderPermissionLifecycle, AgentRequestedPermission, AgentTerminalPermission,
    },
};
use garcon_js::{ManualClock, json::Opaque};
use tokio::{sync::mpsc, task::LocalSet};

use super::*;
use crate::agents::opencode::{
    endpoint_coordinator::OpenCodeEndpointRequest, operation_routes::OpenCodeOperationRoutes,
    sdk_client::OpenCodeSdkClient, sdk_result::OpenCodeSdkResult,
    turn_events::create_open_code_turn_context,
};

struct Logger;

impl AgentLogger for Logger {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
}

struct Fixture {
    controller: Rc<OpenCodeDecisionController>,
    client: Rc<dyn OpenCodeClient>,
    route: Route,
    source: OpenCodeOperationEventSource,
    published: Rc<RefCell<Vec<AgentRuntimeEvent>>>,
    requests: mpsc::UnboundedReceiver<OpenCodeEndpointRequest>,
}

fn fixture(permission_mode: PermissionMode) -> Fixture {
    let published = Rc::new(RefCell::new(Vec::new()));
    let (send, requests) = mpsc::unbounded_channel();
    let client: Rc<dyn OpenCodeClient> = Rc::new(OpenCodeSdkClient::new("http://127.0.0.1:9911"));
    let logger = Rc::new(Logger);
    let routes = OpenCodeOperationRoutes::new(logger.clone());
    let turn = create_open_code_turn_context(
        runtime_operation("run".to_owned(), Rc::new(|_| {})),
        false,
        &|| "fixture".to_owned(),
    );
    turn.borrow_mut()
        .assistant_message_ids
        .insert("assistant".to_owned());
    let route = routes
        .register(
            "session",
            "chat",
            turn,
            true,
            permission_mode,
            Some("/repo".to_owned()),
        )
        .expect("register fixture turn");
    let options = OpenCodeDecisionControllerOptions {
        logger,
        publish: Rc::new({
            let published = published.clone();
            move |_, _, event| published.borrow_mut().push(event)
        }),
        get_client: Rc::new({
            let client = client.clone();
            move || {
                let client = client.clone();
                async move { Ok(client) }.boxed_local()
            }
        }),
        run_scoped_request: Rc::new(move |request| {
            send.send(request)
                .unwrap_or_else(|_| panic!("request observed"));
            async { Ok(OpenCodeSdkResult::success(Value::Bool(true), 200)) }.boxed_local()
        }),
        get_session: Rc::new(|_| None),
        fail_turn: Rc::new(|_, _, _| panic!("provider requests succeed")),
        clock: Rc::new(ManualClock::new(1_700_000_000_000)),
        new_id: Rc::new(|| "occurrence".to_owned()),
    };
    Fixture {
        controller: OpenCodeDecisionController::new(options),
        client,
        route,
        source: OpenCodeOperationEventSource::Operation {
            session_id: "session".to_owned(),
        },
        published,
        requests,
    }
}

fn permission() -> SseEvent {
    SseEvent { id: None, kind: "permission.asked".to_owned(), properties: json!({
        "id": "provider-request", "permission": "bash", "tool": { "messageID": "assistant", "callID": "call" }
    }).as_object().cloned() }
}

fn requested(events: &RefCell<Vec<AgentRuntimeEvent>>) -> Rc<dyn RuntimePermissionResponse> {
    let event = events.borrow_mut().remove(0);
    match event {
        AgentRuntimeEvent::Permission {
            run_id,
            lifecycle:
                AgentProviderPermissionLifecycle::Requested(AgentRequestedPermission::Requested {
                    permission_occurrence_id,
                    ..
                }),
            decision: Some(decision),
        } => {
            assert_eq!(run_id, "run");
            assert_eq!(permission_occurrence_id, "occurrence");
            assert_eq!(decision.permission_occurrence_id(), "occurrence");
            decision
        }
        _ => panic!("provider request must publish a typed permission occurrence"),
    }
}

fn deny() -> PermissionDecisionPayload {
    PermissionDecisionPayload {
        allow: false,
        always_allow: None,
        response: None,
    }
}

#[tokio::test]
async fn responds_to_the_original_provider_id_in_the_captured_directory() {
    LocalSet::new()
        .run_until(async {
            let Fixture {
                controller,
                client,
                route,
                source,
                published,
                mut requests,
            } = fixture(PermissionMode::Default);
            assert!(controller.handle(client, &permission(), &source, &route));
            assert!(!controller.idle());
            let response = requested(&published);
            response
                .respond(deny())
                .await
                .expect("provider accepts decision");
            let request = requests.recv().await.expect("provider reply request");
            assert_eq!(request.operation, OpenCodeRequest::PermissionReply);
            assert_eq!(request.parameters["requestID"], "provider-request");
            assert_eq!(request.parameters["directory"], "/repo");
            assert_eq!(request.parameters["reply"], "reject");
            assert_eq!(request.parameters["message"], "User denied tool use");
            assert!(controller.idle());
            assert!(response.respond(deny()).await.is_err());
        })
        .await;
}

#[tokio::test]
async fn cancels_pending_permissions_before_releasing_the_handle() {
    LocalSet::new().run_until(async {
        let Fixture { controller, client, route, source, published, mut requests } = fixture(PermissionMode::Default);
        assert!(controller.handle(client, &permission(), &source, &route));
        let response = requested(&published);
        controller.cancel_for_session("other", "cancelled");
        assert!(!controller.idle());
        controller.cancel_for_session("session", "aborted");
        let terminal = published.borrow_mut().remove(0);
        assert!(matches!(terminal, AgentRuntimeEvent::Permission { lifecycle: AgentProviderPermissionLifecycle::Terminal(
            AgentTerminalPermission::Cancelled { permission_occurrence_id, reason: Some(reason) }
        ), decision: None, .. } if permission_occurrence_id == "occurrence" && reason == "aborted"));
        assert_eq!(response.respond(deny()).await.expect_err("stale response").to_string(), "OpenCode permission occurrence is no longer pending");
        assert!(requests.try_recv().is_err());
        assert!(controller.idle());
    }).await;
}

#[tokio::test]
async fn manual_bypass_answers_once_without_creating_a_pending_occurrence() {
    LocalSet::new()
        .run_until(async {
            let Fixture {
                controller,
                client,
                route,
                source,
                published,
                mut requests,
            } = fixture(PermissionMode::ManualBypass);
            assert!(controller.handle(client, &permission(), &source, &route));
            let request = requests.recv().await.expect("automatic reply");
            assert_eq!(request.label, "OpenCode manual bypass permission reply");
            assert_eq!(request.parameters["reply"], "once");
            assert!(published.borrow().is_empty());
            assert!(controller.idle());
        })
        .await;
}

#[tokio::test]
async fn rejects_an_unrenderable_question_without_publishing_a_permission() {
    LocalSet::new().run_until(async {
        let Fixture { controller, client, route, source, published, mut requests } = fixture(PermissionMode::Default);
        let event = SseEvent { id: Some("event".to_owned()), kind: "question.asked".to_owned(), properties: json!({
            "id": "question", "questions": [], "tool": { "callID": "tool", "messageID": "assistant" }
        }).as_object().cloned() };
        assert!(controller.handle(client, &event, &source, &route));
        let request = requests.recv().await.expect("automatic rejection");
        assert_eq!(request.operation, OpenCodeRequest::QuestionReject);
        assert_eq!(request.parameters["requestID"], "question");
        assert!(published.borrow().is_empty());
        assert!(controller.idle());
    }).await;
}
