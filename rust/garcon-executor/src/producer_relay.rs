//! Ports `server/remote/server/producer-relay.ts`.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::error::Error;
use std::future::Future;
use std::rc::Rc;
use std::time::Duration;

use garcon_base::executor_disconnect::{
    EXECUTOR_DISCONNECTED_BEFORE_START, ExecutorSessionLostError,
};
use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome, AgentIntegrationError};
use garcon_interface::execution_v5::{AgentExecutionHandle, AgentExecutionV5};
use garcon_interface::integration::AgentIntegration;
use garcon_interface::producer::{
    AgentLaunchOutcome, AgentProducerControlEvent, AgentProducerEvent, AgentProducerNotification,
    AgentProducerNotificationEvent, AgentProducers, AgentRunFailureDetail,
};
use garcon_interface::resources::{AgentProducerBinding, ExecutorResult};
use garcon_link::failure_reason::{MALFORMED_DATA, is_parse_error};
use garcon_link::limits::EXECUTOR_RECONNECT_GRACE_MS;
use garcon_link::rpc::ObserveUndeliveredReply;
use garcon_link::rpc_protocol::{
    AgentProducerFrame, ProducerAcknowledgement, ProducerResumeLaunch, ProducerResumeState,
};
use garcon_link::session_socket::SESSION_MESSAGE_BYTES;
use indexmap::IndexMap;
use tokio::task::{JoinHandle, spawn_local};
use tokio::time::{Instant, sleep, sleep_until};
use tokio_util::sync::CancellationToken;

const SUPERSEDED_GRACE: Duration = Duration::from_secs(5 * 60);
const RETAINED_BYTES: usize = 32 * 1024 * 1024;
const PUMP_RETRY: Duration = Duration::from_millis(10);
const RECEIVED_LAUNCHES: usize = 8;

pub(crate) type ProducerRelaySession = Rc<dyn Fn(String) -> bool>;

#[derive(Clone)]
pub(crate) struct RelayIntegration {
    producers: Rc<dyn AgentProducers>,
    execution: Rc<dyn AgentExecutionV5>,
}

impl From<&AgentIntegration> for RelayIntegration {
    fn from(integration: &AgentIntegration) -> Self {
        Self {
            producers: integration.producers.clone(),
            execution: integration.execution.clone(),
        }
    }
}

impl RelayIntegration {
    fn same(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.producers, &other.producers)
            && Rc::ptr_eq(&self.execution, &other.execution)
    }
}

pub(crate) struct ProducerRelayOptions {
    grace: Duration,
    superseded_grace: Duration,
    retained_bytes: usize,
}

impl Default for ProducerRelayOptions {
    fn default() -> Self {
        Self {
            grace: Duration::from_millis(EXECUTOR_RECONNECT_GRACE_MS),
            superseded_grace: SUPERSEDED_GRACE,
            retained_bytes: RETAINED_BYTES,
        }
    }
}

#[derive(Default)]
struct State {
    bindings: IndexMap<String, Binding>,
    subscriptions: Vec<(RelayIntegration, Box<dyn Fn()>)>,
    retained_bytes: usize,
    published: u64,
    generation: u64,
}

pub(crate) struct ProducerRelay {
    state: RefCell<State>,
    options: ProducerRelayOptions,
    pumping: Cell<bool>,
    retry: RefCell<Option<Timer>>,
}

struct Binding {
    integration: RelayIntegration,
    reference: AgentProducerBinding,
    generation: u64,
    seq: u64,
    retained: VecDeque<Rc<RetainedFrame>>,
    retained_bytes: usize,
    sent: usize,
    session: Option<ProducerRelaySession>,
    grace: Option<Grace>,
    launch: Option<Rc<Launch>>,
    received: VecDeque<String>,
}

struct RetainedFrame {
    seq: u64,
    order: u64,
    payload: String,
    droppable: Cell<bool>,
}

struct Grace {
    deadline: Instant,
    _timer: Timer,
}

struct Timer(JoinHandle<()>);

impl Drop for Timer {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct Launch {
    run_id: String,
    handle: RefCell<Option<AgentExecutionHandle>>,
    signal: CancellationToken,
    cancelled: Cell<bool>,
}

impl Launch {
    fn cancel(&self) {
        self.cancelled.set(true);
        self.signal.cancel();
    }
}

pub(crate) struct LaunchRequest<'a> {
    pub(crate) producer_binding: &'a AgentProducerBinding,
    pub(crate) run_id: &'a str,
}

