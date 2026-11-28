use std::{
    cell::{Cell, RefCell},
    future::Future,
    rc::Rc,
};

use async_trait::async_trait;
use bytes::Bytes;
use futures::{StreamExt, stream};
use garcon_base::{
    domain_error::{DomainError, as_domain_error},
    event_loop_stalls::ActivityTracker,
};
use garcon_cases::{CaseError, replay, unknown};
use garcon_contract::error_codes::ErrorCode;
use garcon_execution::remote_client::cli_dispatcher::{
    CliDispatchAccess, CliRouteResponse, ControllerCliDispatcher, ControllerCliRoutes,
    DelegatedCliContext,
};
use garcon_link::{
    cli_protocol::{CLI_REPLY_BYTES, CLI_SMALL_REPLY_BYTES, CliHttpRequest},
    message_session::{SessionError, SessionSocket},
    rpc::{ExecutorRpc, ExecutorRpcContinuity, GuardRpcReply, RpcReplyGuard},
    rpc_lane::RpcLane,
    session_transport::{SessionTransport, SessionTransportOptions},
};
use serde_json::{Value, json};
use tokio::{
    sync::{Notify, Semaphore},
    task::LocalSet,
};
use tokio_util::sync::CancellationToken;

const ORIGIN: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TARGET: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

struct Fixture<F>(F);

#[async_trait(?Send)]
impl<F, Fut> ControllerCliRoutes for Fixture<F>
where
    F: Fn(CliHttpRequest, DelegatedCliContext) -> Fut,
    Fut: Future<Output = Option<CliRouteResponse>>,
{
    async fn invoke(
        &self,
        request: CliHttpRequest,
        context: DelegatedCliContext,
    ) -> Option<CliRouteResponse> {
        (self.0)(request, context).await
    }
}

fn dispatcher(routes: impl ControllerCliRoutes + 'static) -> ControllerCliDispatcher {
    ControllerCliDispatcher::new(
        Rc::new(routes),
        "controller".into(),
        Some("fixture".into()),
        Rc::new(|| false),
        Rc::new(ActivityTracker::default()),
    )
}

fn endpoint(lane: RpcLane, id: &str) -> Rc<ExecutorRpc> {
    ExecutorRpc::new(
        SessionTransport::new(
            id.into(),
            "worker".into(),
            Rc::new(|_| {}),
            SessionTransportOptions {
                executor_id: ORIGIN.into(),
                lane,
                primary_session_id: Some("parent".into()),
                ..Default::default()
            },
        )
        .unwrap(),
        ExecutorRpcContinuity::default(),
    )
}

fn access(endpoint: &ExecutorRpc) -> CliDispatchAccess {
    CliDispatchAccess::from_rpc(
        endpoint,
        CancellationToken::new(),
        Rc::new(|| Ok(())),
        Rc::new(|| Ok(())),
    )
}

fn response(status: u16, body: &'static str, retry_after: Option<&str>) -> CliRouteResponse {
    CliRouteResponse {
        status,
        body: Some(stream::iter([Ok(Bytes::from_static(body.as_bytes()))]).boxed_local()),
        retry_after: retry_after.map(str::to_owned),
    }
}

fn request(operation: &str, body: Value) -> Value {
    json!({"expectedServerInstanceId": "controller", "http": {"operation": operation, "query": [], "body": body}})
}

fn discard_guard() -> GuardRpcReply {
    Rc::new(|_| {})
}

fn record_guard() -> (Rc<RefCell<Option<RpcReplyGuard>>>, GuardRpcReply) {
    let saved = Rc::new(RefCell::new(None));
    let writable = saved.clone();
    (
        saved,
        Rc::new(move |guard| {
            writable.replace(Some(guard));
        }),
    )
}

