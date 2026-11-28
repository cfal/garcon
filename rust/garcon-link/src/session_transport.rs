//! Ports `server/remote/transport/session-transport.ts`.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::future::{Future, pending};
use std::ops::Bound::{Excluded, Unbounded};
use std::rc::Rc;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::Shared;

use crate::message_queue_budget::MessageQueueBudget;
use crate::message_session::{
    AvailabilityChanged, InvalidSessionLimits, MessageSession, MessageSessionAttachment,
    MessageSessionOptions, SessionError, SessionFailed, SessionSocket,
};
use crate::rpc_lane::RpcLane;
use crate::session_socket::SESSION_MESSAGE_BYTES;

pub type MessageListener = Rc<dyn Fn(&str) -> Result<(), SessionError>>;

type Message = dyn Fn(&str) -> Result<(), SessionError>;
type Failed = dyn Fn(SessionError);
type Availability = dyn Fn(bool);

struct Listeners<T: ?Sized> {
    next_id: Cell<u64>,
    callbacks: RefCell<BTreeMap<u64, Rc<T>>>,
}

impl<T: ?Sized + 'static> Listeners<T> {
    fn new() -> Rc<Self> {
        Rc::new(Self {
            next_id: Cell::new(0),
            callbacks: RefCell::default(),
        })
    }

    fn subscribe(self: &Rc<Self>, callback: Rc<T>) -> impl Fn() + use<T> {
        let mut callbacks = self.callbacks.borrow_mut();
        let id = callbacks
            .iter()
            .find_map(|(id, registered)| Rc::ptr_eq(&callback, registered).then_some(*id))
            .unwrap_or_else(|| {
                let id = self.next_id.get() + 1;
                self.next_id.set(id);
                callbacks.insert(id, callback);
                id
            });
        let listeners = Rc::clone(self);
        move || {
            listeners.callbacks.borrow_mut().remove(&id);
        }
    }

    fn clear(&self) {
        self.callbacks.borrow_mut().clear();
    }

    fn notify<E>(&self, mut call: impl FnMut(&T) -> Result<(), E>) -> Result<(), E> {
        let mut last = 0;
        loop {
            let next = self
                .callbacks
                .borrow()
                .range((Excluded(last), Unbounded))
                .next()
                .map(|(id, callback)| (*id, Rc::clone(callback)));
            let Some((id, callback)) = next else {
                return Ok(());
            };
            last = id;
            call(&callback)?;
        }
    }
}

type ReadyResult = Result<(), SessionError>;

struct Events {
    ready: RefCell<Option<oneshot::Sender<ReadyResult>>>,
    messages: Rc<Listeners<Message>>,
    failures: Rc<Listeners<Failed>>,
    availability: Rc<Listeners<Availability>>,
    failure: RefCell<Option<SessionError>>,
}

impl Events {
    fn settle(&self, result: ReadyResult) {
        if let Some(sender) = self.ready.borrow_mut().take() {
            let _ = sender.send(result);
        }
    }

    fn failed(&self, error: SessionError) {
        *self.failure.borrow_mut() = Some(Rc::clone(&error));
        self.settle(Err(Rc::clone(&error)));
        let _: Result<(), std::convert::Infallible> = self.failures.notify(|callback| {
            callback(Rc::clone(&error));
            Ok(())
        });
        self.messages.clear();
        self.failures.clear();
        self.availability.clear();
    }

    fn changed(&self, connected: bool) {
        if connected {
            self.settle(Ok(()));
        }
        let _: Result<(), std::convert::Infallible> = self.availability.notify(|callback| {
            callback(connected);
            Ok(())
        });
    }

    fn deliver(&self, body: &str) -> Result<(), SessionError> {
        self.messages.notify(|callback| callback(body))
    }
}

pub struct SessionTransportOptions {
    pub max_queued_bytes: Option<usize>,
    pub max_queued_frames: Option<usize>,
    pub budget: Option<Rc<MessageQueueBudget>>,
    pub executor_id: String,
    pub lane: RpcLane,
    pub primary_session_id: Option<String>,
}

impl Default for SessionTransportOptions {
    fn default() -> Self {
        Self {
            max_queued_bytes: None,
            max_queued_frames: None,
            budget: None,
            executor_id: "local".to_owned(),
            lane: RpcLane::Primary,
            primary_session_id: None,
        }
    }
}

pub struct SessionTransport {
    pub id: String,
    pub peer_runtime_id: String,
    pub executor_id: String,
    pub lane: RpcLane,
    pub primary_session_id: String,
    pub channel: Rc<MessageSession>,
    events: Rc<Events>,
    ready: Shared<oneshot::Receiver<ReadyResult>>,
}

impl SessionTransport {
    pub fn new(
        id: String,
        peer_runtime_id: String,
        retired: SessionFailed,
        options: SessionTransportOptions,
    ) -> Result<Rc<Self>, InvalidSessionLimits> {
        let (sender, receiver) = oneshot::channel();
        let events = Rc::new(Events {
            ready: RefCell::new(Some(sender)),
            messages: Listeners::new(),
            failures: Listeners::new(),
            availability: Listeners::new(),
            failure: RefCell::default(),
        });
        let channel = MessageSession::new(MessageSessionOptions {
            deliver: Rc::new({
                let events = Rc::clone(&events);
                move |body| events.deliver(&body)
            }),
            failed: Rc::new({
                let events = Rc::clone(&events);
                move |error| {
                    events.failed(Rc::clone(&error));
                    retired(error);
                }
            }),
            availability_changed: Some(Rc::new({
                let events = Rc::clone(&events);
                move |connected| events.changed(connected)
            })),
            max_queued_bytes: options.max_queued_bytes,
            max_queued_frames: options.max_queued_frames,
            max_frame_bytes: Some(SESSION_MESSAGE_BYTES),
            budget: options.budget,
            lane: options.lane,
        })?;
        Ok(Rc::new(Self {
            primary_session_id: options.primary_session_id.unwrap_or_else(|| id.clone()),
            id,
            peer_runtime_id,
            executor_id: options.executor_id,
            lane: options.lane,
            channel,
            events,
            ready: receiver.shared(),
        }))
    }

    pub fn connected(&self) -> bool {
        self.channel.connected()
    }

    pub fn ready(&self) -> impl Future<Output = ReadyResult> + use<> {
        let ready = self.ready.clone();
        async move {
            match ready.await {
                Ok(result) => result,
                Err(_) => pending().await,
            }
        }
    }

    pub fn attach(
        &self,
        socket: Rc<dyn SessionSocket>,
    ) -> Result<MessageSessionAttachment, SessionError> {
        self.channel.attach(socket)
    }

    pub fn send(&self, body: String) -> Result<(), SessionError> {
        self.channel.send(body)
    }

    pub fn close(&self, error: Option<SessionError>) {
        self.channel.close(error);
    }

    pub fn on_message(&self, listener: MessageListener) -> impl Fn() + use<> {
        self.events.messages.subscribe(listener)
    }

    pub fn on_failure(&self, listener: SessionFailed) -> impl Fn() + use<> {
        let unsubscribe = self.events.failures.subscribe(Rc::clone(&listener));
        let failure = self.events.failure.borrow().clone();
        if let Some(error) = failure {
            listener(error);
        }
        unsubscribe
    }

    pub fn on_availability(&self, listener: AvailabilityChanged) -> impl Fn() + use<> {
        self.events.availability.subscribe(listener)
    }
}
