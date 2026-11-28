//! Ports `server-agents/common/src/execution/producer-adapter.ts`.

use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    error::Error,
    future::Future,
    ops::Bound::{Excluded, Unbounded},
    rc::{Rc, Weak},
};

use async_trait::async_trait;
use futures::FutureExt;
use garcon_base::errors::NamedError;
use garcon_contract::chat_command_contracts::PermissionDecisionPayload;
use garcon_interface::{
    errors::{
        AgentCallError, AgentDeliveryOutcome, AgentIntegrationError, AgentIntegrationErrorCode,
    },
    execution::{AgentExecutionAdmission, AgentRunningSession},
    execution_v5::{
        AgentExecutionContextV5, AgentExecutionHandle, AgentExecutionKind, AgentExecutionV5,
        AgentResumeRequestV5, AgentStartRequestV5,
    },
    host::AgentLogger,
    producer::{
        AgentEstablishedSession, AgentPermissionRespondRequest, AgentPermissionResponseCapability,
        AgentPermissions, AgentProducerBindRequest, AgentProducerControlEvent, AgentProducerEvent,
        AgentProducerNotification, AgentProducerNotificationEvent, AgentProducerPermission,
        AgentProducers, AgentProviderPermissionLifecycle, AgentRequestedPermission,
        AgentRunFailureDetail, AgentRunOutcome, AgentTerminalPermission,
    },
    resources::{
        AgentPermissionResponseKind, AgentProducerBinding, AgentProducerBindingKind,
        AgentResourceScope, ExecutorCallOptions, ExecutorResult, create_agent_resource_ref,
    },
    services::AgentSteerTargetRequest,
};
use garcon_js::json::Opaque;
use indexmap::IndexMap;
use serde_json::Value;
use tokio::task::spawn_local;
use tokio_util::sync::CancellationToken;

use super::{
    admission::check_options,
    resolve_endpoint::call_error,
    resource_table::{AgentResourceTable, DEFAULT_AGENT_RESOURCE_LIMIT, stale},
    runtime_events::{
        AgentRuntimeEvent, AgentRuntimeExecution, AgentRuntimeExecutionContext,
        AgentRuntimePublisher, AgentRuntimeResumeRequest, AgentRuntimeStartRequest,
        ProviderRunOutcome, RuntimePermissionResponse,
    },
};

type Listener = Rc<dyn Fn(AgentProducerNotification) -> ExecutorResult<()>>;

struct ProducerBinding {
    reference: AgentProducerBinding,
    chat_id: String,
    closed: Cell<bool>,
    detached: Cell<bool>,
    published_session: RefCell<Option<AgentEstablishedSession>>,
    operations: RefCell<Vec<Weak<Operation>>>,
}

pub(super) struct Operation {
    binding: Rc<ProducerBinding>,
    run_id: String,
    signal: CancellationToken,
    agent_session_id: RefCell<Option<String>>,
    aborted_session_on_close: RefCell<Option<String>>,
    ended: Cell<bool>,
    handle: AgentExecutionHandle,
}

impl Operation {
    pub(super) fn matches_target(&self, chat_id: &str, agent_session_id: &str) -> bool {
        self.binding.chat_id == chat_id
            && self.agent_session_id.borrow().as_deref() == Some(agent_session_id)
    }
}

impl Drop for Operation {
    fn drop(&mut self) {
        let current = self as *const Self;
        self.binding
            .operations
            .borrow_mut()
            .retain(|operation| !std::ptr::eq(operation.as_ptr(), current));
    }
}

struct PermissionResponse {
    operation: Rc<Operation>,
    capability: Rc<dyn RuntimePermissionResponse>,
}

struct State {
    runtime: Rc<dyn AgentRuntimeExecution>,
    logger: Rc<dyn AgentLogger>,
    new_id: Rc<dyn Fn() -> String>,
    bindings: AgentResourceTable<AgentProducerBindingKind, Rc<ProducerBinding>>,
    handles: AgentResourceTable<AgentExecutionKind, Rc<Operation>>,
    responses: AgentResourceTable<AgentPermissionResponseKind, PermissionResponse>,
    listeners: RefCell<BTreeMap<u64, Listener>>,
    next_listener: Cell<u64>,
    active: RefCell<IndexMap<String, Rc<Operation>>>,
}