struct Unsent {
    id: String,
    generation: u64,
    session: ProducerRelaySession,
    frame: Rc<RetainedFrame>,
}

impl ProducerRelay {
    pub(crate) fn new(options: ProducerRelayOptions) -> Rc<Self> {
        Rc::new(Self {
            state: RefCell::default(),
            options,
            pumping: Cell::new(false),
            retry: RefCell::default(),
        })
    }

    pub(crate) fn track(self: &Rc<Self>, integration: &RelayIntegration) {
        if self
            .state
            .borrow()
            .subscriptions
            .iter()
            .any(|(tracked, _)| tracked.same(integration))
        {
            return;
        }
        let relay = Rc::downgrade(self);
        let producers = Rc::downgrade(&integration.producers);
        let execution = Rc::downgrade(&integration.execution);
        let off = integration
            .producers
            .subscribe(Rc::new(move |notification| {
                if let Some(((relay, producers), execution)) = relay
                    .upgrade()
                    .zip(producers.upgrade())
                    .zip(execution.upgrade())
                {
                    relay.publish(
                        &RelayIntegration {
                            producers,
                            execution,
                        },
                        notification,
                    );
                }
            }));
        self.state
            .borrow_mut()
            .subscriptions
            .push((integration.clone(), off));
    }

    pub(crate) fn bind(
        &self,
        session: &ProducerRelaySession,
        integration: &RelayIntegration,
        reference: AgentProducerBinding,
    ) {
        let mut state = self.state.borrow_mut();
        state.forget(&reference.id);
        state.generation += 1;
        let generation = state.generation;
        state.bindings.insert(
            reference.id.clone(),
            Binding {
                integration: integration.clone(),
                reference,
                generation,
                seq: 0,
                retained: VecDeque::new(),
                retained_bytes: 0,
                sent: 0,
                session: Some(session.clone()),
                grace: None,
                launch: None,
                received: VecDeque::new(),
            },
        );
    }

    pub(crate) fn owns(
        &self,
        session: &ProducerRelaySession,
        integration: &RelayIntegration,
        reference: &AgentProducerBinding,
    ) -> bool {
        self.state
            .borrow()
            .bindings
            .get(&reference.id)
            .is_some_and(|binding| {
                binding.integration.same(integration) && binding.is_session(session)
            })
    }

    pub(crate) fn suspended(
        &self,
        integration: &RelayIntegration,
        reference: &AgentProducerBinding,
    ) -> bool {
        self.state
            .borrow()
            .bindings
            .get(&reference.id)
            .is_some_and(|binding| {
                binding.integration.same(integration) && binding.session.is_none()
            })
    }

    pub(crate) fn close(&self, reference: &AgentProducerBinding) {
        self.state.borrow_mut().forget(&reference.id);
    }

    pub(crate) fn suspend(self: &Rc<Self>, session: &ProducerRelaySession) {
        for binding in self.state.borrow_mut().bindings.values_mut() {
            if binding.is_session(session) {
                binding.session = None;
                binding.sent = 0;
                self.expire_within(binding, self.options.grace);
            }
        }
    }

    pub(crate) fn shorten_suspended_grace(self: &Rc<Self>) {
        for binding in self.state.borrow_mut().bindings.values_mut() {
            if binding.session.is_none() {
                self.expire_within(binding, self.options.superseded_grace);
            }
        }
    }

    pub(crate) fn resume(
        self: &Rc<Self>,
        session: &ProducerRelaySession,
        integration: &RelayIntegration,
        requests: impl IntoIterator<Item = (String, u64)>,
    ) -> Vec<ProducerResumeState<AgentExecutionHandle>> {
        let resumed = {
            let mut state = self.state.borrow_mut();
            let State {
                bindings,
                retained_bytes,
                ..
            } = &mut *state;
            requests
                .into_iter()
                .filter_map(|(id, acknowledged)| {
                    let binding = bindings
                        .get_mut(&id)
                        .filter(|binding| binding.integration.same(integration))?;
                    binding.grace.take();
                    binding.session = Some(session.clone());
                    *retained_bytes -= binding.release(acknowledged);
                    binding.sent = 0;
                    // The controller waits for this tail to settle lost launches.
                    let replay_through_seq = binding.retained.back().map_or(acknowledged, |tail| {
                        tail.droppable.set(false);
                        tail.seq
                    });
                    Some(ProducerResumeState {
                        binding_id: id,
                        replay_through_seq,
                        launch: binding.launch.as_ref().map(|launch| ProducerResumeLaunch {
                            run_id: launch.run_id.clone(),
                            handle: launch.handle.borrow().clone(),
                        }),
                        received_run_ids: binding.received.iter().cloned().collect(),
                    })
                })
                .collect()
        };
        self.pump();
        resumed
    }