fn code(error: &(dyn std::error::Error + 'static)) -> ErrorCode {
    as_domain_error(error)
        .unwrap_or_else(|| panic!("unexpected CLI error: {error}"))
        .code
}

#[test]
fn cli_dispatch_replies_and_errors_match_bun() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let local = LocalSet::new();
    let statistics = replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/remote_client_cli_dispatch"
        ),
        |function, args| {
            if function != "dispatchCli" {
                return Err(CaseError::unhandled(function));
            }
            let decoded = |index: usize| unknown(function, args.get(index));
            let request = decoded(0)?;
            let lane = match decoded(1)?.as_str() {
                Some("primary") => RpcLane::Primary,
                Some("bulk") => RpcLane::Bulk,
                _ => return Err(CaseError::unhandled(function)),
            };
            let body = decoded(2)?
                .as_str()
                .ok_or_else(|| CaseError::unhandled(function))?
                .to_owned();
            let retry_after = decoded(3)?.as_str().map(str::to_owned);
            let result = local.block_on(&runtime, async {
                let service = dispatcher(Fixture(
                    move |request: CliHttpRequest, _: DelegatedCliContext| {
                        let body = body.clone();
                        let retry_after = retry_after.clone();
                        async move {
                            if !matches!(
                                request.operation.as_str(),
                                "GET /api/v1/chats"
                                    | "POST /api/v1/chats/run"
                                    | "GET /api/v1/chats/turn-receipt"
                                    | "POST /api/v1/chats/stop"
                            ) {
                                return None;
                            }
                            Some(CliRouteResponse {
                                status: 409,
                                retry_after,
                                body: Some(stream::iter([Ok(Bytes::from(body))]).boxed_local()),
                            })
                        }
                    },
                ));
                service
                    .request(
                        &request,
                        &access(&endpoint(lane, "fixture")),
                        &discard_guard(),
                    )
                    .await
            });
            result
                .map(|reply| {
                    garcon_js::json::from_str(&serde_json::to_string(&reply).unwrap()).unwrap()
                })
                .map_err(|error| {
                    let Some(domain) = as_domain_error(error.as_ref()) else {
                        return CaseError::new("Error", error.to_string());
                    };
                    CaseError::new(domain.kind.name(), &domain.message)
                        .with_property("code", json!(domain.code.as_str()))
                        .with_property("status", json!(domain.status))
                        .with_property("retryable", json!(domain.retryable))
                })
        },
    );
    assert_eq!(statistics.total, statistics.passed);
    assert_eq!(statistics.with_wildcards, 0);
}