pub struct AgentProducerAdapter {
    state: Rc<State>,
}

pub fn create_agent_producer_adapter(
    runtime: Rc<dyn AgentRuntimeExecution>,
    logger: Rc<dyn AgentLogger>,
    scope: AgentResourceScope,
    new_id: Rc<dyn Fn() -> String>,
) -> Rc<AgentProducerAdapter> {
    Rc::new(AgentProducerAdapter {
        state: Rc::new(State {
            runtime,
            logger,
            new_id,
            // Bindings follow transcript lifetime, not the concurrent-operation budget.
            bindings: AgentResourceTable::new(
                scope.clone(),
                AgentProducerBindingKind::Producer,
                usize::MAX,
            ),
            handles: AgentResourceTable::new(
                scope.clone(),
                AgentExecutionKind::Execution,
                DEFAULT_AGENT_RESOURCE_LIMIT,
            ),
            responses: AgentResourceTable::new(
                scope,
                AgentPermissionResponseKind::PermissionResponse,
                DEFAULT_AGENT_RESOURCE_LIMIT,
            ),
            listeners: RefCell::default(),
            next_listener: Cell::new(0),
            active: RefCell::default(),
        }),
    })
}

struct Admission {
    owner: Weak<State>,
    operation: Rc<Operation>,
}

#[async_trait(?Send)]
impl AgentExecutionAdmission for Admission {
    fn signal(&self) -> &CancellationToken {
        &self.operation.signal
    }

    async fn mark_started(&self) -> ExecutorResult<()> {
        let owner = self
            .owner
            .upgrade()
            .ok_or_else(|| stale("Execution has retired"))?;
        owner.emit(
            &self.operation.binding,
            control(AgentProducerControlEvent::Started {
                run_id: self.operation.run_id.clone(),
            }),
        )
    }
}

struct Prepared {
    operation: Rc<Operation>,
    context: AgentRuntimeExecutionContext,
    publish: AgentRuntimePublisher,
}

impl AgentProducerAdapter {
    pub(super) fn fixed_scope(&self) -> &AgentResourceScope {
        &self.state.bindings.scope
    }

    pub(super) fn expected_operation(
        &self,
        request: &AgentSteerTargetRequest,
    ) -> ExecutorResult<Option<Rc<Operation>>> {
        let binding = self.state.bindings.get(&request.producer_binding)?;
        let operation = self.state.active.borrow().get(&request.chat_id).cloned();
        Ok(operation.filter(|operation| {
            Rc::ptr_eq(&operation.binding, &binding)
                && operation.run_id == request.expected_run_id
                && !operation.ended.get()
        }))
    }

    pub(super) fn assert_current(&self, operation: &Rc<Operation>) -> ExecutorResult<()> {
        self.state.assert_current(operation)
    }

    pub async fn run_existing<R, F>(
        &self,
        request: AgentResumeRequestV5,
        operation: impl FnOnce(AgentRuntimeResumeRequest, AgentRuntimePublisher) -> F,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<(AgentExecutionHandle, R)>
    where
        F: Future<Output = ExecutorResult<R>>,
    {
        let (prepared, request) = self.prepare_resume(request, options.as_ref())?;
        match operation(request, prepared.publish).await {
            Ok(value) => Ok((prepared.operation.handle.clone(), value)),
            Err(error) => {
                self.state.retire(&prepared.operation);
                Err(error)
            }
        }
    }

    fn prepare_resume(
        &self,
        request: AgentResumeRequestV5,
        options: Option<&ExecutorCallOptions>,
    ) -> ExecutorResult<(PreparedResume, AgentRuntimeResumeRequest)> {
        let AgentResumeRequestV5 {
            context,
            agent_session_id,
            native_session,
            prompt,
            attachments,
        } = request;
        let Prepared {
            operation,
            context,
            publish,
        } = self.state.prepare(context, options)?;
        operation
            .agent_session_id
            .replace(Some(agent_session_id.clone()));
        Ok((
            PreparedResume { operation, publish },
            AgentRuntimeResumeRequest {
                context,
                agent_session_id,
                native_session,
                prompt,
                attachments,
            },
        ))
    }
}

struct PreparedResume {
    operation: Rc<Operation>,
    publish: AgentRuntimePublisher,
}

#[async_trait(?Send)]
impl AgentProducers for AgentProducerAdapter {
    fn scope(&self) -> ExecutorResult<AgentResourceScope> {
        Ok(self.fixed_scope().clone())
    }

