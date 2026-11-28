use std::cell::{Cell, RefCell};
use std::fs;
use std::path::{Path, PathBuf};
use std::rc::Rc;

use garcon_base::ticket_error::TicketDomainError;
use garcon_contract::{
    error_codes::ErrorCode,
    ticket_commands::{HttpTicketMutationRequest, parse_http_ticket_mutation_request},
    tickets::TicketWriteResult,
};
use garcon_js::clock::ManualClock;
use garcon_stores::{
    private_sqlite::configure_durable_sqlite,
    tickets::{
        Facet,
        contracts::{TicketCaller, TicketPrincipal, derive_ticket_caller},
        errors::MissingChatAuthority,
        service::{TicketService, TicketServiceOptions},
        store::{TicketStore, TicketStoreOptions},
    },
};
use rusqlite::Connection;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn caller(from_chat: Option<&str>) -> TicketCaller {
    derive_ticket_caller(
        TicketPrincipal::Authenticated {
            key: "fixture-owner",
            username: "fixture-user",
        },
        from_chat,
    )
    .unwrap()
}

fn options() -> TicketServiceOptions {
    TicketServiceOptions {
        chat_exists: None,
        commands_enabled: Rc::new(|| true),
        on_invalidated: None,
        clock: Rc::new(ManualClock::new(1_735_776_000_000)),
    }
}

fn service(path: &Path) -> TicketService {
    TicketService::new(
        TicketStore::open(path, TicketStoreOptions::default()).unwrap(),
        options(),
    )
}

fn request(
    store_id: &str,
    number: u64,
    payload: Value,
    from_chat: Option<&str>,
) -> HttpTicketMutationRequest {
    let mut value = json!({"requestId":format!("00000000-0000-4000-8000-{number:012}"), "expectedStoreId":store_id,"payload":payload});
    if let Some(id) = from_chat {
        value["fromChatId"] = json!(id);
    }
    parse_http_ticket_mutation_request(&value).unwrap()
}

fn create_payload() -> Value {
    json!({"action":"create","input":{"title":"Fixture","project":"project"}})
}

fn write(service: &TicketService, number: u64, payload: Value) -> TicketWriteResult {
    service
        .execute_http(
            request(service.store_id(), number, payload, None),
            caller(None),
            &CancellationToken::new(),
        )
        .unwrap()
}

fn code(error: Box<dyn std::error::Error>) -> ErrorCode {
    error
        .downcast_ref::<TicketDomainError>()
        .unwrap()
        .code
        .into()
}

fn oracle(mode: &str, path: &Path) -> Value {
    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/tickets_oracle.ts");
    let output = std::process::Command::new("bun")
        .arg(script)
        .arg(mode)
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    garcon_js::json::from_slice(&output.stdout).unwrap()
}

#[test]
fn original_and_rust_read_and_write_the_same_ticket_store_and_operation_log() {
    let root = tempfile::tempdir().unwrap();
    let seeded = oracle("seed", root.path());
    let tickets = service(root.path());
    let first = write(
        &tickets,
        1,
        json!({"action":"create","input":{"title":"Bun ticket","project":"project",
        "labels":["beta","alpha"],"assignee":{"kind":"user","ownerKey":"fixture-owner"}}}),
    );
    assert_eq!(serde_json::to_value(&first).unwrap(), seeded["created"]);
    assert_eq!(tickets.list(&json!({})).unwrap().items.len(), 1);
    let first_comment = write(
        &tickets,
        2,
        json!({"action":"comment","ticketId":"G-1","body":"Original comment"}),
    );
    assert_eq!(
        serde_json::to_value(first_comment).unwrap(),
        seeded["comment"]
    );

    let second = write(
        &tickets,
        3,
        json!({"action":"create","input":{"title":"Rust ticket","project":"project","parentId":"G-1"}}),
    );
    let closed = write(
        &tickets,
        4,
        json!({"action":"close","ticketId":"G-1","expectedRevision":1,"comment":"Rust closure"}),
    );
    assert_eq!(second.ticket.number, 2);
    let detail = tickets
        .read(&json!({"ticketId":"G-1"}), &caller(None).authority)
        .unwrap();
    let history = tickets.history(&json!({"ticketId":"G-1"})).unwrap();
    let list = tickets.list(&json!({"includeClosed":true})).unwrap();
    let facets = tickets.facets(Facet::Label, "a").unwrap();
    tickets.close();

    let observed = oracle("read-and-write", root.path());
    for (key, expected) in [
        ("created", serde_json::to_value(second).unwrap()),
        ("closed", serde_json::to_value(closed).unwrap()),
        ("detail", serde_json::to_value(detail).unwrap()),
        ("history", serde_json::to_value(history).unwrap()),
        ("list", serde_json::to_value(list).unwrap()),
        ("facets", serde_json::to_value(facets).unwrap()),
    ] {
        assert_eq!(expected, observed[key], "{key}");
    }
    let reopened = service(root.path());
    let params = json!({"action":"link","ticketId":"G-1","expectedRevision":2,"targetId":"G-2","targetRevision":1,"kind":"related"});
    assert_eq!(
        serde_json::to_value(write(&reopened, 5, params)).unwrap(),
        observed["linked"]
    );
    assert_eq!(
        reopened
            .read(&json!({"ticketId":"G-2"}), &caller(None).authority)
            .unwrap()
            .links
            .len(),
        1
    );
}

