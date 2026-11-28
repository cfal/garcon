//! Ports `operation-routes.test.js`.
//!
//! `preserves the metadata-inheritance collision warning` is not ported: it
//! reaches the collision warning of a continuation through accessors that
//! return a different ID on each read, which a JSON value cannot express.
//! With plain values the named lookup answers before the continuation binds.

use std::rc::Rc;

use crate::support::{RecordingLogger, recording_logger};
use garcon_agent_opencode::agents::opencode::compaction_routing::{
    OpenCodeCompactionPartRouteInput, adopt_open_code_compaction_part_route,
};
use garcon_agent_opencode::agents::opencode::operation_routes::{
    OpenCodeCompactionPartAdoption, OpenCodeOperationRoutes, Route,
};
use garcon_agent_opencode::agents::opencode::sse_events::{
    SseEvent, is_open_code_compaction_continuation_part, is_open_code_compaction_control_part,
};
use garcon_agent_opencode::agents::opencode::turn_events::{
    OpenCodeSession, OpenCodeTurnContext, SessionData, SessionStatus,
    create_open_code_turn_context, open_code_event_belongs_to_turn,
};
use garcon_agents_common::execution::runtime_events::AgentRuntimeOperation;
use garcon_contract::chat_modes::PermissionMode;
use serde_json::{Value, json};

struct Fixture {
    logger: Rc<RecordingLogger>,
    routes: OpenCodeOperationRoutes,
}

fn create_fixture() -> Fixture {
    let logger = recording_logger();
    Fixture {
        routes: OpenCodeOperationRoutes::new(logger.clone()),
        logger,
    }
}

struct Registered {
    route: Route,
    turn: OpenCodeTurnContext,
}

fn create_turn(run_id: &str) -> OpenCodeTurnContext {
    create_open_code_turn_context(
        AgentRuntimeOperation {
            run_id: run_id.to_owned(),
            publish: Rc::new(|_| {}),
        },
        false,
        &|| format!("prt_{run_id}"),
    )
}

fn register_with(
    routes: &OpenCodeOperationRoutes,
    session_id: &str,
    chat_id: &str,
    run_id: &str,
    supersedes_chat_source: bool,
) -> Registered {
    let turn = create_turn(run_id);
    let route = routes
        .register(
            session_id,
            chat_id,
            turn.clone(),
            supersedes_chat_source,
            PermissionMode::Default,
            Some("/repo".to_owned()),
        )
        .expect("the route registers");
    Registered { route, turn }
}

fn register(
    routes: &OpenCodeOperationRoutes,
    session_id: &str,
    chat_id: &str,
    run_id: &str,
) -> Registered {
    register_with(routes, session_id, chat_id, run_id, false)
}

fn prompt_part_id(turn: &OpenCodeTurnContext) -> String {
    turn.borrow().provider_prompt_part_id.clone()
}

fn event(id: &str, kind: &str, properties: Value) -> SseEvent {
    SseEvent {
        id: Some(id.to_owned()),
        kind: kind.to_owned(),
        properties: properties.as_object().cloned(),
    }
}

fn prompt_event(turn: &OpenCodeTurnContext, message_id: &str, event_id: &str) -> SseEvent {
    let run_id = turn.borrow().operation.run_id.clone();
    event(
        event_id,
        "message.part.updated",
        json!({
            "sessionID": "ignored-by-routes",
            "part": {
                "id": prompt_part_id(turn),
                "messageID": message_id,
                "type": "text",
                "text": format!("prompt-{run_id}"),
            },
        }),
    )
}

fn assistant_event(
    session_id: &str,
    message_id: &str,
    parent_id: &str,
    event_id: &str,
) -> SseEvent {
    event(
        event_id,
        "message.updated",
        json!({
            "sessionID": session_id,
            "info": { "id": message_id, "role": "assistant", "parentID": parent_id },
        }),
    )
}

