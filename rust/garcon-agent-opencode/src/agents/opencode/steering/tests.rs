use futures::FutureExt;
use garcon_agents_common::execution::runtime_events::runtime_operation;
use garcon_contract::chat_modes::PermissionMode;
use serde_json::json;
use tokio::{sync::mpsc, task::LocalSet};

use super::*;
use crate::agents::opencode::{
    sdk_client::OpenCodeSdkClient,
    turn_events::{SessionData, create_open_code_turn_context},
};

struct Fixture {
    controller: Rc<OpenCodeSteeringController>,
    session: OpenCodeSession,
    request: mpsc::UnboundedReceiver<OpenCodeEndpointRequest>,
}

fn turn() -> OpenCodeTurnContext {
    let turn = create_open_code_turn_context(
        runtime_operation("run".to_owned(), Rc::new(|_| {})),
        false,
        &|| "prompt".to_owned(),
    );
    {
        let mut data = turn.borrow_mut();
        data.provider_message_id = Some("original-user".to_owned());
        data.provider_prompt_request_completed = true;
    }
    turn
}

fn fixture(result: OpenCodeSdkResult) -> Fixture {
    let session = OpenCodeSession::new(SessionData {
        status: SessionStatus::Running,
        aborting: Some(false),
        chat_id: "chat".to_owned(),
        model: Some("fixture/model".to_owned()),
        thinking_variant: Some("high".to_owned()),
        permission_mode: PermissionMode::Default,
        directory: Some("/repo".to_owned()),
        started_at: "2026-03-01T00:00:00.000Z".to_owned(),
        last_activity_at: 0.0,
        provider_work_requires_quiescence: false,
        active_steering_deliveries: 0,
        deferred_terminal: None,
        pending_steering_revert_message_id: None,
        turn: turn(),
    });
    let client: Rc<dyn OpenCodeClient> = Rc::new(OpenCodeSdkClient::new("http://127.0.0.1:9911"));
    let (sent, request) = mpsc::unbounded_channel();
    let controller = OpenCodeSteeringController::new(OpenCodeSteeringOptions {
        request_timeout_ms: 50.0,
        get_session: Rc::new({
            let session = session.clone();
            move |id| (id == "session").then(|| session.clone())
        }),
        get_client: Rc::new(move || {
            let client = client.clone();
            async { Ok(client) }.boxed_local()
        }),
        run_scoped_request: Rc::new(move |request| {
            sent.send(request)
                .unwrap_or_else(|_| panic!("outgoing request observer"));
            let result = result.clone();
            async { Ok(result) }.boxed_local()
        }),
        release_deferred_terminal: Rc::new(|_, _| {}),
        bind_operation_part: Rc::new(|_, _| true),
        unbind_operation_part: Rc::new(|_, _| {}),
        new_id: Rc::new(|| "steer-id".to_owned()),
    });
    Fixture {
        controller,
        session,
        request,
    }
}

fn request(
    controller: &OpenCodeSteeringController,
    prepare: PrepareDelivery,
) -> RuntimeSteerRequest {
    RuntimeSteerRequest {
        question_reply: None,
        chat_id: "chat".to_owned(),
        project_path: "/wrong-active-chat".to_owned(),
        agent_session_id: "session".to_owned(),
        native_session: None,
        target: controller.capture_target("session"),
        input: "/literal steering".to_owned(),
        client_message_id: "client-message".to_owned(),
        prepare_delivery: prepare,
    }
}

fn acknowledgement(part_id: &str) -> SseEvent {
    SseEvent {
        id: None,
        kind: "message.part.updated".to_owned(),
        properties: json!({"part":{"id":part_id,"messageID":"steering-user"}})
            .as_object()
            .cloned(),
    }
}

