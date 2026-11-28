use std::{collections::HashMap, error::Error, fmt, rc::Rc};

use garcon_base::errors::DiagnosticError;

use crate::{
    connection_entry::ConnectionEntry,
    errors::{LedgerCodecError, LedgerError},
    sqlite_operations::{
        LedgerResult, SqliteError, TransactionFailure, as_error, get_transaction_rollback_failure,
        is_query_failure,
    },
};

#[derive(Debug, Clone)]
pub(crate) struct SharedLedgerFailure(Rc<Box<dyn Error>>);

impl SharedLedgerFailure {
    pub fn new(error: Box<dyn Error>) -> Self {
        Self(Rc::new(error))
    }

    pub fn fenced(&self, chat_id: &str) -> Box<dyn Error> {
        Box::new(LedgerError::Fenced {
            chat_id: chat_id.into(),
            cause: Box::new(self.clone()),
        })
    }
}

impl fmt::Display for SharedLedgerFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl Error for SharedLedgerFailure {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.0.as_ref().as_ref())
    }
}

#[derive(Default)]
pub struct LedgerFailureFences {
    read_failures: HashMap<String, SharedLedgerFailure>,
    write_failures: HashMap<String, SharedLedgerFailure>,
}

impl LedgerFailureFences {
    pub fn has_read_failure(&self, chat_id: &str) -> bool {
        self.read_failures.contains_key(chat_id)
    }

    pub fn read<'a, T>(
        &mut self,
        chat_id: &str,
        available: impl FnOnce() -> LedgerResult<&'a mut ConnectionEntry>,
        work: impl FnOnce(&mut ConnectionEntry) -> LedgerResult<T>,
    ) -> LedgerResult<T> {
        if let Some(failure) = self.read_failures.get(chat_id) {
            return Err(failure.fenced(chat_id));
        }
        let entry = available()?;
        match work(entry) {
            Ok(result) => Ok(result),
            Err(error) if is_domain_error(error.as_ref()) && !is_query_failure(error.as_ref()) => {
                Err(error)
            }
            Err(error) => {
                let failure = SharedLedgerFailure::new(as_error(error));
                self.read_failures.insert(chat_id.into(), failure.clone());
                Err(failure.fenced(chat_id))
            }
        }
    }

    pub fn write<'a, T>(
        &mut self,
        chat_id: &str,
        available: impl FnOnce() -> LedgerResult<&'a mut ConnectionEntry>,
        work: impl FnOnce(&mut ConnectionEntry) -> LedgerResult<T>,
        rehydrate: impl FnOnce(&mut ConnectionEntry) -> LedgerResult<()>,
    ) -> LedgerResult<T> {
        if let Some(failure) = self
            .read_failures
            .get(chat_id)
            .or_else(|| self.write_failures.get(chat_id))
        {
            return Err(failure.fenced(chat_id));
        }
        let entry = available()?;
        let error = match work(entry) {
            Ok(value) => return Ok(value),
            Err(error) => as_error(error),
        };
        let rollback_failure = get_transaction_rollback_failure(error.as_ref());
        let read_unsafe = is_read_unsafe_failure(error.as_ref())
            || rollback_failure.is_some_and(is_read_unsafe_failure);
        let in_transaction = !entry.db.is_autocommit();
        if is_domain_error(error.as_ref())
            && !read_unsafe
            && rollback_failure.is_none()
            && !in_transaction
        {
            return Err(error);
        }
        let failure = SharedLedgerFailure::new(error);
        self.write_failures.insert(chat_id.into(), failure.clone());
        if read_unsafe || in_transaction {
            self.read_failures.insert(chat_id.into(), failure.clone());
        } else if let Err(error) = rehydrate(entry) {
            self.read_failures
                .insert(chat_id.into(), SharedLedgerFailure::new(as_error(error)));
        }
        Err(failure.fenced(chat_id))
    }

    pub fn delete(&mut self, chat_id: &str) {
        self.read_failures.remove(chat_id);
        self.write_failures.remove(chat_id);
    }

    pub fn clear(&mut self) {
        self.read_failures.clear();
        self.write_failures.clear();
    }
}

fn is_read_unsafe_failure(error: &(dyn Error + 'static)) -> bool {
    is_query_failure(error) || is_sqlite_corruption_failure(error)
}

fn is_sqlite_corruption_failure(error: &(dyn Error + 'static)) -> bool {
    if let Some(error) = error.downcast_ref::<TransactionFailure>() {
        return is_sqlite_corruption_failure(error.cause.as_ref());
    }
    error
        .downcast_ref::<SqliteError>()
        .and_then(|error| error.diagnostic_metadata().code)
        .is_some_and(|code| code == "SQLITE_CORRUPT" || code.starts_with("SQLITE_CORRUPT_"))
}

fn is_domain_error(error: &(dyn Error + 'static)) -> bool {
    error.is::<LedgerError>()
        || error
            .downcast_ref::<LedgerCodecError>()
            .is_some_and(|error| error.diagnostic_metadata().name == "TypeError")
}