fn database_bytes(directory: &Path) -> (Vec<u8>, Vec<u8>) {
    (
        fs::read(directory.join("tickets.sqlite")).unwrap(),
        fs::read(directory.join("tickets.sqlite-wal")).unwrap(),
    )
}

#[test]
fn reaches_missing_authority_after_admission_and_operation_lookup_without_consuming_state() {
    let root = tempfile::tempdir().unwrap();
    let chat = "1000000000000001";
    let payload = json!({"action":"create","input":{"project":"project","title":"Seeded","assignee":{"kind":"chat","chatId":chat}}});
    let first = TicketService::new(
        TicketStore::open(root.path(), TicketStoreOptions::default()).unwrap(),
        TicketServiceOptions {
            chat_exists: Some(Rc::new(move |id| id == chat)),
            ..options()
        },
    );
    let from_chat = request(first.store_id(), 1, payload.clone(), Some(chat));
    let signal = CancellationToken::new();
    let created = first
        .execute_http(from_chat.clone(), caller(Some(chat)), &signal)
        .unwrap();
    first.close();

    let allow_commands = Rc::new(Cell::new(true));
    let events = Rc::new(RefCell::new(Vec::new()));
    let tickets = TicketService::new(
        TicketStore::open(root.path(), TicketStoreOptions::default()).unwrap(),
        TicketServiceOptions {
            commands_enabled: Rc::new({
                let flag = allow_commands.clone();
                move || flag.get()
            }),
            on_invalidated: Some(Rc::new({
                let events = events.clone();
                move |revision| {
                    events.borrow_mut().push(revision);
                    Ok(())
                }
            })),
            ..options()
        },
    );
    assert_eq!(
        tickets
            .execute_http(from_chat.clone(), caller(Some(chat)), &signal)
            .unwrap(),
        created
    );
    let conflicting = request(tickets.store_id(), 1, create_payload(), Some(chat));
    assert_eq!(
        code(
            tickets
                .execute_http(conflicting, caller(Some(chat)), &signal)
                .unwrap_err()
        ),
        ErrorCode::TICKET_REQUEST_CONFLICT
    );
    let stale = request(
        "00000000-0000-4000-8000-000000000000",
        2,
        payload.clone(),
        Some(chat),
    );
    assert_eq!(
        code(
            tickets
                .execute_http(stale, caller(Some(chat)), &signal)
                .unwrap_err()
        ),
        ErrorCode::TICKET_STORE_CHANGED
    );
    allow_commands.set(false);
    assert_eq!(
        code(
            tickets
                .execute_http(from_chat, caller(Some(chat)), &signal)
                .unwrap_err()
        ),
        ErrorCode::TICKET_COMMANDS_DISABLED
    );
    allow_commands.set(true);

    let before = database_bytes(root.path());
    for from_chat in [None, Some(chat)] {
        let deferred = request(tickets.store_id(), 2, payload.clone(), from_chat);
        assert!(
            tickets
                .execute_http(deferred, caller(from_chat), &signal)
                .unwrap_err()
                .is::<MissingChatAuthority>()
        );
        assert_eq!(database_bytes(root.path()), before);
    }
    assert!(events.borrow().is_empty());
    let next = write(&tickets, 2, create_payload());
    assert_eq!(next.ticket.number, 2);
    assert_eq!(*events.borrow(), [2]);
}