    pub(crate) fn acknowledge(
        &self,
        session: &ProducerRelaySession,
        acknowledgements: Vec<ProducerAcknowledgement>,
    ) {
        let mut state = self.state.borrow_mut();
        let State {
            bindings,
            retained_bytes,
            ..
        } = &mut *state;
        for acknowledgement in acknowledgements {
            if let Some(binding) = bindings
                .get_mut(&acknowledgement.binding_id)
                .filter(|binding| binding.is_session(session))
            {
                *retained_bytes -= binding.release(acknowledgement.seq);
            }
        }
    }

    pub(crate) fn cancel_launch(
        &self,
        integration: &RelayIntegration,
        binding_id: &str,
        run_id: &str,
    ) {
        let state = self.state.borrow();
        let launch = state
            .bindings
            .get(binding_id)
            .filter(|binding| binding.integration.same(integration))
            .and_then(|binding| binding.launch.as_ref());
        if let Some(launch) =
            launch.filter(|launch| launch.run_id == run_id && launch.handle.borrow().is_none())
        {
            launch.cancel();
        }
    }

    pub(crate) async fn launch<Fut: Future<Output = ExecutorResult<AgentExecutionHandle>>>(
        self: &Rc<Self>,
        session: &ProducerRelaySession,
        integration: &RelayIntegration,
        request: LaunchRequest<'_>,
        signal: CancellationToken,
        on_undelivered_reply: ObserveUndeliveredReply,
        run: impl FnOnce(CancellationToken) -> Fut,
    ) -> ExecutorResult<AgentExecutionHandle> {
        let started = {
            let mut state = self.state.borrow_mut();
            state
                .bindings
                .get_mut(&request.producer_binding.id)
                .filter(|binding| binding.integration.same(integration))
                .map(|binding| {
                    binding.received.push_back(request.run_id.to_owned());
                    if binding.received.len() > RECEIVED_LAUNCHES {
                        binding.received.pop_front();
                    }
                    if let Some(previous) = &binding.launch
                        && previous.handle.borrow().is_none()
                    {
                        previous.cancel();
                    }
                    let launch = Rc::new(Launch {
                        run_id: request.run_id.to_owned(),
                        handle: RefCell::default(),
                        signal: signal.child_token(),
                        cancelled: Cell::new(false),
                    });
                    binding.launch = Some(Rc::clone(&launch));
                    (binding.generation, launch)
                })
        };
        let Some((generation, launch)) = started else {
            return run_launch(run(signal)).await;
        };

        let outcome = match run_launch(run(launch.signal.clone())).await {
            Ok(handle) if launch.cancelled.get() => {
                let execution = integration.execution.clone();
                spawn_local(async move {
                    let _ = execution.abort(handle, None).await;
                });
                Err(AgentCallError::new(
                    AgentDeliveryOutcome::Rejected,
                    "The launch was cancelled before it started.",
                )
                .into())
            }
            result => result,
        };
        let same_session = self
            .state
            .borrow_mut()
            .bindings
            .get_mut(&request.producer_binding.id)
            .filter(|binding| {
                binding.generation == generation
                    && binding
                        .launch
                        .as_ref()
                        .is_some_and(|current| Rc::ptr_eq(current, &launch))
            })
            .map(|binding| {
                match &outcome {
                    Ok(handle) => {
                        launch.handle.replace(Some(handle.clone()));
                    }
                    Err(_) => {
                        binding.launch.take();
                    }
                }
                binding.is_session(session)
            });
        if let Some(same_session) = same_session {
            let result = match &outcome {
                Ok(handle) => AgentLaunchOutcome::Started {
                    handle: handle.clone(),
                },
                Err(error) => AgentLaunchOutcome::Failed {
                    error: if launch.signal.is_cancelled() && !same_session {
                        AgentRunFailureDetail {
                            code: EXECUTOR_DISCONNECTED_BEFORE_START.code.into(),
                            message: Some(EXECUTOR_DISCONNECTED_BEFORE_START.message.into()),
                        }
                    } else {
                        launch_failure(error.as_ref())
                    },
                },
            };
            let relay = Rc::downgrade(self);
            let integration = integration.clone();
            let notification = AgentProducerNotification {
                binding: request.producer_binding.clone(),
                event: AgentProducerNotificationEvent::Control(
                    AgentProducerControlEvent::LaunchSettled {
                        run_id: launch.run_id.clone(),
                        outcome: result,
                    },
                ),
            };
            let publish = Rc::new(move || {
                if let Some(relay) = relay.upgrade() {
                    relay.publish(&integration, notification.clone());
                }
            });
            if same_session {
                on_undelivered_reply(publish);
            } else {
                publish();
            }
        }
        outcome
    }

