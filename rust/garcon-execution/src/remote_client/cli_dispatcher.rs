//! Dispatches allowlisted reverse CLI calls without creating a second HTTP
//! listener or granting Local authority to a remote executor.

use std::{error::Error, future::pending, pin::pin, rc::Rc, time::Duration};

use async_trait::async_trait;
use bytes::Bytes;
use futures::stream::LocalBoxStream;
use garcon_base::{
    bounded_text_stream::read_text_stream_with_limit,
    domain_error::{DomainError, as_domain_error},
    event_loop_stalls::ActivityTracker,
};
use garcon_contract::{error_codes::ErrorCode, server_runtime::CliContext};
use garcon_js::json::{Opaque, from_str};
use garcon_link::{
    cli_admission::{CliAdmission, CliAdmissionLease},
    cli_protocol::{
        CLI_ENVELOPE_BYTES, CLI_REPLY_BYTES, CLI_SMALL_REPLY_BYTES, CliHttpRequest, CliPolicy,
        CliPool, cli_policy, cli_reply_bytes, parse_controller_cli_request,
    },
    message_session::SessionError,
    rpc::{ExecutorRpc, GuardRpcReply},
    rpc_lane::RpcLane,
    session_transport::SessionTransport,
};
use serde::Serialize;
use serde_json::Value;
use tokio::{
    sync::oneshot,
    time::{Instant, sleep_until},
};
use tokio_util::sync::CancellationToken;

type BoxError = Box<dyn Error>;
type Assertion = dyn Fn() -> Result<(), DomainError>;

/// Affirms the captured manager entry, parent and actual lane, readiness and
/// CLI grant. Both assertions must consult current authority, not dial config.
#[derive(Clone)]
pub struct CliDispatchAccess {
    transport: Rc<SessionTransport>,
    signal: CancellationToken,
    assert_current: Rc<Assertion>,
    assert_management: Rc<Assertion>,
}

impl CliDispatchAccess {
    pub fn from_rpc(
        rpc: &ExecutorRpc,
        signal: CancellationToken,
        assert_current: Rc<Assertion>,
        assert_management: Rc<Assertion>,
    ) -> Self {
        Self {
            transport: rpc.transport.clone(),
            signal,
            assert_current,
            assert_management,
        }
    }
}

/// Only the application route adapter converts this to its executor principal.
/// The optional target remains in the request and cannot change the origin.
pub struct DelegatedCliContext {
    executor_id: String,
    signal: CancellationToken,
    assert_current: Rc<Assertion>,
}

impl DelegatedCliContext {
    pub fn executor_id(&self) -> &str {
        &self.executor_id
    }

    pub fn signal(&self) -> &CancellationToken {
        &self.signal
    }

    pub fn assert_current(&self) -> Result<(), DomainError> {
        (self.assert_current)()
    }
}

pub struct CliRouteResponse {
    pub status: u16,
    /// The adapter reads the header with Fetch semantics, including repeats.
    pub retry_after: Option<String>,
    /// Dropping an incomplete body cancels the producer, just like HTTP.
    pub body: Option<LocalBoxStream<'static, Result<Bytes, BoxError>>>,
}

#[async_trait(?Send)]
pub trait ControllerCliRoutes {
    /// Invokes the existing handler with the delegated context and translates
    /// its application errors as the direct HTTP route would. None means that
    /// the handler has not been installed.
    async fn invoke(
        &self,
        request: CliHttpRequest,
        context: DelegatedCliContext,
    ) -> Option<CliRouteResponse>;
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDispatchReply {
    pub status: u16,
    pub body: Opaque,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
}

pub struct ControllerCliDispatcher {
    routes: Rc<dyn ControllerCliRoutes>,
    server_instance_id: String,
    workspace_name: Option<String>,
    is_shutting_down: Rc<dyn Fn() -> bool>,
    activity: Rc<ActivityTracker>,
    admission: CliAdmission,
}

struct Lease(CliAdmissionLease);

impl Drop for Lease {
    fn drop(&mut self) {
        self.0.release();
    }
}

impl ControllerCliDispatcher {
    pub fn new(
        routes: Rc<dyn ControllerCliRoutes>,
        server_instance_id: String,
        workspace_name: Option<String>,
        is_shutting_down: Rc<dyn Fn() -> bool>,
        activity: Rc<ActivityTracker>,
    ) -> Self {
        Self {
            routes,
            server_instance_id,
            workspace_name,
            is_shutting_down,
            activity,
            admission: CliAdmission::default(),
        }
    }

