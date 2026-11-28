//! Routes executor producer notifications to the transcript lease captured at bind time.
//! The ledger owns the lease; reconnect does not reopen it or retarget it to another worker.

use std::{
    cell::RefCell,
    collections::{HashMap, hash_map::Entry},
    error::Error,
    rc::{Rc, Weak},
    task::{Context, Poll, Waker},
    time::Duration,
};

use futures::future::pending;
use garcon_base::{
    executor_disconnect::{ExecutorSessionLostError, reconnect_timed_out},
    keyed_lock::LockAborted,
};
use garcon_interface::{
    errors::{AgentCallError, AgentIntegrationError},
    producer::{
        AgentLaunchOutcome, AgentProducerBindRequest, AgentProducerControlEvent,
        AgentProducerEvent, AgentProducerNotification, AgentProducerNotificationEvent,
        AgentProducerSink, AgentProducers, AgentRunFailureDetail,
    },
    resources::{
        AgentProducerBinding, AgentProducerBindingKind, AgentResourceScope, ExecutorCallOptions,
        ExecutorResult, create_agent_resource_ref,
    },
};
use garcon_js::performance_now_ms;
use tokio::sync::watch;

use crate::{
    session_loss_retry::{SessionLossRetrySignal, retry_after_session_loss},
    turn_terminal_settlement::ProducerLeaseState,
    types::LocalExecutionFuture,
};

pub trait TranscriptProducerLease: ProducerLeaseState + AgentProducerSink {
    fn on_closed(&self, listener: Box<dyn FnOnce()>);
    fn close(&self);
}

/// Scope is read on every registration attempt and can fail on an offline executor.
pub struct ProducerBindingTarget {
    pub agent_id: String,
    pub producers: Rc<dyn AgentProducers>,
    pub read_scope: Rc<dyn Fn() -> ExecutorResult<AgentResourceScope>>,
}

#[derive(Default)]
pub struct ProducerBindingOptions {
    pub call: ExecutorCallOptions,
    pub abort_reason: Option<Rc<dyn Fn() -> Box<dyn Error>>>,
}

impl ProducerBindingOptions {
    fn abort_reason(&self) -> Box<dyn Error> {
        self.abort_reason.as_ref().map_or_else(
            || Box::new(LockAborted) as Box<dyn Error>,
            |reason| reason(),
        )
    }
}

pub struct LaunchSettledEvent {
    pub run_id: String,
    pub outcome: AgentLaunchOutcome,
}

pub trait ProducerBindingEvents {
    fn on_error(&self, error: &(dyn Error + 'static));
    fn on_publication_failed(
        &self,
        chat_id: &str,
        lease: &Rc<dyn TranscriptProducerLease>,
        error: &AgentRunFailureDetail,
    ) -> ExecutorResult<()>;
    fn on_publication_gap(
        &self,
        chat_id: &str,
        lease: &Rc<dyn TranscriptProducerLease>,
    ) -> ExecutorResult<()>;
    fn on_launch_settled(
        &self,
        chat_id: &str,
        lease: &Rc<dyn TranscriptProducerLease>,
        agent_id: &str,
        event: LaunchSettledEvent,
    ) -> ExecutorResult<()>;
    fn on_steerable(
        &self,
        chat_id: &str,
        lease: &Rc<dyn TranscriptProducerLease>,
        run_id: &str,
    ) -> ExecutorResult<()>;
}

#[derive(Debug, thiserror::Error)]
#[error("Producer closed during binding")]
struct ProducerClosedDuringBinding;

#[derive(Debug, Clone)]
struct SharedRegistrationError(Rc<Box<dyn Error>>);

impl std::fmt::Display for SharedRegistrationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.0, formatter)
    }
}

impl Error for SharedRegistrationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.0.as_ref().as_ref())
    }
}

impl SharedRegistrationError {
    fn into_boxed(self) -> Box<dyn Error> {
        // Joiners must see the same concrete executor errors as the first caller.
        let error = self.0.as_ref().as_ref();
        if let Some(error) = error.downcast_ref::<ExecutorSessionLostError>() {
            Box::new(error.clone())
        } else if let Some(error) = error.downcast_ref::<AgentCallError>() {
            Box::new(error.clone())
        } else if let Some(error) = error.downcast_ref::<AgentIntegrationError>() {
            Box::new(error.clone())
        } else {
            Rc::try_unwrap(self.0).unwrap_or_else(|error| Box::new(Self(error)))
        }
    }
}

type Registration = watch::Receiver<Option<Result<AgentProducerBinding, SharedRegistrationError>>>;

#[derive(Clone)]
struct Route {
    chat_id: String,
    lease: Rc<dyn TranscriptProducerLease>,
    binding: AgentProducerBinding,
}