// A part with the given fields over the defaults; `null` stands for the
// `undefined` the original's spreads write over a default.
fn part_event(event_id: &str, part: Value, overrides: &[(&str, Value)]) -> SseEvent {
    let mut part = part;
    let fields = part.as_object_mut().expect("a part object");
    for (key, value) in overrides {
        fields.insert((*key).to_owned(), value.clone());
    }
    event(
        event_id,
        "message.part.updated",
        json!({ "sessionID": "session-1", "part": part }),
    )
}

fn compaction_part_event(overrides: &[(&str, Value)]) -> SseEvent {
    part_event(
        "event-compaction-part",
        json!({
            "id": "part-compaction",
            "messageID": "user-compaction",
            "type": "compaction",
            "auto": true,
        }),
        overrides,
    )
}

fn task_part_event(child_session_id: &str, overrides: &[(&str, Value)]) -> SseEvent {
    part_event(
        "event-task-part",
        json!({
            "id": "part-task",
            "messageID": "assistant-task",
            "type": "tool",
            "tool": "task",
            "state": {
                "status": "running",
                "input": {},
                "metadata": { "sessionId": child_session_id },
            },
        }),
        overrides,
    )
}

fn task_child_created_event(child_session_id: &str, parent_session_id: &str) -> SseEvent {
    event(
        &format!("event-created-{child_session_id}"),
        "session.created",
        json!({
            "sessionID": child_session_id,
            "info": { "id": child_session_id, "parentID": parent_session_id },
        }),
    )
}

fn running_session(turn: OpenCodeTurnContext) -> OpenCodeSession {
    OpenCodeSession::new(SessionData {
        status: SessionStatus::Running,
        aborting: None,
        chat_id: "chat-1".to_owned(),
        model: None,
        thinking_variant: None,
        permission_mode: PermissionMode::Default,
        directory: None,
        started_at: "2026-01-01T00:00:00.000Z".to_owned(),
        last_activity_at: 0.0,
        provider_work_requires_quiescence: false,
        active_steering_deliveries: 0,
        deferred_terminal: None,
        pending_steering_revert_message_id: None,
        turn,
    })
}

// Whether the lookup answered with exactly that route object.
fn same(resolved: Option<Route>, route: &Route) -> bool {
    resolved.is_some_and(|resolved| Rc::ptr_eq(&resolved, route))
}

fn warnings(logger: &RecordingLogger) -> Vec<Value> {
    logger
        .lines
        .borrow()
        .iter()
        .filter(|line| line["level"] == "warn")
        .cloned()
        .collect()
}

#[test]
fn retires_all_routes_and_task_descendants_of_only_the_released_chat_binding() {
    let Fixture { routes, .. } = create_fixture();
    let first = register(&routes, "session-1", "chat-1", "run-1");
    let second = register(&routes, "session-1", "chat-1", "run-2");
    let replacement = register(&routes, "session-2", "chat-1", "run-3");
    let sibling = register(&routes, "session-3", "chat-2", "run-4");
    routes.observe(
        &first.route,
        &prompt_event(&first.turn, "user-1", "event-1"),
    );
    assert!(routes.bind_task_child_session(&first.route, &task_part_event("child-1", &[])));
    assert!(same(
        routes.bind_task_descendant_session(&task_child_created_event("grandchild-1", "child-1")),
        &first.route
    ));

    routes.retire_session("wrong-chat", "session-1");
    assert!(routes.is_registered(&first.route));
    routes.retire_session("chat-1", "session-1");
    routes.retire_session("chat-1", "session-1");

    for entry in [&first, &second] {
        assert!(!routes.is_registered(&entry.route));
        assert!(entry.route.request_abort_controller.aborted());
    }
    assert!(routes.resolve_task_child("child-1").is_none());
    assert!(routes.resolve_task_child("grandchild-1").is_none());
    assert!(
        routes
            .resolve_named(
                "session-1",
                &assistant_event("session-1", "assistant-1", "user-1", "late")
            )
            .is_none()
    );
    for entry in [&replacement, &sibling] {
        assert!(routes.is_registered(&entry.route));
        assert!(!entry.route.request_abort_controller.aborted());
    }
}

