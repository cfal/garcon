use std::{error::Error, rc::Rc};

use futures::future::LocalBoxFuture;

use crate::sqlite_operations::LedgerResult;

use super::{LedgerListenerErrorHandler, TranscriptCommitEvent, listeners::OrderedListeners};

pub type TranscriptCommitListener = dyn Fn(Rc<TranscriptCommitEvent>) -> TranscriptCommitWork;

/// The listener's synchronous prefix runs during dispatch; pending work settles separately.
pub enum TranscriptCommitWork {
    Complete(LedgerResult<()>),
    Pending(LocalBoxFuture<'static, LedgerResult<()>>),
}

pub(super) struct CommitNotifications {
    listeners: Rc<OrderedListeners<TranscriptCommitListener>>,
    on_error: Rc<LedgerListenerErrorHandler>,
}

impl CommitNotifications {
    pub(super) fn new(on_error: Rc<LedgerListenerErrorHandler>) -> Self {
        Self {
            listeners: Rc::default(),
            on_error,
        }
    }

    pub(super) fn subscribe(
        self: &Rc<Self>,
        listener: Rc<TranscriptCommitListener>,
    ) -> Box<dyn Fn()> {
        self.listeners.subscribe(listener)
    }

    pub(super) fn notify(self: &Rc<Self>, event: TranscriptCommitEvent) {
        let notifications = Rc::clone(self);
        tokio::task::spawn_local(async move {
            notifications.dispatch(Rc::new(event));
        });
    }

    pub(super) fn report_error(&self, error: Box<dyn Error>) {
        (self.on_error)(error);
    }

    pub(super) fn finish_work(&self, work: TranscriptCommitWork) {
        match work {
            TranscriptCommitWork::Complete(Ok(())) => {}
            TranscriptCommitWork::Complete(Err(error)) => self.report_error(error),
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

    fn dispatch(&self, event: Rc<TranscriptCommitEvent>) {
        for listener in self.listeners.iter() {
            self.finish_work(listener(Rc::clone(&event)));
        }
    }
}
