use std::{
    cell::{Cell, RefCell},
    error::Error,
    rc::Rc,
};

use garcon_base::domain_error::DomainError;
use garcon_contract::error_codes::ErrorCode;
use indexmap::IndexMap;
use tokio_util::sync::CancellationToken;

use crate::store::TranscriptReadSignal;

#[derive(Default)]
pub(super) struct ReadShutdown {
    closed: Cell<bool>,
    pending: RefCell<IndexMap<*const ReadAbort, Rc<ReadAbort>>>,
}

struct ReadAbort {
    token: CancellationToken,
    shutdown_first: Cell<bool>,
}

impl ReadAbort {
    fn shutdown(&self) {
        // A cancelled child already carries the caller's reason.
        if !self.token.is_cancelled() {
            self.shutdown_first.set(true);
            self.token.cancel();
        }
    }
}

impl ReadShutdown {
    pub(super) fn begin(&self, caller: Option<TranscriptReadSignal<'_>>) -> ReadScope<'_> {
        let read = Rc::new(ReadAbort {
            token: caller.map_or_else(CancellationToken::new, |signal| {
                signal.token().child_token()
            }),
            shutdown_first: Cell::new(false),
        });
        if self.closed.get() {
            read.shutdown();
        } else {
            self.pending
                .borrow_mut()
                .insert(Rc::as_ptr(&read), Rc::clone(&read));
        }
        ReadScope { read, owner: self }
    }

    pub(super) fn close(&self) {
        self.closed.set(true);
        for (_, read) in self.pending.take() {
            read.shutdown();
        }
    }
}

pub(super) struct ReadScope<'a> {
    read: Rc<ReadAbort>,
    owner: &'a ReadShutdown,
}

impl ReadScope<'_> {
    pub(super) fn token(&self) -> &CancellationToken {
        &self.read.token
    }

    pub(super) fn reason(&self, caller: Option<TranscriptReadSignal<'_>>) -> Box<dyn Error> {
        if let Some(caller) = caller
            && !self.read.shutdown_first.get()
        {
            return caller.abort_error();
        }
        DomainError::new(
            ErrorCode::SERVER_SHUTTING_DOWN,
            "Server is shutting down",
            503,
            true,
        )
        .into()
    }
}

impl Drop for ReadScope<'_> {
    fn drop(&mut self) {
        self.owner
            .pending
            .borrow_mut()
            .shift_remove(&Rc::as_ptr(&self.read));
    }
}

#[cfg(test)]
mod tests {
    use garcon_base::domain_error::as_domain_error;

    use super::*;

    #[test]
    fn an_active_read_keeps_the_first_of_caller_abort_and_shutdown() {
        for caller_first in [true, false] {
            let shutdown = ReadShutdown::default();
            let caller = CancellationToken::new();
            let caller_reason = || std::io::Error::other("synthetic caller abort").into();
            let caller_signal = Some(TranscriptReadSignal::with_reason(&caller, &caller_reason));
            let read = shutdown.begin(caller_signal);
            let reason = || read.reason(caller_signal);
            let signal = TranscriptReadSignal::with_reason(read.token(), &reason);
            assert!(signal.check().is_ok());
            if caller_first {
                caller.cancel();
                shutdown.close();
                assert_eq!(
                    signal.check().unwrap_err().to_string(),
                    "synthetic caller abort"
                );
            } else {
                shutdown.close();
                caller.cancel();
                let error = signal.check().unwrap_err();
                assert_eq!(
                    as_domain_error(error.as_ref()).unwrap().code,
                    ErrorCode::SERVER_SHUTTING_DOWN
                );
            }
        }
    }
}