#[test]
fn does_not_let_a_delayed_prompt_binding_replace_a_newer_source_route() {
    let Fixture { routes, .. } = create_fixture();
    let first = register_with(&routes, "session-1", "chat-1", "run-a", true);
    routes.observe(
        &first.route,
        &prompt_event(&first.turn, "user-a", "event-a"),
    );
    let second = register(&routes, "session-1", "chat-1", "run-b");
    routes.observe(
        &second.route,
        &prompt_event(&second.turn, "user-b", "event-b"),
    );

    routes.observe(
        &first.route,
        &prompt_event(&first.turn, "user-a", "event-a-delayed"),
    );

    assert!(same(
        routes.resolve_named(
            "session-1",
            &prompt_event(&first.turn, "user-a", "event-a-replayed")
        ),
        &first.route
    ));
    assert!(same(
        routes.resolve_named(
            "session-1",
            &prompt_event(&second.turn, "user-b", "event-b-replayed")
        ),
        &second.route
    ));
}

#[test]
fn keeps_named_routes_after_a_newer_operation_becomes_the_source() {
    let Fixture { routes, .. } = create_fixture();
    let first = register(&routes, "session-1", "chat-1", "run-a");
    routes.observe(
        &first.route,
        &prompt_event(&first.turn, "user-a", "event-a"),
    );
    let second = register(&routes, "session-1", "chat-1", "run-b");
    routes.observe(
        &second.route,
        &prompt_event(&second.turn, "user-b", "event-b"),
    );

    let late_first = assistant_event("session-1", "assistant-a", "user-a", "event-late-a");

    assert!(same(
        routes.resolve_named("session-1", &late_first),
        &first.route
    ));
    assert!(same(
        routes.resolve_named(
            "session-1",
            &prompt_event(&second.turn, "user-b", "event-b-replayed")
        ),
        &second.route
    ));
}

#[test]
fn lets_the_exact_prompt_echo_claim_a_user_message_observed_under_the_prior_source() {
    let Fixture { routes, .. } = create_fixture();
    let first = register(&routes, "session-1", "chat-1", "run-a");
    routes.observe(
        &first.route,
        &prompt_event(&first.turn, "user-a", "event-a"),
    );
    let second = register(&routes, "session-1", "chat-1", "run-b");
    routes.observe(
        &first.route,
        &event(
            "event-user-b-provisional",
            "message.updated",
            json!({
                "sessionID": "session-1",
                "info": { "id": "user-b", "role": "user" },
            }),
        ),
    );

    routes.observe(
        &second.route,
        &prompt_event(&second.turn, "user-b", "event-b"),
    );

    assert!(same(
        routes.resolve_named(
            "session-1",
            &assistant_event("session-1", "assistant-b", "user-b", "event-assistant-b")
        ),
        &second.route
    ));
}

#[test]
fn does_not_resolve_unnamed_events_or_cross_session_identity_boundaries() {
    let Fixture { routes, .. } = create_fixture();
    let first = register(&routes, "session-a", "chat-a", "run-a");
    let second = register(&routes, "session-b", "chat-b", "run-b");
    routes.observe(
        &first.route,
        &prompt_event(&first.turn, "shared-user", "event-a"),
    );
    routes.observe(
        &second.route,
        &prompt_event(&second.turn, "shared-user", "event-b"),
    );
    let assistant = assistant_event(
        "session-a",
        "shared-assistant",
        "shared-user",
        "event-output",
    );

    assert!(same(
        routes.resolve_named("session-a", &assistant),
        &first.route
    ));
    assert!(same(
        routes.resolve_named("session-b", &assistant),
        &second.route
    ));
    assert!(
        routes
            .resolve_named(
                "session-a",
                &event(
                    "event-unnamed",
                    "message.part.delta",
                    json!({ "sessionID": "session-a", "delta": "text" })
                )
            )
            .is_none()
    );
}