#[tokio::test(start_paused = true)]
async fn uses_prompt_async_as_literal_same_turn_steering_and_waits_for_its_exact_provider_part() {
    LocalSet::new()
        .run_until(async {
            let Fixture {
                controller,
                session,
                request: mut outgoing,
            } = fixture(OpenCodeSdkResult::success(Value::Null, 204));
            let (preparing, prepared) = oneshot::channel();
            let prepare = RefCell::new(Some(preparing));
            let request = request(
                &controller,
                Rc::new(move || {
                    prepare
                        .take()
                        .expect("one preparation")
                        .send(())
                        .expect("preparation observed");
                    async { Ok(()) }.boxed_local()
                }),
            );
            let mut sending = spawn_local({
                let controller = controller.clone();
                async move { controller.steer(request).await }
            });
            prepared.await.expect("prepared before provider submit");
            let sent = outgoing.recv().await.expect("provider request");
            assert_eq!(sent.operation, OpenCodeRequest::SessionPromptAsync);
            assert_eq!(sent.parameters["parts"][0]["text"], "/literal steering");
            assert_eq!(sent.parameters["parts"][0]["id"], "prt_steerid");
            assert_eq!(sent.parameters["directory"], "/repo");
            assert_eq!(sent.parameters["variant"], "high");
            assert_eq!(session.borrow().active_steering_deliveries, 1);
            controller.observe_acknowledgement(&session, &acknowledgement("unrelated-part"));
            assert!(futures::poll!(&mut sending).is_pending());
            controller.observe_acknowledgement(&session, &acknowledgement("prt_steerid"));
            assert_eq!(
                sending
                    .await
                    .expect("steering task")
                    .expect("steering reply"),
                AgentSteerResult::Accepted
            );
            let data = session.borrow();
            assert_eq!(data.active_steering_deliveries, 0);
            assert!(
                data.turn
                    .borrow()
                    .pending_steering_message_ids
                    .contains("steering-user")
            );
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn quiesces_an_unconfirmed_steering_delivery_before_the_next_turn() {
    LocalSet::new()
        .run_until(async {
            let Fixture {
                controller,
                session,
                request: mut outgoing,
            } = fixture(OpenCodeSdkResult::success(Value::Null, 204));
            let request = request(&controller, Rc::new(|| async { Ok(()) }.boxed_local()));
            let result = controller.steer(request).await.expect("steering reply");
            assert!(matches!(
                result,
                AgentSteerResult::Failed {
                    outcome: AgentSteerFailureOutcome::Unknown,
                    ..
                }
            ));
            assert_eq!(
                outgoing.recv().await.expect("submitted").operation,
                OpenCodeRequest::SessionPromptAsync
            );
            assert!(session.borrow().provider_work_requires_quiescence);
            controller.observe_acknowledgement(&session, &acknowledgement("prt_steerid"));
            controller.stage_pending_cleanup(&session);
            assert_eq!(
                session
                    .borrow()
                    .pending_steering_revert_message_id
                    .as_deref(),
                Some("steering-user")
            );
            let client = (controller.options.get_client)()
                .await
                .expect("provider client");
            controller
                .remove_unconsumed(
                    client,
                    "session",
                    &session,
                    &OpenCodeRequestScope {
                        directory: Some("/repo".to_owned()),
                    },
                )
                .await
                .expect("revert succeeds");
            let reverted = outgoing.recv().await.expect("revert request");
            assert_eq!(reverted.operation, OpenCodeRequest::SessionRevert);
            assert_eq!(reverted.parameters["messageID"], "steering-user");
            assert!(
                session
                    .borrow()
                    .pending_steering_revert_message_id
                    .is_none()
            );
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn rejects_a_target_captured_for_a_previous_turn() {
    LocalSet::new()
        .run_until(async {
            let Fixture {
                controller,
                session,
                request: mut outgoing,
            } = fixture(OpenCodeSdkResult::success(Value::Null, 204));
            let request = request(
                &controller,
                Rc::new(|| panic!("stale target cannot prepare")),
            );
            session.borrow_mut().turn = turn();
            assert_eq!(
                controller.steer(request).await.expect("steering reply"),
                turn_changed()
            );
            assert!(outgoing.try_recv().is_err());
        })
        .await;
}