    pub(crate) fn dispose(&self) {
        let subscriptions = {
            let mut state = self.state.borrow_mut();
            state.bindings.clear();
            state.retained_bytes = 0;
            std::mem::take(&mut state.subscriptions)
        };
        self.retry.take();
        for (_, off) in subscriptions {
            off();
        }
    }

    fn publish(
        self: &Rc<Self>,
        integration: &RelayIntegration,
        notification: AgentProducerNotification,
    ) {
        let live = {
            let mut state = self.state.borrow_mut();
            let State {
                bindings,
                retained_bytes,
                published,
                ..
            } = &mut *state;
            let Some(binding) = bindings
                .get_mut(&notification.binding.id)
                .filter(|binding| binding.integration.same(integration))
            else {
                return;
            };
            if let AgentProducerNotificationEvent::Provider(AgentProducerEvent::RunEnded {
                run_id,
                ..
            }) = &notification.event
                && binding
                    .launch
                    .as_ref()
                    .is_some_and(|launch| &launch.run_id == run_id)
            {
                binding.launch.take();
            }
            let seq = binding.seq + 1;
            let Ok(payload) = encode_frame(seq, &notification) else {
                return;
            };
            binding.seq = seq;
            *published += 1;
            let order = *published;
            let size = payload.len();
            binding.retained.push_back(Rc::new(RetainedFrame {
                seq,
                order,
                payload,
                droppable: Cell::new(matches!(
                    notification.event,
                    AgentProducerNotificationEvent::Provider(AgentProducerEvent::Rows { .. })
                )),
            }));
            binding.retained_bytes += size;
            *retained_bytes += size;
            let live = binding.session.is_some();
            while state.retained_bytes > self.options.retained_bytes
                && state.drop_oldest_rows(order)
            {}
            live
        };
        if live {
            self.pump();
        }
    }

    fn pump(self: &Rc<Self>) {
        if self.pumping.replace(true) {
            return;
        }
        let _pumping = ResetFlag(&self.pumping);
        loop {
            let next = self.state.borrow().next_unsent();
            let Some(next) = next else { return };
            let accepted = (next.session)(next.frame.payload.clone());
            let mut state = self.state.borrow_mut();
            // Offering may synchronously retire the session.
            let Some(binding) = state.bindings.get_mut(&next.id).filter(|binding| {
                binding.generation == next.generation && binding.is_session(&next.session)
            }) else {
                continue;
            };
            if !accepted {
                if self.retry.borrow().is_none() {
                    let relay = Rc::downgrade(self);
                    self.retry.replace(Some(Timer(spawn_local(async move {
                        sleep(PUMP_RETRY).await;
                        if let Some(relay) = relay.upgrade() {
                            relay.retry.take();
                            relay.pump();
                        }
                    }))));
                }
                return;
            }
            if binding
                .retained
                .get(binding.sent)
                .is_some_and(|frame| Rc::ptr_eq(frame, &next.frame))
            {
                binding.sent += 1;
            }
        }
    }

    fn expire_within(self: &Rc<Self>, binding: &mut Binding, grace: Duration) {
        let deadline = Instant::now() + grace;
        if binding
            .grace
            .as_ref()
            .is_some_and(|grace| grace.deadline <= deadline)
        {
            return;
        }
        let relay = Rc::downgrade(self);
        let generation = binding.generation;
        let id = binding.reference.id.clone();
        binding.grace.replace(Grace {
            deadline,
            _timer: Timer(spawn_local(async move {
                sleep_until(deadline).await;
                if let Some(relay) = relay.upgrade() {
                    relay.expire(&id, generation);
                }
            })),
        });
    }

    fn expire(&self, id: &str, generation: u64) {
        let binding = {
            let mut state = self.state.borrow_mut();
            if !state.bindings.get(id).is_some_and(|binding| {
                binding.session.is_none() && binding.generation == generation
            }) {
                return;
            }
            state.forget(id)
        };
        if let Some(binding) = binding {
            binding.integration.producers.detach(binding.reference);
        }
    }
}

impl Drop for ProducerRelay {
    fn drop(&mut self) {
        self.dispose();
    }
}

