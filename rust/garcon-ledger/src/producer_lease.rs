use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use garcon_interface::{
    producer::{AgentProducerEvent, AgentProducerSink},
    resources::ExecutorResult,
};

use crate::errors::TranscriptSinkClosedError;

type Publish = dyn Fn(&ProducerLease, AgentProducerEvent) -> ExecutorResult<()>;
type OnClose = dyn FnOnce(&ProducerLease) -> ExecutorResult<()>;
pub type ProducerClosedListener = dyn Fn() -> ExecutorResult<()>;

pub struct ProducerLease {
    closed: Cell<bool>,
    publish: Box<Publish>,
    on_close: RefCell<Option<Box<OnClose>>>,
    listeners: RefCell<Vec<Rc<ProducerClosedListener>>>,
}

impl ProducerLease {
    pub fn new(
        publish: impl Fn(&Self, AgentProducerEvent) -> ExecutorResult<()> + 'static,
        on_close: impl FnOnce(&Self) -> ExecutorResult<()> + 'static,
    ) -> Rc<Self> {
        Rc::new(Self {
            closed: Cell::new(false),
            publish: Box::new(publish),
            on_close: RefCell::new(Some(Box::new(on_close))),
            listeners: RefCell::new(Vec::new()),
        })
    }

    pub fn sink(self: &Rc<Self>) -> Rc<dyn AgentProducerSink> {
        self.clone()
    }

    pub fn closed(&self) -> bool {
        self.closed.get()
    }

    pub fn on_closed(
        self: &Rc<Self>,
        listener: Rc<ProducerClosedListener>,
    ) -> ExecutorResult<impl Fn() + use<>> {
        if self.closed() {
            listener()?;
        } else {
            let mut listeners = self.listeners.borrow_mut();
            if !listeners.iter().any(|prior| Rc::ptr_eq(prior, &listener)) {
                listeners.push(Rc::clone(&listener));
            }
        }
        let lease: Weak<Self> = Rc::downgrade(self);
        Ok(move || {
            if let Some(lease) = lease.upgrade() {
                lease
                    .listeners
                    .borrow_mut()
                    .retain(|prior| !Rc::ptr_eq(prior, &listener));
            }
        })
    }

    pub fn close(&self) -> ExecutorResult<()> {
        if self.closed.replace(true) {
            return Ok(());
        }
        let on_close = self.on_close.borrow_mut().take();
        if let Some(on_close) = on_close {
            on_close(self)?;
        }
        let initial_listeners = self.listeners.borrow().clone();
        for listener in initial_listeners {
            // A listener can unsubscribe a later one before its turn.
            let subscribed = self
                .listeners
                .borrow()
                .iter()
                .any(|entry| Rc::ptr_eq(entry, &listener));
            if subscribed {
                listener()?;
            }
        }
        drop(self.listeners.take());
        Ok(())
    }
}

impl AgentProducerSink for ProducerLease {
    fn publish(&self, event: AgentProducerEvent) -> ExecutorResult<()> {
        if self.closed() {
            return Err(TranscriptSinkClosedError.into());
        }
        (self.publish)(self, event)
    }
}