#[test]
fn binds_provider_generated_continuations_through_inherited_operation_identity() {
    let Fixture { routes, .. } = create_fixture();
    let operation = register(&routes, "session-1", "chat-1", "run-a");
    routes.observe(
        &operation.route,
        &prompt_event(&operation.turn, "user-a", "event-a"),
    );
    let continuation = part_event(
        "event-continuation",
        json!({
            "id": "part-continuation",
            "messageID": "user-continuation",
            "type": "text",
            "synthetic": true,
            "metadata": { "garcon_operation_part_id": prompt_part_id(&operation.turn) },
        }),
        &[],
    );
    assert!(same(
        routes.resolve("session-1", &continuation),
        &operation.route
    ));
    assert!(same(
        routes.resolve_named(
            "session-1",
            &assistant_event(
                "session-1",
                "assistant-continuation",
                "user-continuation",
                "event-assistant-continuation"
            )
        ),
        &operation.route
    ));
}

#[test]
fn drops_an_unqualified_provider_continuation_even_when_one_session_route_exists() {
    let Fixture { routes, .. } = create_fixture();
    let operation = register(&routes, "session-1", "chat-1", "run-a");
    routes.observe(
        &operation.route,
        &prompt_event(&operation.turn, "user-a", "event-a"),
    );

    let unqualified = part_event(
        "event-unqualified-compaction",
        json!({
            "id": "part-unqualified-compaction",
            "messageID": "user-unqualified-compaction",
            "type": "compaction",
            "auto": true,
        }),
        &[],
    );
    assert!(routes.resolve("session-1", &unqualified).is_none());
}

#[test]
fn uses_inherited_operation_metadata_without_guessing_between_concurrent_request_sources() {
    let Fixture { routes, .. } = create_fixture();
    let first = register(&routes, "session-1", "chat-1", "run-a");
    let second = register(&routes, "session-1", "chat-1", "run-b");
    let replay = part_event(
        "event-replay",
        json!({
            "id": "part-replay",
            "messageID": "user-replay",
            "type": "text",
            "metadata": { "garcon_operation_part_id": prompt_part_id(&first.turn) },
        }),
        &[],
    );
    let unqualified_continuation = part_event(
        "event-ambiguous-continuation",
        json!({
            "id": "part-ambiguous-continuation",
            "messageID": "user-ambiguous-continuation",
            "type": "compaction",
            "auto": true,
        }),
        &[],
    );

    assert!(same(routes.resolve("session-1", &replay), &first.route));
    assert!(
        routes
            .resolve("session-1", &unqualified_continuation)
            .is_none()
    );
    assert!(routes.is_registered(&second.route));
}

#[test]
fn retires_the_prior_chat_source_only_after_a_fresh_session_binds() {
    let Fixture { routes, .. } = create_fixture();
    let prior = register(&routes, "session-old", "chat-1", "run-a");
    routes.observe(
        &prior.route,
        &prompt_event(&prior.turn, "user-a", "event-a"),
    );
    let unrelated = register(&routes, "session-other", "chat-2", "run-other");
    routes.observe(
        &unrelated.route,
        &prompt_event(&unrelated.turn, "user-other", "event-other"),
    );
    let replacement = register_with(&routes, "session-new", "chat-1", "run-b", true);

    assert!(same(
        routes.resolve_named(
            "session-old",
            &assistant_event(
                "session-old",
                "assistant-a",
                "user-a",
                "event-before-binding"
            )
        ),
        &prior.route
    ));

    routes.observe(
        &replacement.route,
        &prompt_event(&replacement.turn, "user-b", "event-replacement"),
    );

    assert!(
        routes
            .resolve_named(
                "session-old",
                &assistant_event(
                    "session-old",
                    "assistant-a",
                    "user-a",
                    "event-after-binding"
                )
            )
            .is_none()
    );
    assert!(same(
        routes.resolve_named(
            "session-other",
            &assistant_event(
                "session-other",
                "assistant-other",
                "user-other",
                "event-unrelated"
            )
        ),
        &unrelated.route
    ));
}