struct ResetFlag<'a>(&'a Cell<bool>);

impl Drop for ResetFlag<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

impl State {
    fn forget(&mut self, id: &str) -> Option<Binding> {
        let binding = self.bindings.shift_remove(id)?;
        self.retained_bytes -= binding.retained_bytes;
        Some(binding)
    }

    fn next_unsent(&self) -> Option<Unsent> {
        self.bindings
            .iter()
            .filter_map(|(id, binding)| {
                Some((
                    id,
                    binding,
                    binding.session.as_ref()?,
                    binding.retained.get(binding.sent)?,
                ))
            })
            .min_by_key(|(_, _, _, frame)| frame.order)
            .map(|(id, binding, session, frame)| Unsent {
                id: id.clone(),
                generation: binding.generation,
                session: session.clone(),
                frame: frame.clone(),
            })
    }

    fn drop_oldest_rows(&mut self, newest: u64) -> bool {
        let Some((_, frame, binding)) = self
            .bindings
            .values_mut()
            .enumerate()
            .filter_map(|(index, binding)| {
                let frame = binding
                    .retained
                    .iter()
                    .position(|frame| frame.order != newest && frame.droppable.get())?;
                Some((index, frame, binding))
            })
            .max_by_key(|(index, _, binding)| (binding.retained_bytes, std::cmp::Reverse(*index)))
        else {
            return false;
        };
        if let Some(dropped) = binding.retained.remove(frame) {
            if frame < binding.sent {
                binding.sent -= 1;
            }
            binding.retained_bytes -= dropped.payload.len();
            self.retained_bytes -= dropped.payload.len();
            return true;
        }
        false
    }
}

impl Binding {
    fn is_session(&self, session: &ProducerRelaySession) -> bool {
        self.session
            .as_ref()
            .is_some_and(|current| Rc::ptr_eq(current, session))
    }

    fn release(&mut self, seq: u64) -> usize {
        let mut released = 0;
        while self.retained.front().is_some_and(|frame| frame.seq <= seq) {
            if let Some(frame) = self.retained.pop_front() {
                released += frame.payload.len();
                self.sent = self.sent.saturating_sub(1);
            }
        }
        self.retained_bytes -= released;
        released
    }
}

async fn run_launch(
    run: impl Future<Output = ExecutorResult<AgentExecutionHandle>>,
) -> ExecutorResult<AgentExecutionHandle> {
    run.await.map_err(|error| {
        if let Some(call) = agent_call_error(error.as_ref())
            && call.outcome == AgentDeliveryOutcome::Unknown
        {
            AgentCallError::with_code(
                AgentDeliveryOutcome::Rejected,
                call.message.clone(),
                call.code,
            )
            .into()
        } else {
            error
        }
    })
}

fn agent_call_error<'a>(error: &'a (dyn Error + 'static)) -> Option<&'a AgentCallError> {
    error.downcast_ref::<AgentCallError>().or_else(|| {
        error
            .downcast_ref::<ExecutorSessionLostError>()
            .map(|lost| &**lost)
    })
}

fn launch_failure(error: &(dyn Error + 'static)) -> AgentRunFailureDetail {
    let integration = agent_call_error(error)
        .map(|call| &**call)
        .or_else(|| error.downcast_ref::<AgentIntegrationError>());
    let (code, message) = if is_parse_error(error) {
        ("PROVIDER_FAILURE", MALFORMED_DATA.to_owned())
    } else if let Some(error) = integration {
        (error.code.as_str(), error.message.clone())
    } else {
        ("PROVIDER_FAILURE", error.to_string())
    };
    AgentRunFailureDetail {
        code: code.to_owned(),
        message: (!message.is_empty()).then_some(message),
    }
}

fn encode_frame(
    seq: u64,
    notification: &AgentProducerNotification,
) -> Result<String, serde_json::Error> {
    let payload = serde_json::to_string(&AgentProducerFrame { seq, notification })?;
    if payload.len() <= SESSION_MESSAGE_BYTES {
        return Ok(payload);
    }
    serde_json::to_string(&AgentProducerFrame {
        seq,
        notification: AgentProducerNotification {
            binding: notification.binding.clone(),
            event: AgentProducerNotificationEvent::Control(AgentProducerControlEvent::PublicationFailed {
                error: AgentRunFailureDetail {
                    code: "OUTCOME_UNKNOWN".to_owned(),
                    message: Some("Provider output exceeds the executor message size limit. Native history may contain additional output.".to_owned()),
                }
            })
        },
    })
}

#[cfg(test)]
mod tests;
