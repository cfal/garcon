use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    ops::Bound::{Excluded, Unbounded},
    rc::Rc,
};

use futures::future::LocalBoxFuture;

use crate::sqlite_operations::LedgerResult;

use super::{LedgerListenerErrorHandler, TranscriptCommitEvent};

pub type TranscriptCommitListener = dyn Fn(Rc<TranscriptCommitEvent>) -> TranscriptCommitWork;

/// The listener's synchronous prefix runs during dispatch; pending work settles separately.
pub enum TranscriptCommitWork {
    Complete(LedgerResult<()>),
    Pending(LocalBoxFuture<'static, LedgerResult<()>>),
}

pub(super) struct CommitNotifications {
    listeners: RefCell<BTreeMap<u64, Rc<TranscriptCommitListener>>>,
    last_listener_id: Cell<u64>,
    on_error: Rc<LedgerListenerErrorHandler>,
}

impl CommitNotifications {
    pub(super) fn new(on_error: Rc<LedgerListenerErrorHandler>) -> Self {
        Self {
            listeners: RefCell::new(BTreeMap::new()),
            last_listener_id: Cell::new(0),
            on_error,
        }
    }

    pub(super) fn subscribe(
        self: &Rc<Self>,
        listener: Rc<TranscriptCommitListener>,
    ) -> Box<dyn Fn()> {
        let mut listeners = self.listeners.borrow_mut();
        if !listeners.values().any(|entry| Rc::ptr_eq(entry, &listener)) {
            let id = self.last_listener_id.get() + 1;
            self.last_listener_id.set(id);
            listeners.insert(id, Rc::clone(&listener));
        }
        let notifications = Rc::downgrade(self);
        Box::new(move || {
            if let Some(notifications) = notifications.upgrade() {
                notifications
                    .listeners
                    .borrow_mut()
                    .retain(|_, entry| !Rc::ptr_eq(entry, &listener));
            }
        })
    }

    pub(super) fn notify(self: &Rc<Self>, event: TranscriptCommitEvent) {
        let notifications = Rc::clone(self);
        tokio::task::spawn_local(async move {
            notifications.dispatch(Rc::new(event));
        });
    }

    fn dispatch(&self, event: Rc<TranscriptCommitEvent>) {
        let mut last = 0;
        loop {
            // Resolve the next listener after each call, since callbacks can change the set.
            let next = self
                .listeners
                .borrow()
                .range((Excluded(last), Unbounded))
                .next()
                .map(|(id, listener)| (*id, Rc::clone(listener)));
            let Some((id, listener)) = next else { return };
            last = id;
            match listener(Rc::clone(&event)) {
                TranscriptCommitWork::Complete(Ok(())) => {}
                TranscriptCommitWork::Complete(Err(error)) => (self.on_error)(error),
                TranscriptCommitWork::Pending(work) => {
                    let on_error = Rc::clone(&self.on_error);
                    tokio::task::spawn_local(async move {
                        if let Err(error) = work.await {
                            on_error(error);
                        }
                    });
                }
            }
        }
    }
}