    async fn bind(
        &self,
        request: AgentProducerBindRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        check_options(options.as_ref())?;
        if request.chat_id.is_empty() {
            return Err(type_error("Producer chat ID is required"));
        }
        self.state.bindings.bind(
            &request.binding,
            Rc::new(ProducerBinding {
                reference: request.binding.clone(),
                chat_id: request.chat_id,
                closed: Cell::new(false),
                detached: Cell::new(false),
                published_session: RefCell::default(),
                operations: RefCell::default(),
            }),
        )?;
        Ok(())
    }

    async fn close(
        &self,
        reference: AgentProducerBinding,
        _options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        let state = &self.state;
        let binding = state.bindings.get(&reference)?;
        binding.closed.set(true);
        state.bindings.delete(&reference)?;
        let operations = binding
            .operations
            .borrow()
            .iter()
            .filter_map(Weak::upgrade)
            .collect::<Vec<_>>();
        for operation in operations {
            operation.signal.cancel();
        }
        state
            .handles
            .remove_where(|operation| Rc::ptr_eq(&operation.binding, &binding));
        state
            .responses
            .remove_where(|entry| Rc::ptr_eq(&entry.operation.binding, &binding));
        let operation = state.active.borrow().get(&binding.chat_id).cloned();
        if let Some(operation) =
            operation.filter(|operation| Rc::ptr_eq(&operation.binding, &binding))
        {
            state.active.borrow_mut().shift_remove(&binding.chat_id);
            state.abort_closed_operation(&operation).await;
        }
        Ok(())
    }

    fn detach(&self, reference: AgentProducerBinding) {
        let state = &self.state;
        let Ok(binding) = state.bindings.get(&reference) else {
            return;
        };
        binding.detached.set(true);
        for response in state
            .responses
            .remove_where(|entry| Rc::ptr_eq(&entry.operation.binding, &binding))
        {
            state.deny_detached_permission(response.capability);
        }
        if !state
            .active
            .borrow()
            .get(&binding.chat_id)
            .is_some_and(|operation| Rc::ptr_eq(&operation.binding, &binding))
        {
            let _ = state.bindings.delete(&reference);
        }
    }

    fn subscribe(&self, listener: Listener) -> Box<dyn Fn()> {
        let mut listeners = self.state.listeners.borrow_mut();
        if !listeners
            .values()
            .any(|existing| Rc::ptr_eq(existing, &listener))
        {
            let id = self.state.next_listener.get();
            self.state.next_listener.set(id + 1);
            listeners.insert(id, listener.clone());
        }
        let owner = Rc::downgrade(&self.state);
        Box::new(move || {
            if let Some(owner) = owner.upgrade() {
                owner
                    .listeners
                    .borrow_mut()
                    .retain(|_, current| !Rc::ptr_eq(&listener, current));
            }
        })
    }
}

#[async_trait(?Send)]
impl AgentPermissions for AgentProducerAdapter {
    async fn respond(
        &self,
        request: AgentPermissionRespondRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        check_options(options.as_ref())?;
        let response = self.state.responses.take(&request.response)?;
        self.assert_current(&response.operation)?;
        response.capability.respond(request.decision).await
    }
}

#[async_trait(?Send)]
impl AgentExecutionV5 for AgentProducerAdapter {
    async fn start(
        &self,
        request: AgentStartRequestV5,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        let AgentStartRequestV5 {
            context,
            prompt,
            attachments,
            carried_context,
        } = request;
        let Prepared {
            operation,
            context,
            publish,
        } = self.state.prepare(context, options.as_ref())?;
        let result = self
            .state
            .runtime
            .start(
                AgentRuntimeStartRequest {
                    context,
                    prompt,
                    attachments,
                    carried_context,
                },
                publish.clone(),
            )
            .await;
        if let Ok(session) = &result {
            operation
                .agent_session_id
                .replace(Some(session.agent_session_id.clone()));
        }
        if operation.binding.closed.get() {
            self.state.abort_closed_operation(&operation).await;
            self.state.retire(&operation);
            return Err(binding_closed());
        }
        match result {
            Ok(session) => {
                if !same_session(
                    operation.binding.published_session.borrow().as_ref(),
                    &session,
                ) {
                    publish(AgentRuntimeEvent::Session { session });
                }
                Ok(operation.handle.clone())
            }
            Err(error) => {
                self.state.retire(&operation);
                Err(error)
            }
        }
    }