    pub fn describe(
        &self,
        access: &CliDispatchAccess,
        guard_reply: &GuardRpcReply,
    ) -> Result<CliContext, DomainError> {
        assert_admission(access, &*self.is_shutting_down)?;
        let assert = {
            let access = access.clone();
            let shutting_down = self.is_shutting_down.clone();
            move |_| assert_admission(&access, &*shutting_down).map_err(shared_error)
        };
        guard_reply(Rc::new(assert));
        let _lease = Lease(self.admission.acquire(
            &access.transport.executor_id,
            CliPool::Short,
            RpcLane::Primary,
        )?);
        Ok(CliContext {
            server_instance_id: self.server_instance_id.clone(),
            default_executor_id: access.transport.executor_id.clone(),
            workspace_name: self.workspace_name.clone(),
        })
    }

    pub async fn request(
        &self,
        value: &Value,
        access: &CliDispatchAccess,
        guard_reply: &GuardRpcReply,
    ) -> Result<CliDispatchReply, BoxError> {
        assert_admission(access, &*self.is_shutting_down)?;
        let request = parse_controller_cli_request(value)?;
        if request.expected_server_instance_id != self.server_instance_id {
            return Err(DomainError::new(
                ErrorCode::CLI_CONTROLLER_CHANGED,
                "Garcon restarted; start a new CLI invocation",
                409,
                false,
            )
            .into());
        }
        let policy = cli_policy(request.http.operation, &request.http.body);
        if access.transport.lane != policy.lane {
            return Err(DomainError::new(
                ErrorCode::CLI_ACCESS_DENIED,
                "CLI operation arrived on the wrong lane",
                403,
                false,
            )
            .into());
        }
        let assert = {
            let access = access.clone();
            let shutting_down = self.is_shutting_down.clone();
            Rc::new(move || {
                assert_admission(&access, &*shutting_down)?;
                if policy.management {
                    (access.assert_management)()?;
                }
                Ok(())
            }) as Rc<Assertion>
        };
        assert()?;
        let lease = Lease(self.admission.acquire(
            &access.transport.executor_id,
            policy.pool,
            policy.lane,
        )?);
        let signal = access.signal.child_token();
        let publication = {
            let signal = signal.clone();
            let assert = assert.clone();
            Rc::new(move || assert_publication(&signal, &*assert, policy))
        };
        guard_reply(Rc::new({
            let transport = access.transport.clone();
            let publication = publication.clone();
            move |bytes| {
                publication().map_err(shared_error)?;
                reply_admission(bytes, transport.channel.queued_bytes(), policy)
                    .map_err(shared_error)
            }
        }));
        let context = DelegatedCliContext {
            executor_id: access.transport.executor_id.clone(),
            signal: signal.clone(),
            assert_current: Rc::new({
                let signal = signal.clone();
                let assert = assert.clone();
                move || {
                    assert()?;
                    if signal.is_cancelled() {
                        Err(interrupted(policy))
                    } else {
                        Ok(())
                    }
                }
            }),
        };
        let routes = self.routes.clone();
        let activity = self.activity.clone();
        let deadline = policy
            .timeout_ms
            .map(|ms| Instant::now() + Duration::from_millis(ms));
        let (reply, received) = oneshot::channel();
        // The work owns admission until settlement, even when the RPC waiter stops.
        tokio::task::spawn_local(async move {
            let _lease = lease;
            let mut work = pin!(async move {
                assert()?;
                let label = format!("cli {}", request.http.operation.as_str());
                let response = activity
                    .with_activity(&label, routes.invoke(request.http, context))
                    .await
                    .ok_or_else(|| {
                        DomainError::new(
                            ErrorCode::CLI_CONTROLLER_UNAVAILABLE,
                            "Controller CLI services are not initialized",
                            503,
                            true,
                        )
                    })?;
                encode_response(response, policy, &*publication).await
            });
            let timer = async {
                if let Some(deadline) = deadline {
                    sleep_until(deadline).await;
                } else {
                    pending::<()>().await;
                }
            };
            tokio::select! {
                biased;
                result = &mut work => { let _ = reply.send(result); }
                () = signal.cancelled() => { let _ = reply.send(Err(interrupted(policy).into())); let _ = work.await; }
                () = timer => { signal.cancel(); let _ = reply.send(Err(interrupted(policy).into())); let _ = work.await; }
            }
        });
        received.await.map_err(|_| interrupted(policy))?
    }
}

async fn encode_response(
    mut response: CliRouteResponse,
    policy: CliPolicy,
    assert_publication: &Assertion,
) -> Result<CliDispatchReply, BoxError> {
    assert_publication()?;
    let limit = cli_reply_bytes(policy.lane);
    let text = match read_text_stream_with_limit(
        response.body.as_mut(),
        limit - CLI_ENVELOPE_BYTES,
        || oversized(policy).into(),
    )
    .await
    {
        Ok(text) => text,
        Err(error)
            if as_domain_error(error.as_ref())
                .is_some_and(|error| error.code == ErrorCode::CLI_RESULT_TOO_LARGE) =>
        {
            return Err(error);
        }
        Err(_) => return Err(interrupted(policy).into()),
    };
    let body = from_str(&text).map_err(|_| interrupted(policy))?;
    assert_publication()?;
    let reply = CliDispatchReply {
        status: response.status,
        body,
        retry_after: response.retry_after.filter(|value| {
            !value.is_empty() && value.len() <= 5 && value.bytes().all(|byte| byte.is_ascii_digit())
        }),
    };
    if serde_json::to_vec(&reply)?.len() + CLI_ENVELOPE_BYTES > limit {
        return Err(oversized(policy).into());
    }
    Ok(reply)
}

fn assert_admission(
    access: &CliDispatchAccess,
    shutting_down: &dyn Fn() -> bool,
) -> Result<(), DomainError> {
    (access.assert_current)()?;
    if shutting_down() {
        return Err(DomainError::new(
            ErrorCode::SERVER_SHUTTING_DOWN,
            "The server is shutting down",
            503,
            true,
        ));
    }
    if access.signal.is_cancelled() {
        return Err(DomainError::new(
            ErrorCode::CLI_CONTROLLER_UNAVAILABLE,
            "Controller CLI request cancelled before dispatch",
            503,
            true,
        ));
    }
    Ok(())
}

fn assert_publication(
    signal: &CancellationToken,
    assert: &Assertion,
    policy: CliPolicy,
) -> Result<(), DomainError> {
    if signal.is_cancelled() {
        return Err(interrupted(policy));
    }
    assert().map_err(|error| {
        if policy.mutation {
            interrupted(policy)
        } else {
            error
        }
    })
}

fn reply_admission(bytes: usize, queued: usize, policy: CliPolicy) -> Result<(), DomainError> {
    if bytes > cli_reply_bytes(policy.lane) {
        return Err(oversized(policy));
    }
    if bytes <= CLI_SMALL_REPLY_BYTES || queued.saturating_add(bytes) <= CLI_REPLY_BYTES {
        return Ok(());
    }
    if policy.mutation {
        return Err(interrupted(policy));
    }
    Err(DomainError::new(
        ErrorCode::CLI_SERVICE_BUSY,
        "Executor channel is busy; retry the read later",
        503,
        true,
    ))
}

fn interrupted(policy: CliPolicy) -> DomainError {
    if policy.mutation {
        DomainError::new(
            ErrorCode::CLI_OUTCOME_UNKNOWN,
            "The CLI operation may have reached Garcon; its outcome is unknown",
            503,
            false,
        )
    } else {
        DomainError::new(
            ErrorCode::CLI_CONTROLLER_UNAVAILABLE,
            "The controller CLI request was interrupted",
            503,
            true,
        )
    }
}

fn oversized(policy: CliPolicy) -> DomainError {
    if policy.mutation {
        return interrupted(policy);
    }
    let limit = if policy.lane == RpcLane::Primary {
        "64 KiB"
    } else {
        "8 MiB"
    };
    DomainError::new(
        ErrorCode::CLI_RESULT_TOO_LARGE,
        format!("CLI result exceeds {limit}; narrow the requested result"),
        413,
        false,
    )
}

fn shared_error(error: DomainError) -> SessionError {
    Rc::new(error)
}