enum RunProgress {
    Waiting(Box<dyn FnOnce() -> Option<LocalExecutionFuture<'static>>>),
    Started,
}

pub struct ProducerBindings {
    leases: RefCell<HashMap<*const (), Registration>>,
    routes: RefCell<HashMap<String, Route>>,
    subscriptions: RefCell<Vec<Weak<dyn AgentProducers>>>,
    progress: RefCell<HashMap<String, RunProgress>>,
    events: Rc<dyn ProducerBindingEvents>,
    new_id: Box<dyn Fn() -> String>,
}

impl ProducerBindings {
    pub fn new(
        events: Rc<dyn ProducerBindingEvents>,
        new_id: impl Fn() -> String + 'static,
    ) -> Self {
        Self {
            leases: RefCell::default(),
            routes: RefCell::default(),
            subscriptions: RefCell::default(),
            progress: RefCell::default(),
            events,
            new_id: Box::new(new_id),
        }
    }

    pub async fn bind(
        self: &Rc<Self>,
        integration: ProducerBindingTarget,
        chat_id: &str,
        lease: Rc<dyn TranscriptProducerLease>,
        options: ProducerBindingOptions,
    ) -> ExecutorResult<AgentProducerBinding> {
        if lease.closed() {
            return Err(ProducerClosedDuringBinding.into());
        }
        let key = Rc::as_ptr(&lease).cast::<()>();
        let existing = self.leases.borrow().get(&key).cloned();
        let binding = if let Some(existing) = existing {
            join_within(existing, &options).await?
        } else {
            self.subscribe(&integration);
            let registration =
                self.start_registration(integration, chat_id.into(), lease.clone(), options);
            wait_for_registration(registration).await?
        };
        if lease.closed() {
            return Err(ProducerClosedDuringBinding.into());
        }
        Ok(binding)
    }

    pub fn on_started(
        &self,
        run_id: String,
        callback: impl FnOnce() -> Option<LocalExecutionFuture<'static>> + 'static,
    ) {
        self.progress
            .borrow_mut()
            .insert(run_id, RunProgress::Waiting(Box::new(callback)));
    }

    pub fn has_started(&self, run_id: &str) -> bool {
        matches!(
            self.progress.borrow().get(run_id),
            Some(RunProgress::Started)
        )
    }

    pub fn forget_run(&self, run_id: &str) {
        self.progress.borrow_mut().remove(run_id);
    }

    fn start_registration(
        self: &Rc<Self>,
        integration: ProducerBindingTarget,
        chat_id: String,
        lease: Rc<dyn TranscriptProducerLease>,
        options: ProducerBindingOptions,
    ) -> Registration {
        let key = Rc::as_ptr(&lease).cast::<()>();
        let (resolved, registration) = watch::channel(None);
        self.leases.borrow_mut().insert(key, registration.clone());
        let owner = Rc::downgrade(self);
        let closing = registration.clone();
        let producers = integration.producers.clone();
        let events = self.events.clone();
        lease.on_closed(Box::new(move || {
            if let Some(owner) = owner.upgrade() {
                owner.leases.borrow_mut().remove(&key);
            }
            tokio::task::spawn_local(async move {
                let result = match wait_for_registration(closing).await {
                    Ok(binding) => {
                        if let Some(owner) = owner.upgrade() {
                            owner.routes.borrow_mut().remove(&binding.id);
                        }
                        producers.close(binding, None).await
                    }
                    Err(error) => Err(error),
                };
                if let Err(error) = result {
                    events.on_error(error.as_ref());
                }
            });
        }));
        let owner = self.clone();
        let mut work = Box::pin(async move {
            let reason = || options.abort_reason();
            let signal = options
                .call
                .signal
                .as_ref()
                .map(|token| SessionLossRetrySignal {
                    token,
                    reason: &reason,
                });
            retry_after_session_loss(
                || owner.register(&integration, &chat_id, &lease, &options.call),
                signal,
            )
            .await
        });
        // Registration begins inline and survives every requester dropping its wait.
        let first = work.as_mut().poll(&mut Context::from_waker(Waker::noop()));
        let owner = self.clone();
        let current = registration.clone();
        tokio::task::spawn_local(async move {
            let result = match first {
                Poll::Ready(result) => result,
                Poll::Pending => work.await,
            };
            if result.is_err() {
                let mut leases = owner.leases.borrow_mut();
                if let Entry::Occupied(entry) = leases.entry(key)
                    && entry.get().same_channel(&current)
                {
                    entry.remove();
                }
            }
            resolved.send_replace(Some(
                result.map_err(|error| SharedRegistrationError(Rc::new(error))),
            ));
        });
        registration
    }

    async fn register(
        &self,
        integration: &ProducerBindingTarget,
        chat_id: &str,
        lease: &Rc<dyn TranscriptProducerLease>,
        options: &ExecutorCallOptions,
    ) -> ExecutorResult<AgentProducerBinding> {
        let binding = create_agent_resource_ref(
            (integration.read_scope)()?,
            AgentProducerBindingKind::Producer,
            self.new_id.as_ref(),
        );
        self.routes.borrow_mut().insert(
            binding.id.clone(),
            Route {
                chat_id: chat_id.into(),
                lease: lease.clone(),
                binding: binding.clone(),
            },
        );
        if let Err(error) = integration
            .producers
            .bind(
                AgentProducerBindRequest {
                    binding: binding.clone(),
                    chat_id: chat_id.into(),
                },
                Some(options.clone()),
            )
            .await
        {
            self.routes.borrow_mut().remove(&binding.id);
            return Err(error);
        }
        Ok(binding)
    }