    async fn resume(
        &self,
        request: AgentResumeRequestV5,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<AgentExecutionHandle> {
        let (PreparedResume { operation, publish }, request) =
            self.prepare_resume(request, options.as_ref())?;
        let handle = operation.handle.clone();
        let runtime = self.state.runtime.clone();
        let mut work = Box::pin(async move {
            if let Err(error) = runtime.resume(request, publish.clone()).await
                && !operation.ended.get()
            {
                publish(AgentRuntimeEvent::RunEnded {
                    run_id: operation.run_id.clone(),
                    outcome: ProviderRunOutcome::Failed {
                        error: Some(failure_detail(error.as_ref())),
                    },
                    working_directory: None,
                });
            }
        });
        // Like the original async call, enter native admission before returning the handle.
        if futures::poll!(&mut work).is_pending() {
            spawn_local(work);
        }
        Ok(handle)
    }

    async fn abort(
        &self,
        reference: AgentExecutionHandle,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<bool> {
        check_options(options.as_ref())?;
        let operation = self.state.handles.get(&reference)?;
        self.assert_current(&operation)?;
        operation.signal.cancel();
        let session = operation.agent_session_id.borrow().clone();
        match session {
            Some(session) => self.state.runtime.abort(&session).await,
            None => Ok(false),
        }
    }

    async fn running_sessions(
        &self,
        _options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<Vec<AgentRunningSession>> {
        Ok(self.state.runtime.running_sessions())
    }
}

impl State {
    fn emit(
        &self,
        binding: &ProducerBinding,
        event: AgentProducerNotificationEvent,
    ) -> ExecutorResult<()> {
        if binding.detached.get() {
            return Ok(());
        }
        if binding.closed.get() {
            return Err(binding_closed());
        }
        let mut after = Unbounded;
        loop {
            // A Set iteration observes subscriptions added during delivery and skips removed ones.
            let next = self
                .listeners
                .borrow()
                .range((after, Unbounded))
                .next()
                .map(|(id, listener)| (*id, listener.clone()));
            let Some((id, listener)) = next else { break };
            after = Excluded(id);
            listener(AgentProducerNotification {
                binding: binding.reference.clone(),
                event: event.clone(),
            })?;
        }
        Ok(())
    }

    fn prepare(
        self: &Rc<Self>,
        context: AgentExecutionContextV5,
        options: Option<&ExecutorCallOptions>,
    ) -> ExecutorResult<Prepared> {
        check_options(options)?;
        let binding = self.bindings.get(&context.producer_binding)?;
        if binding.detached.get() {
            return Err(stale("Producer binding has detached").into());
        }
        if binding.chat_id != context.chat_id {
            return Err(stale("Producer chat mismatch").into());
        }
        let operation = Rc::new(Operation {
            handle: create_agent_resource_ref(
                self.handles.scope.clone(),
                AgentExecutionKind::Execution,
                self.new_id.as_ref(),
            ),
            run_id: context.run_id.clone(),
            signal: options
                .and_then(|options| options.signal.as_ref())
                .map_or_else(CancellationToken::new, CancellationToken::child_token),
            binding,
            agent_session_id: RefCell::default(),
            aborted_session_on_close: RefCell::default(),
            ended: Cell::new(false),
        });
        operation
            .binding
            .operations
            .borrow_mut()
            .push(Rc::downgrade(&operation));
        let prior = self.active.borrow().get(&context.chat_id).cloned();
        if let Some(prior) = prior {
            if !Rc::ptr_eq(&prior.binding, &operation.binding) {
                return Err(AgentCallError::with_code(
                    AgentDeliveryOutcome::Rejected,
                    "An earlier turn is still running on the executor. Wait for it to finish or restart the worker.",
                    AgentIntegrationErrorCode::SESSION_BUSY,
                ).into());
            }
            self.retire(&prior);
        }
        self.handles
            .remove_where(|entry| entry.binding.chat_id == operation.binding.chat_id);
        self.active
            .borrow_mut()
            .insert(context.chat_id.clone(), operation.clone());
        self.handles.bind(&operation.handle, operation.clone())?;
        let publish = self.publisher(operation.clone());
        let admission = Rc::new(Admission {
            owner: Rc::downgrade(self),
            operation: operation.clone(),
        });
        Ok(Prepared {
            operation,
            context: AgentRuntimeExecutionContext::new(context, admission),
            publish,
        })
    }

    fn is_active(&self, operation: &Rc<Operation>) -> bool {
        self.active
            .borrow()
            .get(&operation.binding.chat_id)
            .is_some_and(|current| Rc::ptr_eq(current, operation))
    }

    fn assert_current(&self, operation: &Rc<Operation>) -> ExecutorResult<()> {
        if operation.ended.get()
            || operation.binding.closed.get()
            || operation.binding.detached.get()
            || !self.is_active(operation)
        {
            return Err(stale("Execution has retired").into());
        }
        Ok(())
    }

    fn retire(&self, operation: &Rc<Operation>) {
        operation.ended.set(true);
        if self.is_active(operation) {
            self.active
                .borrow_mut()
                .shift_remove(&operation.binding.chat_id);
        }
        let _ = self.handles.delete(&operation.handle);
        self.responses
            .remove_where(|entry| Rc::ptr_eq(&entry.operation, operation));
        if operation.binding.detached.get() {
            let _ = self.bindings.delete(&operation.binding.reference);
        }
    }

    fn deny_detached_permission(&self, capability: Rc<dyn RuntimePermissionResponse>) {
        let logger = self.logger.clone();
        spawn_local(async move {
            let decision = PermissionDecisionPayload {
                allow: false,
                always_allow: None,
                response: None,
            };
            if let Err(error) = capability.respond(decision).await {
                warn(
                    &*logger,
                    "Failed to deny permission after executor disconnect",
                    [("reason", error.to_string())],
                );
            }
        });
    }

    fn claim_closed_abort(&self, operation: &Rc<Operation>) -> Option<String> {
        let session = operation.agent_session_id.borrow().clone()?;
        if operation.ended.get()
            || operation.aborted_session_on_close.borrow().as_ref() == Some(&session)
        {
            return None;
        }
        // A late close must not abort a replacement that owns the same native session.
        if self
            .active
            .borrow()
            .get(&operation.binding.chat_id)
            .is_some_and(|replacement| {
                !Rc::ptr_eq(replacement, operation)
                    && replacement.agent_session_id.borrow().as_ref() == Some(&session)
            })
        {
            return None;
        }
        operation
            .aborted_session_on_close
            .replace(Some(session.clone()));
        Some(session)
    }

    async fn abort_closed_operation(&self, operation: &Rc<Operation>) {
        if let Some(session) = self.claim_closed_abort(operation) {
            self.abort_closed_session(&operation.binding.chat_id, &session)
                .await;
        }
    }

    async fn abort_closed_session(&self, chat_id: &str, session: &str) {
        if let Err(error) = self.runtime.abort(session).await {
            warn(
                &*self.logger,
                "Failed to abort execution for a closed producer binding",
                [
                    ("chatId", chat_id.to_owned()),
                    ("reason", error.to_string()),
                ],
            );
        }
    }

    fn publisher(self: &Rc<Self>, operation: Rc<Operation>) -> AgentRuntimePublisher {
        let owner = Rc::downgrade(self);
        Rc::new(move |event| {
            if let Some(owner) = owner.upgrade() {
                owner.publish(&operation, event);
            }
        })
    }

    fn publish(self: &Rc<Self>, operation: &Rc<Operation>, event: AgentRuntimeEvent) {
        let event_type = event_type(&event);
        let chat_id = &operation.binding.chat_id;
        if matches!(&event, AgentRuntimeEvent::Permission { run_id, .. } if run_id.is_empty()) {
            warn(
                &*self.logger,
                "Dropped an unnamed provider permission event",
                [
                    ("chatId", chat_id.clone()),
                    ("eventType", event_type.to_owned()),
                    ("reason", "missing operation run ID".to_owned()),
                ],
            );
            return;
        }
        let ends_operation = matches!(&event, AgentRuntimeEvent::RunEnded { run_id, .. } if &operation.run_id == run_id);
        if let Err(error) = self.publish_event(operation, event) {
            warn(
                &*self.logger,
                "Dropped a provider event for an unavailable transcript sink",
                [
                    ("chatId", chat_id.clone()),
                    ("eventType", event_type.to_owned()),
                    ("reason", error.to_string()),
                ],
            );
        }
        if ends_operation {
            self.retire(operation);
        }
    }

    fn publish_event(
        self: &Rc<Self>,
        operation: &Rc<Operation>,
        event: AgentRuntimeEvent,
    ) -> ExecutorResult<()> {
        let binding = &operation.binding;
        let event = match event {
            AgentRuntimeEvent::Rows { rows } => AgentProducerEvent::Rows { rows },
            AgentRuntimeEvent::Notice {
                run_id,
                content,
                title,
            } => AgentProducerEvent::Notice {
                run_id,
                content,
                title,
            },
            AgentRuntimeEvent::Session { session } => {
                operation
                    .agent_session_id
                    .replace(Some(session.agent_session_id.clone()));
                if binding.closed.get()
                    && let Some(session) = self.claim_closed_abort(operation)
                {
                    let owner = self.clone();
                    let chat_id = binding.chat_id.clone();
                    // Claim and enter abort before a replacement can take the session.
                    let mut abort = Box::pin(async move {
                        owner.abort_closed_session(&chat_id, &session).await;
                    });
                    if abort.as_mut().now_or_never().is_none() {
                        spawn_local(abort);
                    }
                }
                self.emit(
                    binding,
                    provider(AgentProducerEvent::Session {
                        session: session.clone(),
                    }),
                )?;
                binding.published_session.replace(Some(session));
                return Ok(());
            }
            AgentRuntimeEvent::Permission {
                run_id,
                lifecycle,
                decision,
            } => {
                let permission = match lifecycle {
                    AgentProviderPermissionLifecycle::Requested(lifecycle) => {
                        let AgentRequestedPermission::Requested {
                            permission_occurrence_id,
                            ..
                        } = &lifecycle;
                        let capability = decision
                            .filter(|decision| {
                                decision.permission_occurrence_id() == permission_occurrence_id
                            })
                            .ok_or_else(|| {
                                type_error("Permission response does not match its occurrence")
                            })?;
                        if binding.detached.get() {
                            self.deny_detached_permission(capability);
                            return Ok(());
                        }
                        let response = if !operation.ended.get() && self.is_active(operation) {
                            self.responses.add(
                                PermissionResponse {
                                    operation: operation.clone(),
                                    capability,
                                },
                                self.new_id.as_ref(),
                            )?
                        } else {
                            create_agent_resource_ref(
                                self.responses.scope.clone(),
                                AgentPermissionResponseKind::PermissionResponse,
                                self.new_id.as_ref(),
                            )
                        };
                        let decision = AgentPermissionResponseCapability {
                            permission_occurrence_id: permission_occurrence_id.clone(),
                            response,
                        };
                        AgentProducerPermission::Requested {
                            lifecycle,
                            decision,
                        }
                    }
                    AgentProviderPermissionLifecycle::Terminal(lifecycle) => {
                        let occurrence = match &lifecycle {
                            AgentTerminalPermission::Cancelled {
                                permission_occurrence_id,
                                ..
                            }
                            | AgentTerminalPermission::Expired {
                                permission_occurrence_id,
                            } => permission_occurrence_id,
                        };
                        self.responses.remove_where(|entry| {
                            Rc::ptr_eq(&entry.operation, operation)
                                && entry.capability.permission_occurrence_id() == occurrence
                        });
                        AgentProducerPermission::Terminal { lifecycle }
                    }
                };
                AgentProducerEvent::Permission { run_id, permission }
            }
            AgentRuntimeEvent::RunEnded {
                run_id,
                outcome,
                working_directory,
            } => {
                let outcome = match outcome {
                    ProviderRunOutcome::Finished { final_response } => {
                        AgentRunOutcome::Finished { final_response }
                    }
                    ProviderRunOutcome::Failed { error } => AgentRunOutcome::Failed { error },
                };
                AgentProducerEvent::RunEnded {
                    run_id,
                    outcome,
                    working_directory,
                }
            }
            AgentRuntimeEvent::Steerable => {
                if operation.ended.get() || !self.is_active(operation) {
                    return Ok(());
                }
                return self.emit(
                    binding,
                    control(AgentProducerControlEvent::Steerable {
                        run_id: operation.run_id.clone(),
                    }),
                );
            }
        };
        self.emit(binding, provider(event))
    }
}

fn event_type(event: &AgentRuntimeEvent) -> &'static str {
    match event {
        AgentRuntimeEvent::Rows { .. } => "rows",
        AgentRuntimeEvent::Notice { .. } => "notice",
        AgentRuntimeEvent::Session { .. } => "session",
        AgentRuntimeEvent::Permission { .. } => "permission",
        AgentRuntimeEvent::RunEnded { .. } => "run-ended",
        AgentRuntimeEvent::Steerable => "steerable",
    }
}

fn provider(event: AgentProducerEvent) -> AgentProducerNotificationEvent {
    AgentProducerNotificationEvent::Provider(event)
}

fn control(event: AgentProducerControlEvent) -> AgentProducerNotificationEvent {
    AgentProducerNotificationEvent::Control(event)
}

fn warn<const N: usize>(logger: &dyn AgentLogger, message: &str, fields: [(&str, String); N]) {
    let fields = fields
        .into_iter()
        .map(|(key, value)| (key.to_owned(), Opaque::from_value(Value::String(value))))
        .collect();
    logger.warn(message, Some(&fields));
}

fn type_error(message: &str) -> Box<dyn Error> {
    NamedError {
        name: "TypeError".to_owned(),
        message: message.to_owned(),
        code: None,
    }
    .into()
}

fn binding_closed() -> Box<dyn Error> {
    stale("Producer binding has closed").into()
}

fn same_session(left: Option<&AgentEstablishedSession>, right: &AgentEstablishedSession) -> bool {
    let Some(left) = left else { return false };
    left.agent_session_id == right.agent_session_id
        && same_json(&left.native_session, &right.native_session)
        && same_json(&left.native_seed_receipt, &right.native_seed_receipt)
}

fn same_json<T: serde::Serialize>(left: &T, right: &T) -> bool {
    serde_json::to_vec(left)
        .ok()
        .zip(serde_json::to_vec(right).ok())
        .is_some_and(|(left, right)| left == right)
}

pub fn failure_detail(error: &(dyn Error + 'static)) -> AgentRunFailureDetail {
    let integration = call_error(error)
        .map(|error| &**error)
        .or_else(|| error.downcast_ref::<AgentIntegrationError>());
    let (code, message) = integration.map_or_else(
        || ("PROVIDER_FAILURE", error.to_string()),
        |error| (error.code.as_str(), error.message.clone()),
    );
    AgentRunFailureDetail {
        code: code.to_owned(),
        message: (!message.is_empty()).then_some(message),
    }
}

#[cfg(test)]
mod tests;
