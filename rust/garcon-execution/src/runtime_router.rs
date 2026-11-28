//! Routes provider-facing reads, steering, and permission responses.
//! Launch, producer binding, and settlement are not assembled here yet.

use std::{
    future::Future,
    rc::Rc,
    task::{Context, Poll, Waker},
};

use garcon_base::{
    executor_disconnect::as_agent_call_error, unhandled_rejection_policy::UnhandledRejectionPolicy,
};
use garcon_contract::{
    chat_command_contracts::PermissionDecisionPayload,
    chat_transient_feed::ChatTransientControlAction, executors::effective_executor_id,
    slash_commands::SlashCommand,
};
use garcon_interface::{
    errors::{AgentCallError, AgentDeliveryOutcome},
    producer::{AgentPermissionRespondRequest, AgentPermissions},
    resources::{AgentPermissionResponseRef, ExecutorCallOptions},
    services::{
        AgentCommands, AgentSteerRejectionReason, AgentSteerRequest, AgentSteerResult,
        AgentSteerTarget, AgentSteering,
    },
    transcript::AgentNativeSessionRef,
};
use indexmap::IndexMap;
use serde::Serialize;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::{
    directory::AgentDirectory,
    session_types::{
        AgentSteerOptions, PersistedChatExecutionConfig, require_chat_execution_config,
    },
    steering_errors::steering_unsupported_error,
    types::{ExecutionOperationResult, PrepareSteerDelivery, execution_error_input},
};

/// The router's projection of the chat registry, not a second chat store.
#[derive(Debug, Clone)]
pub struct RoutingChat {
    pub agent_id: String,
    pub agent_session_id: Option<String>,
    pub native_session: Option<AgentNativeSessionRef>,
    pub execution: PersistedChatExecutionConfig,
}

pub trait RuntimeRouterChats {
    fn get_chat(&self, chat_id: &str) -> Option<RoutingChat>;
}