    fn subscribe(self: &Rc<Self>, integration: &ProducerBindingTarget) {
        let weak_producers = Rc::downgrade(&integration.producers);
        {
            let mut subscriptions = self.subscriptions.borrow_mut();
            subscriptions.retain(|producers| producers.strong_count() > 0);
            if subscriptions
                .iter()
                .any(|producers| producers.ptr_eq(&weak_producers))
            {
                return;
            }
            subscriptions.push(weak_producers);
        }
        let owner = Rc::downgrade(self);
        let agent_id = integration.agent_id.clone();
        let _unsubscribe = integration
            .producers
            .subscribe(Rc::new(move |notification| {
                if let Some(owner) = owner.upgrade() {
                    owner.on_notification(&agent_id, notification);
                }
                Ok(())
            }));
    }

    fn on_notification(&self, agent_id: &str, notification: AgentProducerNotification) {
        let binding = notification.binding;
        let route = self.routes.borrow().get(&binding.id).cloned();
        let Some(Route {
            chat_id,
            lease,
            binding: reference,
        }) = route
        else {
            return;
        };
        if lease.closed()
            || reference != binding
            || [
                &binding.id,
                &binding.scope.executor_id,
                &binding.scope.instance_id,
                &binding.scope.integration_id,
            ]
            .into_iter()
            .any(String::is_empty)
        {
            return;
        }
        use AgentProducerNotificationEvent::{Control, Provider};
        let result = match notification.event {
            Control(AgentProducerControlEvent::PublicationFailed { error }) => {
                if let Err(error) = self.events.on_publication_failed(&chat_id, &lease, &error) {
                    self.events.on_error(error.as_ref());
                }
                lease.close();
                return;
            }
            Control(AgentProducerControlEvent::PublicationGap) => {
                self.events.on_publication_gap(&chat_id, &lease)
            }
            Control(AgentProducerControlEvent::LaunchSettled { run_id, outcome }) => {
                self.events.on_launch_settled(
                    &chat_id,
                    &lease,
                    agent_id,
                    LaunchSettledEvent { run_id, outcome },
                )
            }
            Control(AgentProducerControlEvent::Steerable { run_id }) => {
                self.events.on_steerable(&chat_id, &lease, &run_id)
            }
            Control(AgentProducerControlEvent::Started { run_id }) => {
                self.started(run_id);
                return;
            }
            Provider(event) => {
                if let AgentProducerEvent::RunEnded { run_id, .. } = &event {
                    self.forget_run(run_id);
                }
                lease.publish(event)
            }
        };
        if let Err(error) = result {
            self.events.on_error(error.as_ref());
        }
    }

    fn started(&self, run_id: String) {
        let callback = match self.progress.borrow_mut().entry(run_id) {
            Entry::Occupied(mut entry) => match entry.insert(RunProgress::Started) {
                RunProgress::Waiting(callback) => callback,
                RunProgress::Started => return,
            },
            Entry::Vacant(_) => return,
        };
        if let Some(mut work) = callback() {
            let first = work.as_mut().poll(&mut Context::from_waker(Waker::noop()));
            let events = self.events.clone();
            tokio::task::spawn_local(async move {
                let result = match first {
                    Poll::Ready(result) => result,
                    Poll::Pending => work.await,
                };
                if let Err(error) = result {
                    events.on_error(error.as_ref());
                }
            });
        }
    }
}

async fn wait_for_registration(
    mut registration: Registration,
) -> ExecutorResult<AgentProducerBinding> {
    let value = registration.wait_for(Option::is_some).await?;
    // INFALLIBLE: wait_for returns only after the result has been published.
    value
        .as_ref()
        .expect("registration resolved")
        .clone()
        .map_err(SharedRegistrationError::into_boxed)
}

async fn join_within(
    registration: Registration,
    options: &ProducerBindingOptions,
) -> ExecutorResult<AgentProducerBinding> {
    let duration = options.call.dispatch_deadline.map(|deadline| {
        Duration::try_from_secs_f64(((deadline - performance_now_ms()) / 1000.0).max(0.0))
            .unwrap_or_default()
    });
    let expiry = async {
        match duration {
            Some(duration) => tokio::time::sleep(duration).await,
            None => pending().await,
        }
    };
    let cancelled = async {
        match &options.call.signal {
            Some(signal) => signal.cancelled().await,
            None => pending().await,
        }
    };
    tokio::select! {
        biased;
        () = cancelled => Err(options.abort_reason()),
        result = wait_for_registration(registration) => result,
        () = expiry => Err(reconnect_timed_out().into()),
    }
}
