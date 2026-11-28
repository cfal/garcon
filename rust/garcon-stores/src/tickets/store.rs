//! Synchronous authority for one workspace's ticket database.

use std::cell::RefCell;
use std::path::Path;

use garcon_base::{
    domain_error::is_domain_error,
    errors::{ErrorInput, diagnostic_error_code},
    log::{Logger, create_logger},
};
use garcon_contract::ticket_validation::{MAX_SAFE_TICKET_INTEGER, ticket_uuid};
use rusqlite::{Connection, Transaction, TransactionBehavior};
use serde_json::Value;

use crate::private_sqlite::{
    configure_durable_sqlite, open_private_sqlite_database, secure_private_sqlite_sidecars,
};

use super::errors::{MissingChatAuthority, Result, ticket_storage_unavailable};
use super::schema::TICKET_SCHEMA_V1;

#[derive(Default)]
pub struct TicketStoreOptions {
    pub after_database_open: Option<Box<dyn FnOnce() -> Result<()>>>,
    pub before_commit: Option<Box<dyn Fn() -> Result<()>>>,
}

pub struct TicketStore {
    database: RefCell<Option<Connection>>,
    store_id: String,
    before_commit: Option<Box<dyn Fn() -> Result<()>>>,
}

impl TicketStore {
    pub fn open(workspace_dir: &Path, options: TicketStoreOptions) -> Result<Self> {
        let TicketStoreOptions {
            after_database_open,
            before_commit,
        } = options;
        let path = workspace_dir.join("tickets.sqlite");
        match open(&path, after_database_open) {
            Ok((database, store_id)) => Ok(Self {
                database: RefCell::new(Some(database)),
                store_id,
                before_commit,
            }),
            Err(error) => {
                create_logger("ticket-store").warn(&format!(
                    "Ticket storage open failed. {{ errorCode: {} }}",
                    diagnostic_error_code(ErrorInput::Error(error.as_ref()))
                ));
                Err(ticket_storage_unavailable())
            }
        }
    }

    pub fn store_id(&self) -> &str {
        &self.store_id
    }

    pub fn read<T>(&self, operation: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let result = {
            let database = self.database.borrow();
            let Some(database) = database.as_ref() else {
                return Err(ticket_storage_unavailable());
            };
            operation(database)
        };
        match result {
            Err(error)
                if !is_domain_error(error.as_ref()) && !error.is::<MissingChatAuthority>() =>
            {
                create_logger("ticket-store").warn(&format!(
                    "Ticket storage fenced. {{ errorCode: {} }}",
                    diagnostic_error_code(ErrorInput::Error(error.as_ref()))
                ));
                self.close();
                Err(ticket_storage_unavailable())
            }
            result => result,
        }
    }

    pub fn transaction<T>(&self, operation: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        self.read(|database| {
            let tx = Transaction::new_unchecked(database, TransactionBehavior::Immediate)?;
            let result = operation(&tx)?;
            if let Some(before_commit) = &self.before_commit {
                before_commit()?;
            }
            tx.commit()?;
            Ok(result)
        })
    }

    pub fn close(&self) {
        self.database.take();
    }
}

fn open(
    path: &Path,
    after_database_open: Option<Box<dyn FnOnce() -> Result<()>>>,
) -> Result<(Connection, String)> {
    let database = open_private_sqlite_database(path, || match after_database_open {
        Some(after_open) => after_open(),
        None => Ok(()),
    })?;
    let version = database.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))?;
    match version {
        0 => {
            let count: i64 = database.query_row(
                "SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get(0),
            )?;
            if count != 0 {
                return Err(ticket_storage_unavailable());
            }
        }
        1 => {
            require_ticket_schema(&database)?;
            read_store_id(&database)?;
            require_consistent_labels(&database)?;
        }
        _ => return Err(ticket_storage_unavailable()),
    }
    configure_durable_sqlite(&database)?;
    if version == 0 {
        let tx = Transaction::new_unchecked(&database, TransactionBehavior::Immediate)?;
        tx.execute_batch(&TICKET_SCHEMA_V1.join(";\n"))?;
        tx.execute(
            "INSERT INTO ticket_meta VALUES (1, ?, 0)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        tx.commit()?;
    }
    let store_id = read_store_id(&database)?;
    secure_private_sqlite_sidecars(path)?;
    Ok((database, store_id))
}

fn read_store_id(database: &Connection) -> Result<String> {
    let (id, revision): (String, i64) = database.query_row(
        "SELECT store_id, revision FROM ticket_meta WHERE singleton=1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    if !(0..=MAX_SAFE_TICKET_INTEGER as i64).contains(&revision) {
        return Err("Invalid ticket revision.".into());
    }
    Ok(ticket_uuid(&Value::String(id), "storeId")?.into())
}

fn require_ticket_schema(database: &Connection) -> Result<()> {
    let mut expected: Vec<_> = TICKET_SCHEMA_V1
        .iter()
        .copied()
        .filter(|sql| sql.starts_with("CREATE "))
        .collect();
    expected.sort();
    let mut statement =
        database.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'")?;
    let mut actual: Vec<String> = statement
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    actual.sort();
    if !actual.iter().map(|sql| garcon_js::trim(sql)).eq(expected) {
        return Err("Unrecognized ticket schema.".into());
    }
    let integrity: String = database.query_row("PRAGMA quick_check(1)", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err("Invalid ticket database integrity.".into());
    }
    Ok(())
}

fn require_consistent_labels(database: &Connection) -> Result<()> {
    let mut statement = database.prepare("\n    SELECT 1 AS inconsistent WHERE EXISTS (\n      SELECT ticket_number,label FROM ticket_labels\n      EXCEPT SELECT i.number,j.value FROM tickets i,json_each(i.payload_json,'$.labels') j\n    ) OR EXISTS (\n      SELECT i.number,j.value FROM tickets i,json_each(i.payload_json,'$.labels') j\n      EXCEPT SELECT ticket_number,label FROM ticket_labels\n    )\n  ")?;
    if statement.exists([])? {
        return Err("Inconsistent ticket label index.".into());
    }
    Ok(())
}
