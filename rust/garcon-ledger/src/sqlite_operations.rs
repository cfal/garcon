use std::{error::Error, fmt, rc::Rc};

use garcon_base::errors::{DiagnosticError, ErrorMetadata};
use garcon_js::Number;
use rusqlite::{Connection, Row, ffi};

use crate::{
    codec::StoredLedgerRow,
    write_timings::{LedgerWriteTimings, WritePhase},
};

mod result_code_names;
use result_code_names::sqlite_code_name;

pub type LedgerResult<T> = Result<T, Box<dyn Error>>;

pub fn bind_ordinal(ordinal: u64) -> rusqlite::types::Value {
    use rusqlite::types::Value;
    // Bun 1.4.3 switches its numeric binding from INTEGER to REAL at 2^51.
    if ordinal < (1 << 51) {
        Value::Integer(ordinal as i64)
    } else {
        Value::Real(ordinal as f64)
    }
}

pub fn next_ordinal(db: &Connection, view_id: &str) -> LedgerResult<u64> {
    run_query(|| {
        db.prepare_cached(
            "
      SELECT max(ordinal) AS maximum FROM transcript_rows WHERE view_id = ?
    ",
        )?
        .query_row([view_id], |row| {
            row.get::<_, Option<i64>>(0)?
                .map(|value| non_negative_integer(value, 0))
                .transpose()
        })
    })
    .map(|maximum| maximum.unwrap_or(0) + 1)
}

pub(crate) fn non_negative_integer(value: i64, column: usize) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(column, value))
}

pub fn read_stored_row(row: &Row<'_>) -> rusqlite::Result<StoredLedgerRow> {
    use rusqlite::types::ValueRef;
    let ordinal = match row.get_ref(1)? {
        ValueRef::Integer(value) => value as f64,
        ValueRef::Real(value) => value,
        _ => f64::NAN,
    };
    Ok(StoredLedgerRow {
        view_id: row.get(0)?,
        ordinal: Number(ordinal),
        kind: row.get(2)?,
        at: row.get(3)?,
        client_message_id: row.get(4)?,
        payload_json: row.get(5)?,
    })
}

pub fn run_transaction<T>(
    db: &Connection,
    work: impl FnOnce() -> LedgerResult<T>,
) -> LedgerResult<T> {
    run_transaction_with_timings(db, work, None)
}

pub(crate) fn run_timed_transaction<T>(
    db: &Connection,
    work: impl FnOnce() -> LedgerResult<T>,
    timings: &mut LedgerWriteTimings<'_>,
) -> LedgerResult<T> {
    run_transaction_with_timings(db, work, Some(timings))
}

fn run_transaction_with_timings<T>(
    db: &Connection,
    work: impl FnOnce() -> LedgerResult<T>,
    mut timings: Option<&mut LedgerWriteTimings<'_>>,
) -> LedgerResult<T> {
    let mut phase = |phase| {
        if let Some(timings) = &mut timings {
            timings.phase(phase);
        }
    };
    let result: LedgerResult<T> = (|| {
        phase(WritePhase::Begin);
        db.execute_batch("BEGIN IMMEDIATE").map_err(as_error)?;
        phase(WritePhase::Statements);
        let result = work().map_err(as_error)?;
        phase(WritePhase::Commit);
        db.execute_batch("COMMIT").map_err(as_error)?;
        Ok(result)
    })();
    let result: LedgerResult<T> = match result {
        Err(cause) if !db.is_autocommit() => {
            phase(WritePhase::Rollback);
            if let Err(failure) = db.execute_batch("ROLLBACK") {
                Err(Box::new(TransactionFailure {
                    cause,
                    rollback_failure: as_error(failure),
                }))
            } else {
                Err(cause)
            }
        }
        result => result,
    };
    phase(WritePhase::Complete);
    result
}

#[derive(Debug, thiserror::Error)]
#[error("{cause}")]
pub struct TransactionFailure {
    #[source]
    pub cause: Box<dyn Error>,
    pub rollback_failure: Box<dyn Error>,
}

pub fn get_transaction_rollback_failure<'a>(
    error: &'a (dyn Error + 'static),
) -> Option<&'a (dyn Error + 'static)> {
    error
        .downcast_ref::<TransactionFailure>()
        .map(|error| error.rollback_failure.as_ref())
}

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct QueryFailure(#[source] pub Box<dyn Error>);

pub fn run_query<T, E: Into<Box<dyn Error>>>(
    work: impl FnOnce() -> Result<T, E>,
) -> LedgerResult<T> {
    work().map_err(|error| Box::new(QueryFailure(as_error(error))) as Box<dyn Error>)
}

pub fn is_query_failure(error: &(dyn Error + 'static)) -> bool {
    error.is::<QueryFailure>()
        || error
            .downcast_ref::<TransactionFailure>()
            .is_some_and(|error| is_query_failure(error.cause.as_ref()))
}

pub fn as_error(error: impl Into<Box<dyn Error>>) -> Box<dyn Error> {
    match error.into().downcast::<rusqlite::Error>() {
        Ok(error) => Box::new(SqliteError::new(*error)),
        Err(error) => error,
    }
}

#[derive(Debug, Clone)]
pub struct SqliteError(Rc<rusqlite::Error>);

impl SqliteError {
    pub fn new(error: rusqlite::Error) -> Self {
        Self(Rc::new(error))
    }
}

impl fmt::Display for SqliteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.0.as_ref() {
            rusqlite::Error::SqlInputError { msg, .. } => formatter.write_str(msg),
            rusqlite::Error::SqliteFailure(error, Some(msg))
                if error.extended_code & 0xff == ffi::SQLITE_CANTOPEN
                    && msg.starts_with("unable to open database file: ") =>
            {
                formatter.write_str("unable to open database file")
            }
            _ => self.0.fmt(formatter),
        }
    }
}

impl Error for SqliteError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.0.as_ref())
    }
}

impl DiagnosticError for SqliteError {
    fn diagnostic_metadata(&self) -> ErrorMetadata<'_> {
        let code = match self.0.as_ref() {
            rusqlite::Error::SqlInputError { error, .. }
            | rusqlite::Error::SqliteFailure(error, _) => Some(error.extended_code),
            _ => None,
        };
        ErrorMetadata {
            name: if code.is_some() {
                "SQLiteError"
            } else {
                "Error"
            },
            code: code.and_then(sqlite_code_name),
        }
    }
}