#[tokio::test]
async fn dispatcher_retains_delegated_origin_query_order_and_application_error_bytes() {
    LocalSet::new().run_until(async {
        let calls = Rc::new(Cell::new(0));
        let visited = calls.clone();
        let service = dispatcher(Fixture(move |request: CliHttpRequest, context: DelegatedCliContext| {
            visited.set(visited.get() + 1);
            async move {
                assert_eq!(context.executor_id(), ORIGIN);
                context.assert_current().unwrap();
                assert_eq!(request.operation.as_str(), "GET /api/v1/chats");
                assert_eq!(request.query, [["exclude", "tools"], ["exclude", "reasoning"]]);
                Some(response(409, r#"{"success":false,"error":"Synthetic rejection","n":1.0,"big":9007199254740993,"exp21":1e21}"#, Some("2")))
            }
        }));
        let mut input = request("GET /api/v1/chats", Value::Null);
        input["http"]["query"] = json!([["exclude", "tools"], ["exclude", "reasoning"]]);
        let primary = endpoint(RpcLane::Primary, "parent");
        let bulk = endpoint(RpcLane::Bulk, "bulk");
        let result = service.request(&input, &access(&bulk), &discard_guard()).await.unwrap();
        assert_eq!(serde_json::to_string(&result).unwrap(), r#"{"status":409,"body":{"success":false,"error":"Synthetic rejection","n":1,"big":9007199254740992,"exp21":1e+21},"retryAfter":"2"}"#);
        assert_eq!(service.describe(&access(&primary), &discard_guard()).unwrap().default_executor_id, ORIGIN);
        let wrong_lane = service.request(&input, &access(&primary), &discard_guard()).await.unwrap_err();
        assert_eq!(code(wrong_lane.as_ref()), ErrorCode::CLI_ACCESS_DENIED);
        input["expectedServerInstanceId"] = json!("old");
        let old = service.request(&input, &access(&bulk), &discard_guard()).await.unwrap_err();
        assert_eq!(code(old.as_ref()), ErrorCode::CLI_CONTROLLER_CHANGED);
        assert_eq!(calls.get(), 1);
    }).await;
}

#[tokio::test]
async fn grants_and_target_validation_precede_dispatch_and_stale_reply_publication() {
    LocalSet::new()
        .run_until(async {
            let calls = Rc::new(Cell::new(0));
            let visited = calls.clone();
            let service = dispatcher(Fixture(
                move |request: CliHttpRequest, context: DelegatedCliContext| {
                    visited.set(visited.get() + 1);
                    async move {
                        assert_eq!(context.executor_id(), ORIGIN);
                        assert_eq!(request.executor_id.as_deref(), Some(TARGET));
                        Some(response(200, r#"{"connectionUrl":"fixture"}"#, None))
                    }
                },
            ));
            let bulk = endpoint(RpcLane::Bulk, "bulk");
            let prepare = |allowed: Rc<Cell<bool>>, manage: Rc<Cell<bool>>, signal| {
                CliDispatchAccess::from_rpc(
                    &bulk,
                    signal,
                    Rc::new(move || {
                        if allowed.get() {
                            Ok(())
                        } else {
                            Err(DomainError::new(
                                ErrorCode::CLI_ACCESS_DENIED,
                                "CLI grant revoked",
                                403,
                                false,
                            ))
                        }
                    }),
                    Rc::new(move || {
                        if manage.get() {
                            Ok(())
                        } else {
                            Err(DomainError::new(
                                ErrorCode::CLI_ACCESS_DENIED,
                                "Management denied",
                                403,
                                false,
                            ))
                        }
                    }),
                )
            };
            let allowed = Rc::new(Cell::new(false));
            let manage = Rc::new(Cell::new(false));
            let signal = CancellationToken::new();
            let access = prepare(allowed.clone(), manage.clone(), signal.clone());
            let mut input = request("GET /api/v1/executors/:executorId/connection", Value::Null);
            input["http"]["executorId"] = json!(TARGET);
            let (guard, register) = record_guard();
            for (allow, manage_allowed) in [(false, false), (true, false)] {
                allowed.set(allow);
                manage.set(manage_allowed);
                let denied = service
                    .request(&input, &access, &register)
                    .await
                    .unwrap_err();
                assert_eq!(code(denied.as_ref()), ErrorCode::CLI_ACCESS_DENIED);
            }
            manage.set(true);
            let mut invalid = input.clone();
            invalid["http"]["executorId"] = json!("../settings");
            assert!(service.request(&invalid, &access, &register).await.is_err());
            let mut unwanted = request("GET /api/v1/private", Value::Null);
            unwanted["http"]["principal"] = json!("local");
            assert!(
                service
                    .request(&unwanted, &access, &register)
                    .await
                    .is_err()
            );
            assert!(
                service
                    .request(
                        &request(
                            "POST /api/v1/chats/start",
                            json!({"projectPath":"/same/path"})
                        ),
                        &access,
                        &register
                    )
                    .await
                    .is_err()
            );
            assert_eq!(calls.get(), 0);
            assert!(guard.borrow().is_none());

            assert_eq!(
                service
                    .request(&input, &access, &register)
                    .await
                    .unwrap()
                    .status,
                200
            );
            let guard = guard.borrow_mut().take().unwrap();
            manage.set(false);
            assert_eq!(
                code(guard(100).unwrap_err().as_ref()),
                ErrorCode::CLI_ACCESS_DENIED
            );
            manage.set(true);
            signal.cancel();
            assert_eq!(
                code(guard(100).unwrap_err().as_ref()),
                ErrorCode::CLI_CONTROLLER_UNAVAILABLE
            );
            assert_eq!(calls.get(), 1);
        })
        .await;
}

struct Blocked;

impl SessionSocket for Blocked {
    fn send(&self, _: String) -> Result<(), SessionError> {
        Ok(())
    }
    fn can_send(&self, _: usize) -> bool {
        false
    }
    fn close(&self) {}
}

struct ObserveDrop(Rc<Cell<bool>>);

impl Drop for ObserveDrop {
    fn drop(&mut self) {
        self.0.set(true);
    }
}

#[tokio::test]
async fn bounds_and_queue_pressure_distinguish_reads_from_potentially_committed_mutations() {
    LocalSet::new()
        .run_until(async {
            for mutation in [false, true] {
                let pulls = Rc::new(Cell::new(0));
                let dropped = Rc::new(Cell::new(false));
                let oversized = Rc::new(Cell::new(true));
                let service = dispatcher(Fixture({
                    let pulls = pulls.clone();
                    let dropped = dropped.clone();
                    let oversized = oversized.clone();
                    move |_: CliHttpRequest, _: DelegatedCliContext| {
                        let chunk = Bytes::from(vec![b'x'; 64 * 1024]);
                        let handle = (pulls.clone(), ObserveDrop(dropped.clone()));
                        let huge = oversized.get();
                        async move {
                            if !huge {
                                return Some(response(200, "null", Some("Friday")));
                            }
                            let body = stream::unfold(handle, move |(pulls, held)| {
                                pulls.set(pulls.get() + 1);
                                let chunk = chunk.clone();
                                async move { Some((Ok(chunk), (pulls, held))) }
                            })
                            .boxed_local();
                            Some(CliRouteResponse {
                                status: 200,
                                retry_after: None,
                                body: Some(body),
                            })
                        }
                    }
                }));
                let bulk = endpoint(RpcLane::Bulk, "bulk");
                let _socket = bulk.transport.attach(Rc::new(Blocked)).unwrap();
                let input = if mutation {
                    request("POST /api/v1/chats/run", json!({}))
                } else {
                    request("GET /api/v1/chats", Value::Null)
                };
                let (guard, register) = record_guard();
                let oversized_error = service
                    .request(&input, &access(&bulk), &register)
                    .await
                    .unwrap_err();
                assert_eq!(
                    code(oversized_error.as_ref()),
                    if mutation {
                        ErrorCode::CLI_OUTCOME_UNKNOWN
                    } else {
                        ErrorCode::CLI_RESULT_TOO_LARGE
                    }
                );
                assert!(dropped.get());
                assert!(pulls.get() <= CLI_REPLY_BYTES / (64 * 1024) + 1);
                oversized.set(false);
                let response = service
                    .request(&input, &access(&bulk), &register)
                    .await
                    .unwrap();
                assert!(response.retry_after.is_none());
                bulk.transport.send("x".repeat(CLI_REPLY_BYTES)).unwrap();
                let guard = guard.borrow_mut().take().unwrap();
                guard(CLI_SMALL_REPLY_BYTES).unwrap();
                let pressure = guard(CLI_SMALL_REPLY_BYTES + 1).unwrap_err();
                assert_eq!(
                    code(pressure.as_ref()),
                    if mutation {
                        ErrorCode::CLI_OUTCOME_UNKNOWN
                    } else {
                        ErrorCode::CLI_SERVICE_BUSY
                    }
                );
            }
        })
        .await;
}

#[tokio::test]
async fn cancelled_cli_waiters_do_not_release_unsettled_work_across_replacement() {
    LocalSet::new()
        .run_until(async {
            let entered = Rc::new(Semaphore::new(0));
            let release = Rc::new(Notify::new());
            let seen = Rc::new(RefCell::new(Vec::<CancellationToken>::new()));
            let service = Rc::new(dispatcher(Fixture({
                let entered = entered.clone();
                let release = release.clone();
                let seen = seen.clone();
                move |request: CliHttpRequest, context: DelegatedCliContext| {
                    let release = release.clone();
                    let entered = entered.clone();
                    let seen = seen.clone();
                    async move {
                        if request.operation.as_str() == "POST /api/v1/chats/fork" {
                            seen.borrow_mut().push(context.signal().clone());
                            entered.add_permits(1);
                            release.notified().await;
                        }
                        Some(response(200, "[]", None))
                    }
                }
            })));
            let old = endpoint(RpcLane::Bulk, "old");
            let replacement = endpoint(RpcLane::Bulk, "replacement");
            let signal = CancellationToken::new();
            let original = CliDispatchAccess::from_rpc(
                &old,
                signal.clone(),
                Rc::new(|| Ok(())),
                Rc::new(|| Ok(())),
            );
            let input = request("POST /api/v1/chats/fork", json!({}));
            let mut tasks = Vec::new();
            for _ in 0..2 {
                let service = service.clone();
                let input = input.clone();
                let original = original.clone();
                tasks.push(tokio::task::spawn_local(async move {
                    service.request(&input, &original, &discard_guard()).await
                }));
            }
            let admitted = entered.acquire_many(2).await.unwrap();
            signal.cancel();
            for task in tasks {
                assert_eq!(
                    code(task.await.unwrap().unwrap_err().as_ref()),
                    ErrorCode::CLI_OUTCOME_UNKNOWN
                );
            }
            assert!(seen.borrow().iter().all(CancellationToken::is_cancelled));
            let still_busy = service
                .request(&input, &access(&replacement), &discard_guard())
                .await
                .unwrap_err();
            assert_eq!(code(still_busy.as_ref()), ErrorCode::CLI_SERVICE_BUSY);
            assert_eq!(
                service
                    .request(
                        &request("GET /api/v1/chats", Value::Null),
                        &access(&replacement),
                        &discard_guard()
                    )
                    .await
                    .unwrap()
                    .status,
                200
            );
            release.notify_waiters();
            drop(admitted);
        })
        .await;
}