#[test]
fn failed_commit_rolls_back_ticket_comment_activity_and_retry_record_and_fences_the_connection() {
    let root = tempfile::tempdir().unwrap();
    let fail = Rc::new(Cell::new(false));
    let store = TicketStore::open(
        root.path(),
        TicketStoreOptions {
            before_commit: Some(Box::new({
                let flag = fail.clone();
                move || {
                    if flag.get() {
                        Err("synthetic commit failure".into())
                    } else {
                        Ok(())
                    }
                }
            })),
            ..Default::default()
        },
    )
    .unwrap();
    let tickets = TicketService::new(store, options());
    let first = write(&tickets, 1, create_payload());
    let close = request(
        tickets.store_id(),
        2,
        json!({"action":"close","ticketId":"G-1","expectedRevision":1,"comment":"Atomic close"}),
        None,
    );
    let signal = CancellationToken::new();
    fail.set(true);
    assert_eq!(
        code(
            tickets
                .execute_http(close.clone(), caller(None), &signal)
                .unwrap_err()
        ),
        ErrorCode::TICKET_STORAGE_UNAVAILABLE
    );
    assert_eq!(
        code(tickets.list(&json!({})).unwrap_err()),
        ErrorCode::TICKET_STORAGE_UNAVAILABLE
    );

    let reopened = service(root.path());
    let detail = reopened
        .read(&json!({"ticketId":"G-1"}), &caller(None).authority)
        .unwrap();
    assert_eq!(detail.ticket.revision, first.ticket.revision);
    assert!(detail.comments.items.is_empty());
    assert_eq!(
        reopened
            .history(&json!({"ticketId":"G-1"}))
            .unwrap()
            .items
            .len(),
        1
    );
    assert!(
        reopened
            .execute_http(close, caller(None), &signal)
            .unwrap()
            .comment
            .is_some()
    );
    assert_eq!(
        reopened
            .history(&json!({"ticketId":"G-1"}))
            .unwrap()
            .items
            .len(),
        3
    );
}

fn verify_version_and_journal(database: &Connection, version: i64, journal: &str) {
    assert_eq!(
        database
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        version
    );
    assert_eq!(
        database
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap(),
        journal
    );
}

#[test]
fn exhausted_collection_counter_rolls_back_all_secondary_writes() {
    let root = tempfile::tempdir().unwrap();
    let original = service(root.path());
    write(&original, 1, create_payload());
    original.close();
    Connection::open(root.path().join("tickets.sqlite"))
        .unwrap()
        .execute_batch("UPDATE ticket_meta SET revision=9007199254740990;")
        .unwrap();
    let tickets = service(root.path());
    let request = request(
        tickets.store_id(),
        2,
        json!({"action":"close","ticketId":"G-1","expectedRevision":1,"comment":"Must not survive"}),
        None,
    );
    let error = tickets
        .execute_http(request, caller(None), &CancellationToken::new())
        .unwrap_err();
    assert_eq!(code(error), ErrorCode::TICKET_LIMIT_REACHED);
    let detail = tickets
        .read(&json!({"ticketId":"G-1"}), &caller(None).authority)
        .unwrap();
    assert_eq!(detail.ticket.revision, 1);
    assert!(detail.comments.items.is_empty());
    assert_eq!(
        tickets
            .history(&json!({"ticketId":"G-1"}))
            .unwrap()
            .items
            .len(),
        1
    );
}