pub trait RuntimeRouterIntegrations {
    fn permissions(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Rc<dyn AgentPermissions>>;
    fn steering(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Option<Rc<dyn AgentSteering>>>;
    fn local_agent_ids(&self) -> ExecutionOperationResult<Vec<String>>;
    fn find_commands(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Option<Rc<dyn AgentCommands>>>;
}

impl RuntimeRouterIntegrations for AgentDirectory {
    fn permissions(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Rc<dyn AgentPermissions>> {
        Ok(self.require(agent_id, executor_id)?.permissions.clone())
    }
    fn steering(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Option<Rc<dyn AgentSteering>>> {
        Ok(self.require(agent_id, executor_id)?.steering.clone())
    }
    fn local_agent_ids(&self) -> ExecutionOperationResult<Vec<String>> {
        Ok(self
            .list(None)?
            .iter()
            .map(|integration| integration.descriptor.id.clone())
            .collect())
    }
    fn find_commands(
        &self,
        agent_id: &str,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Option<Rc<dyn AgentCommands>>> {
        Ok(self
            .list(executor_id)?
            .into_iter()
            .find(|integration| integration.descriptor.id == agent_id)
            .and_then(|integration| integration.commands.clone()))
    }
}

/// Consumes the exact ledger-owned claim, without re-looking up a live permission.
pub trait RouterPermissionClaim {
    fn response(&self) -> &AgentPermissionResponseRef;
    fn abandon(self: Box<Self>) -> ExecutionOperationResult<()>;
    fn retire(self: Box<Self>) -> ExecutionOperationResult<()>;
    fn complete(
        self: Box<Self>,
        decision: PermissionDecisionPayload,
    ) -> ExecutionOperationResult<()>;
}

pub trait RuntimeRouterLedger {
    fn active_chat_ids(&self) -> Vec<String>;
    fn is_run_active(&self, chat_id: &str) -> bool;
    fn claim_permission_resolution(
        &self,
        control: &ChatTransientControlAction,
    ) -> ExecutionOperationResult<Box<dyn RouterPermissionClaim>>;
    fn take_prepared_input(
        &self,
        chat_id: &str,
        client_message_id: &str,
    ) -> ExecutionOperationResult<()>;
}

pub struct AgentRuntimeRouterOptions {
    pub registry: Rc<dyn RuntimeRouterChats>,
    pub directory: Rc<dyn RuntimeRouterIntegrations>,
    pub ledger: Rc<dyn RuntimeRouterLedger>,
    pub unhandled_rejections: Rc<UnhandledRejectionPolicy>,
}

pub struct AgentRuntimeRouter {
    options: AgentRuntimeRouterOptions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunningSession {
    pub id: String,
    pub status: RunningSessionStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RunningSessionStatus {
    Running,
}

#[derive(Debug, thiserror::Error)]
enum PermissionRoutingError {
    #[error("Permission occurrence ID is required")]
    MissingOccurrenceId,
    #[error("Permission control does not match the request")]
    MismatchedControl,
}

impl AgentRuntimeRouter {
    pub fn new(options: AgentRuntimeRouterOptions) -> Self {
        Self { options }
    }

    pub async fn steer_input(
        &self,
        chat_id: &str,
        input: &str,
        options: &AgentSteerOptions,
        target: Option<&AgentSteerTarget>,
        prepare_delivery: PrepareSteerDelivery<'_>,
        deadline: Option<f64>,
    ) -> ExecutionOperationResult<AgentSteerResult> {
        let entry = self.options.registry.get_chat(chat_id);
        let config =
            require_chat_execution_config(chat_id, entry.as_ref().map(|entry| &entry.execution))?;
        // INFALLIBLE: a required execution config was only obtained from an existing entry.
        let entry = entry.expect("required chat execution config belongs to a chat");
        let Some(session) = entry.agent_session_id.filter(|id| !id.is_empty()) else {
            return Ok(AgentSteerResult::Rejected {
                reason: AgentSteerRejectionReason::NoActiveTurn,
                message: "No active agent session".into(),
            });
        };
        let steering = self
            .options
            .directory
            .steering(&entry.agent_id, config.executor_id.as_deref())?
            .ok_or_else(steering_unsupported_error)?;
        prepare_delivery().await?;
        self.options
            .ledger
            .take_prepared_input(chat_id, &options.client_message_id)?;
        steering
            .steer(
                AgentSteerRequest {
                    chat_id: chat_id.into(),
                    project_path: config.project_path,
                    agent_session_id: session,
                    native_session: entry.native_session,
                    target: target.cloned(),
                    input: input.into(),
                    client_message_id: options.client_message_id.clone(),
                    question_reply: options.question_reply.clone(),
                },
                Some(dispatch_options(deadline)),
            )
            .await
    }

    pub fn is_chat_running(&self, chat_id: &str) -> bool {
        self.options.ledger.is_run_active(chat_id)
    }

    pub fn is_agent_session_running(
        &self,
        agent_id: &str,
        session: Option<&str>,
        executor_id: Option<&str>,
    ) -> bool {
        let Some(session) = session.filter(|id| !id.is_empty()) else {
            return false;
        };
        let executor = effective_executor_id(executor_id);
        self.options.ledger.active_chat_ids().iter().any(|chat| {
            self.options.registry.get_chat(chat).is_some_and(|entry| {
                entry.agent_id == agent_id
                    && entry.agent_session_id.as_deref() == Some(session)
                    && effective_executor_id(entry.execution.executor_id.as_deref()) == executor
            })
        })
    }

    pub fn get_running_sessions(
        &self,
    ) -> ExecutionOperationResult<IndexMap<String, Vec<RunningSession>>> {
        let active = self.options.ledger.active_chat_ids();
        Ok(self
            .options
            .directory
            .local_agent_ids()?
            .into_iter()
            .map(|agent_id| {
                let sessions = active
                    .iter()
                    .filter(|chat| {
                        self.options
                            .registry
                            .get_chat(chat)
                            .is_some_and(|entry| entry.agent_id == agent_id)
                    })
                    .map(|chat| RunningSession {
                        id: chat.clone(),
                        status: RunningSessionStatus::Running,
                    })
                    .collect();
                (agent_id, sessions)
            })
            .collect())
    }

    pub fn get_running_chat_ids_snapshot(&self) -> Vec<String> {
        let mut chats = self.options.ledger.active_chat_ids();
        chats.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
        chats
    }

    pub fn get_running_session_count(&self) -> usize {
        self.options.ledger.active_chat_ids().len()
    }

    pub async fn resolve_permission(
        &self,
        chat_id: &str,
        occurrence_id: &str,
        decision: PermissionDecisionPayload,
        control: &ChatTransientControlAction,
        deadline: f64,
    ) -> ExecutionOperationResult<()> {
        if occurrence_id.is_empty() {
            return Err(PermissionRoutingError::MissingOccurrenceId.into());
        }
        if control.chat_id != chat_id || control.permission_occurrence_id != occurrence_id {
            return Err(PermissionRoutingError::MismatchedControl.into());
        }
        let entry = self.options.registry.get_chat(chat_id).ok_or_else(|| {
            AgentCallError::new(
                AgentDeliveryOutcome::Rejected,
                "Permission chat no longer exists",
            )
        })?;
        let executor = entry.execution.executor_id.as_deref();
        let permissions = self
            .options
            .directory
            .permissions(&entry.agent_id, executor)?;
        let claim = self.options.ledger.claim_permission_resolution(control)?;
        let response = claim.response().clone();
        if response.scope.executor_id != effective_executor_id(executor)
            || response.scope.integration_id != entry.agent_id
        {
            claim.retire()?;
            return Err(AgentCallError::new(
                AgentDeliveryOutcome::Rejected,
                "Permission belongs to another execution target",
            )
            .into());
        }
        let mut operation = Box::pin(async move {
            let result = permissions
                .respond(
                    AgentPermissionRespondRequest {
                        response,
                        decision: decision.clone(),
                    },
                    Some(dispatch_options(Some(deadline))),
                )
                .await;
            if let Err(error) = result {
                if as_agent_call_error(error.as_ref())
                    .is_some_and(|error| error.outcome == AgentDeliveryOutcome::NotDispatched)
                {
                    claim.abandon()?;
                } else {
                    claim.retire()?;
                }
                return Err(error);
            }
            claim.complete(decision)
        });
        if let Poll::Ready(result) = operation
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            return result;
        }
        // A dropped requester cannot strand the claim or change the delivery outcome.
        let policy = self.options.unhandled_rejections.clone();
        let (done, result) = oneshot::channel();
        tokio::task::spawn_local(async move {
            if let Err(Err(error)) = done.send(operation.await) {
                policy.report(execution_error_input(error.as_ref()));
            }
        });
        result.await?
    }

    pub async fn discover_slash_commands(
        &self,
        agent_id: &str,
        project_path: &str,
        executor_id: Option<&str>,
    ) -> ExecutionOperationResult<Vec<SlashCommand>> {
        match self
            .options
            .directory
            .find_commands(agent_id, executor_id)?
        {
            Some(commands) => {
                commands
                    .discover(project_path, CancellationToken::new())
                    .await
            }
            None => Ok(Vec::new()),
        }
    }
}

fn dispatch_options(dispatch_deadline: Option<f64>) -> ExecutorCallOptions {
    ExecutorCallOptions {
        dispatch_deadline,
        ..ExecutorCallOptions::default()
    }
}