#[test]
fn removes_only_a_failed_pending_route() {
    let Fixture { routes, .. } = create_fixture();
    let established = register(&routes, "session-1", "chat-1", "run-a");
    routes.observe(
        &established.route,
        &prompt_event(&established.turn, "user-a", "event-a"),
    );
    let failed = register(&routes, "session-1", "chat-1", "run-b");

    routes.unregister(&failed.route);

    assert!(same(
        routes.resolve_named(
            "session-1",
            &assistant_event("session-1", "assistant-a", "user-a", "event-late-a")
        ),
        &established.route
    ));
    assert!(
        routes
            .resolve_named(
                "session-1",
                &prompt_event(&failed.turn, "user-b", "event-failed")
            )
            .is_none()
    );
}

#[test]
fn retires_every_route_when_the_provider_event_source_closes() {
    let Fixture { routes, .. } = create_fixture();
    let established = register(&routes, "session-1", "chat-1", "run-a");
    routes.observe(
        &established.route,
        &prompt_event(&established.turn, "user-a", "event-a"),
    );
    assert!(routes.bind_part(&established.turn, "steering-a"));

    routes.clear();

    assert!(!routes.bind_part(&established.turn, "steering-after-close"));
    assert!(
        routes
            .resolve_named(
                "session-1",
                &part_event(
                    "event-steering-a",
                    json!({ "id": "steering-a", "messageID": "user-steering-a" }),
                    &[]
                )
            )
            .is_none()
    );
}

#[test]
fn binds_only_a_routed_task_part_child_session_without_a_session_fallback() {
    let Fixture { logger, routes } = create_fixture();
    let parent = register(&routes, "session-1", "chat-1", "run-a");

    assert!(routes.resolve_task_child("child-1").is_none());
    assert!(!routes.bind_task_child_session(
        &parent.route,
        &task_part_event("child-1", &[("tool", json!("bash"))]),
    ));
    assert!(!routes.bind_task_child_session(
        &parent.route,
        &task_part_event(
            "child-1",
            &[(
                "state",
                json!({ "status": "running", "input": {}, "metadata": {} })
            )]
        )
    ));
    assert!(!routes.bind_task_child_session(&parent.route, &task_part_event("session-1", &[])));
    assert!(routes.bind_task_child_session(&parent.route, &task_part_event("child-1", &[])));
    assert!(same(routes.resolve_task_child("child-1"), &parent.route));
    assert!(routes.resolve_task_child("unknown-child").is_none());
    assert!(warnings(&logger).is_empty());
}

#[test]
fn refuses_child_session_collisions_and_retires_affiliations_with_the_route() {
    let Fixture { logger, routes } = create_fixture();
    let first = register(&routes, "session-1", "chat-1", "run-a");
    let second = register(&routes, "session-2", "chat-2", "run-b");

    assert!(routes.bind_task_child_session(&first.route, &task_part_event("child-shared", &[])));
    assert!(!routes.bind_task_child_session(&second.route, &task_part_event("child-shared", &[])));
    assert!(!routes.bind_task_child_session(&first.route, &task_part_event("session-2", &[])));
    assert!(same(
        routes.resolve_task_child("child-shared"),
        &first.route
    ));
    assert_eq!(warnings(&logger).len(), 2);

    routes.unregister(&first.route);

    assert!(routes.resolve_task_child("child-shared").is_none());
    assert!(routes.bind_task_child_session(&second.route, &task_part_event("child-shared", &[])));
    routes.clear();
    assert!(routes.resolve_task_child("child-shared").is_none());
}