#[test]
fn fences_a_missing_or_extra_canonical_label_without_repairing_the_database() {
    for sql in [
        "DELETE FROM ticket_labels",
        "INSERT INTO ticket_labels VALUES (1, 'Unexpected')",
    ] {
        let root = tempfile::tempdir().unwrap();
        let tickets = service(root.path());
        write(
            &tickets,
            1,
            json!({"action":"create","input":{"title":"Fixture","project":"project","labels":["Canonical"]}}),
        );
        tickets.close();
        let path = root.path().join("tickets.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(sql).unwrap();
        drop(db);
        let original = fs::read(&path).unwrap();
        assert_eq!(
            code(
                TicketStore::open(root.path(), TicketStoreOptions::default())
                    .err()
                    .unwrap()
            ),
            ErrorCode::TICKET_STORAGE_UNAVAILABLE
        );
        assert_eq!(fs::read(path).unwrap(), original);
    }
}

#[test]
fn rejects_parent_and_blocking_cycles_without_consuming_revisions() {
    let root = tempfile::tempdir().unwrap();
    let tickets = service(root.path());
    write(&tickets, 1, create_payload());
    write(
        &tickets,
        2,
        json!({"action":"create","input":{"title":"Child","project":"project","parentId":"G-1"}}),
    );
    write(
        &tickets,
        3,
        json!({"action":"link","ticketId":"G-1","expectedRevision":1,"targetId":"G-2","targetRevision":1,"kind":"blocks"}),
    );
    for payload in [
        json!({"action":"update","ticketId":"G-1","expectedRevision":2,"patch":{"parentId":"G-2"}}),
        json!({"action":"link","ticketId":"G-2","expectedRevision":2,"targetId":"G-1","targetRevision":2,"kind":"blocks"}),
    ] {
        let request = request(tickets.store_id(), 4, payload, None);
        let error = tickets
            .execute_http(request, caller(None), &CancellationToken::new())
            .unwrap_err();
        assert_eq!(code(error), ErrorCode::TICKET_RELATIONSHIP_CYCLE);
    }
    let detail = tickets
        .read(&json!({"ticketId":"G-1"}), &caller(None).authority)
        .unwrap();
    assert_eq!(detail.ticket.parent_id, None);
    assert_eq!(detail.ticket.revision, 2);
    assert_eq!(detail.links.len(), 1);
    assert_eq!(detail.version.collection_revision, 3);
}

#[test]
fn rejects_unrecognized_storage_without_altering_the_original_journal_or_tables() {
    for version in [0, 1, 99] {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("tickets.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(&format!("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('Synthetic'); PRAGMA user_version={version};")).unwrap();
        drop(db);
        assert_eq!(
            code(
                TicketStore::open(root.path(), TicketStoreOptions::default())
                    .err()
                    .unwrap()
            ),
            ErrorCode::TICKET_STORAGE_UNAVAILABLE
        );
        let db = Connection::open(path).unwrap();
        verify_version_and_journal(&db, version, "delete");
        assert_eq!(
            db.query_row("SELECT value FROM unrelated", [], |row| row
                .get::<_, String>(0))
                .unwrap(),
            "Synthetic"
        );
    }
    assert!(
        configure_durable_sqlite(&Connection::open_in_memory().unwrap())
            .unwrap_err()
            .to_string()
            .contains("Unsupported SQLite durability configuration.")
    );
}

#[cfg(unix)]
#[test]
fn secures_database_and_sidecars_and_fences_replaced_or_symlinked_files() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("tickets.sqlite");
    let moved = root.path().join("moved.sqlite");
    let actual_error = garcon_stores::private_sqlite::open_private_sqlite_database(&path, || {
        fs::rename(&path, &moved)?;
        Connection::open(&path)?.execute_batch("CREATE TABLE unrelated(value TEXT);")?;
        Ok(())
    })
    .err()
    .unwrap();
    assert_eq!(
        actual_error.to_string(),
        "SQLite database was replaced while opening."
    );
    verify_version_and_journal(&Connection::open(path).unwrap(), 0, "delete");
    verify_version_and_journal(&Connection::open(moved).unwrap(), 0, "delete");

    let trusted = tempfile::tempdir().unwrap();
    let store = TicketStore::open(trusted.path(), TicketStoreOptions::default()).unwrap();
    for suffix in ["", "-wal", "-shm"] {
        let source = trusted.path().join(format!("tickets.sqlite{suffix}"));
        assert_eq!(
            fs::metadata(&source).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::set_permissions(&source, fs::Permissions::from_mode(0o666)).unwrap();
        let other = tempfile::tempdir().unwrap();
        symlink(
            &source,
            other.path().join(format!("tickets.sqlite{suffix}")),
        )
        .unwrap();
        assert!(TicketStore::open(other.path(), TicketStoreOptions::default()).is_err());
        assert_eq!(
            fs::metadata(&source).unwrap().permissions().mode() & 0o777,
            0o666
        );
    }
    let reopened = TicketStore::open(trusted.path(), TicketStoreOptions::default()).unwrap();
    assert_eq!(reopened.store_id(), store.store_id());
    for suffix in ["", "-wal", "-shm"] {
        assert_eq!(
            fs::metadata(trusted.path().join(format!("tickets.sqlite{suffix}")))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