#[test]
fn affiliates_task_descendants_only_through_an_already_bound_child_parent() {
    let Fixture { logger, routes } = create_fixture();
    let parent = register(&routes, "session-1", "chat-1", "run-a");

    assert!(
        routes
            .bind_task_descendant_session(&task_child_created_event(
                "unaffiliated-child",
                "session-1"
            ))
            .is_none()
    );
    assert!(routes.bind_task_child_session(&parent.route, &task_part_event("child-1", &[])));
    assert!(same(
        routes.bind_task_descendant_session(&task_child_created_event("grandchild-1", "child-1")),
        &parent.route
    ));
    assert!(same(
        routes.bind_task_descendant_session(&task_child_created_event(
            "great-grandchild-1",
            "grandchild-1"
        )),
        &parent.route
    ));
    assert!(same(
        routes.resolve_task_child("grandchild-1"),
        &parent.route
    ));
    assert!(same(
        routes.resolve_task_child("great-grandchild-1"),
        &parent.route
    ));
    assert!(warnings(&logger).is_empty());
}

#[test]
fn recognizes_only_provider_marked_automatic_compaction_control_parts() {
    let undefined = Value::Null;
    let delta = {
        let mut event = compaction_part_event(&[]);
        event.kind = "message.part.delta".to_owned();
        event
    };
    for event in [
        delta,
        compaction_part_event(&[("type", json!("text"))]),
        compaction_part_event(&[("auto", undefined.clone())]),
        compaction_part_event(&[("auto", json!(false))]),
        compaction_part_event(&[("auto", json!("true"))]),
    ] {
        assert!(!is_open_code_compaction_control_part(&event));
    }

    assert!(is_open_code_compaction_control_part(
        &compaction_part_event(&[])
    ));
    assert!(is_open_code_compaction_control_part(
        &compaction_part_event(&[("overflow", json!(false))])
    ));
    assert!(is_open_code_compaction_control_part(
        &compaction_part_event(&[("overflow", json!(true))])
    ));
}

#[test]
fn recognizes_only_provider_marked_automatic_compaction_continuation_parts() {
    let undefined = Value::Null;
    let continuation = |overrides: &[(&str, Value)]| {
        let defaults: Vec<(&str, Value)> = vec![
            ("type", json!("text")),
            ("auto", undefined.clone()),
            ("synthetic", json!(true)),
            ("metadata", json!({ "compaction_continue": true })),
        ];
        compaction_part_event(
            &defaults
                .into_iter()
                .chain(overrides.iter().cloned())
                .collect::<Vec<_>>(),
        )
    };
    let delta = {
        let mut event = continuation(&[]);
        event.kind = "message.part.delta".to_owned();
        event
    };
    for event in [
        delta,
        continuation(&[("type", json!("file"))]),
        continuation(&[("synthetic", undefined.clone())]),
        continuation(&[("synthetic", json!(false))]),
        continuation(&[("metadata", undefined.clone())]),
        continuation(&[("metadata", json!({}))]),
        continuation(&[("metadata", json!({ "compaction_continue": false }))]),
        continuation(&[("metadata", json!({ "compaction_continue": "true" }))]),
    ] {
        assert!(!is_open_code_compaction_continuation_part(&event));
    }

    assert!(is_open_code_compaction_continuation_part(
        &continuation(&[])
    ));
    assert!(is_open_code_compaction_continuation_part(&continuation(&[
        (
            "metadata",
            json!({ "compaction_continue": true, "provider_field": "retained" })
        )
    ])));
}

#[test]
fn adopts_an_automatic_compaction_control_part_and_resolves_its_internal_summary_chain() {
    let Fixture { logger, routes } = create_fixture();
    let operation = register(&routes, "session-1", "chat-1", "run-a");
    routes.observe(
        &operation.route,
        &prompt_event(&operation.turn, "user-a", "event-a"),
    );
    operation.turn.borrow_mut().provider_message_id = Some("user-a".to_owned());

    let session = running_session(operation.turn.clone());
    let compaction_part = compaction_part_event(&[]);
    assert!(same(
        adopt_open_code_compaction_part_route(OpenCodeCompactionPartRouteInput {
            event: &compaction_part,
            logger: logger.as_ref(),
            operation_routes: &routes,
            session: Some(&session),
            session_id: "session-1",
        }),
        &operation.route
    ));
    assert!(
        operation
            .turn
            .borrow()
            .automatic_compaction_message_ids
            .contains("user-compaction")
    );
    let summary = event(
        "event-summary",
        "message.updated",
        json!({
            "sessionID": "session-1",
            "info": {
                "id": "assistant-summary",
                "role": "assistant",
                "parentID": "user-compaction",
                "summary": true,
                "finish": "stop",
                "time": { "completed": 1 },
            },
        }),
    );
    assert!(same(
        routes.resolve_named("session-1", &summary),
        &operation.route
    ));
    assert!(open_code_event_belongs_to_turn(&operation.turn, &summary));
    routes.observe(&operation.route, &summary);

    let summary_part = part_event(
        "event-summary-part",
        json!({
            "id": "part-summary",
            "messageID": "assistant-summary",
            "type": "text",
        }),
        &[],
    );
    let summary_delta = event(
        "event-summary-delta",
        "message.part.delta",
        json!({
            "sessionID": "session-1",
            "messageID": "assistant-summary",
            "partID": "part-summary",
            "delta": "synthetic summary content",
        }),
    );
    assert!(same(
        routes.resolve_named("session-1", &summary_part),
        &operation.route
    ));
    assert!(same(
        routes.resolve_named("session-1", &summary_delta),
        &operation.route
    ));
    assert!(open_code_event_belongs_to_turn(
        &operation.turn,
        &summary_part
    ));
    assert!(open_code_event_belongs_to_turn(
        &operation.turn,
        &summary_delta
    ));
    let turn = operation.turn.borrow();
    assert!(
        turn.automatic_compaction_message_ids
            .contains("assistant-summary")
    );
    assert!(turn.assistant_message_ids.contains("assistant-summary"));
    assert!(turn.assistant_terminals.is_empty());
    drop(turn);
    assert!(warnings(&logger).is_empty());
}

#[test]
fn retires_adopted_compaction_identities_with_their_turn() {
    let Fixture { routes, .. } = create_fixture();
    let operation = register(&routes, "session-1", "chat-1", "run-a");
    let event = compaction_part_event(&[]);
    assert!(matches!(
        routes.adopt_compaction_part(&operation.turn, &event),
        OpenCodeCompactionPartAdoption::Adopted { .. }
    ));

    routes.retire_turn(&operation.turn);

    assert!(routes.resolve_named("session-1", &event).is_none());
    assert!(matches!(
        routes.adopt_compaction_part(&operation.turn, &event),
        OpenCodeCompactionPartAdoption::RouteRetired
    ));
}

#[test]
fn refuses_malformed_and_colliding_compaction_identities_without_logging() {
    let Fixture { logger, routes } = create_fixture();
    let first = register(&routes, "session-1", "chat-1", "run-a");
    let second = register(&routes, "session-1", "chat-2", "run-b");
    assert!(matches!(
        routes.adopt_compaction_part(&first.turn, &compaction_part_event(&[("id", json!(""))])),
        OpenCodeCompactionPartAdoption::InvalidIdentifiers
    ));
    assert!(matches!(
        routes.adopt_compaction_part(
            &first.turn,
            &compaction_part_event(&[("messageID", json!(""))])
        ),
        OpenCodeCompactionPartAdoption::InvalidIdentifiers
    ));
    assert!(routes.bind_part(&second.turn, "part-collision"));

    assert!(matches!(
        routes.adopt_compaction_part(
            &first.turn,
            &compaction_part_event(&[
                ("id", json!("part-collision")),
                ("messageID", json!("message-new"))
            ])
        ),
        OpenCodeCompactionPartAdoption::IdentityCollision
    ));
    assert!(warnings(&logger).is_empty());
}
