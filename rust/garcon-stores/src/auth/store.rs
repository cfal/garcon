use std::cell::RefCell;
use std::error::Error;
use std::io;
use std::rc::Rc;

use garcon_base::domain_error::DomainError;
use garcon_base::json_file_store::{JsonFileStore, JsonWriteOptions, WriteFileError};
use garcon_base::keyed_lock::KeyedLock;
use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_contract::error_codes::ErrorCode;
use garcon_js::{Clock, is_safe_integer, json::as_number, path::native};
use serde::Serialize;
use serde_json::{Value, json};

use super::sessions::{AUTH_SESSION_LIMIT, AuthBrowserSession, parse_stored_sessions};

type BoxError = Box<dyn Error>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthAccount {
    pub owner_key: String,
    pub credential_revision: u64,
    pub username: String,
    pub password_hash: String,
    pub created_at: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSnapshot {
    pub jwt_secret: String,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub account: Option<AuthAccount>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthChange {
    Credentials,
    Sessions,
    StorageUnavailable,
}

#[derive(Debug, thiserror::Error)]
#[error("Credentials changed")]
pub struct AuthSnapshotChangedError;

pub fn account_already_configured() -> DomainError {
    DomainError::new(
        ErrorCode::VALIDATION_FAILED,
        "Account already configured",
        409,
        false,
    )
}

struct ParsedAuth {
    jwt_secret: Option<String>,
    account: Option<AuthAccount>,
    initialize: bool,
}

fn parse_stored_auth(value: &Value) -> Result<ParsedAuth, BoxError> {
    const ACCOUNT_FIELDS: [&str; 5] = [
        "username",
        "passwordHash",
        "createdAt",
        "ownerKey",
        "credentialRevision",
    ];
    let record = value.as_object().ok_or("Auth state must be an object")?;
    if record
        .keys()
        .any(|key| key != "jwtSecret" && !ACCOUNT_FIELDS.contains(&key.as_str()))
    {
        return Err("Unknown auth state fields".into());
    }
    let nonempty = |key| {
        record
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    let jwt_secret = nonempty("jwtSecret");
    if record.contains_key("jwtSecret") && jwt_secret.is_none() {
        return Err("Invalid auth secret".into());
    }
    if !ACCOUNT_FIELDS.iter().any(|key| record.contains_key(*key)) {
        return Ok(ParsedAuth {
            jwt_secret: jwt_secret.map(str::to_owned),
            account: None,
            initialize: jwt_secret.is_none(),
        });
    }
    let incomplete = "Incomplete auth account";
    let jwt_secret = jwt_secret.ok_or(incomplete)?;
    let username = nonempty("username").ok_or(incomplete)?;
    let password_hash = nonempty("passwordHash").ok_or(incomplete)?;
    let created_at = match record.get("createdAt") {
        None | Some(Value::Null) => None,
        Some(Value::String(date)) => Some(date.clone()),
        _ => return Err(incomplete.into()),
    };
    let initialize = !record.contains_key("ownerKey") && !record.contains_key("credentialRevision");
    let (owner_key, revision) = if initialize {
        (username, 1.0)
    } else {
        let invalid = "Invalid auth identity";
        let owner_key = nonempty("ownerKey").ok_or(invalid)?;
        let revision = record
            .get("credentialRevision")
            .and_then(as_number)
            .filter(|revision| is_safe_integer(*revision) && *revision >= 1.0)
            .ok_or(invalid)?;
        (owner_key, revision)
    };
    Ok(ParsedAuth {
        jwt_secret: Some(jwt_secret.into()),
        account: Some(AuthAccount {
            owner_key: owner_key.into(),
            username: username.into(),
            credential_revision: revision as u64,
            password_hash: password_hash.into(),
            created_at,
        }),
        initialize,
    })
}

pub(super) fn random_hex() -> io::Result<String> {
    let mut bytes = [0; 32];
    getrandom::fill(&mut bytes).map_err(|error| io::Error::other(error.to_string()))?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(64);
    for byte in bytes {
        result.push(char::from(HEX[usize::from(byte >> 4)]));
        result.push(char::from(HEX[usize::from(byte & 0xf)]));
    }
    Ok(result)
}

/// Distinguishes a definite failure from a write that could already be durable.
#[derive(Debug)]
pub struct AuthWriteFailure {
    pub renamed: bool,
}

#[async_trait::async_trait(?Send)]
pub trait AuthWriter {
    async fn write(&self, path: &str, value: &Value) -> Result<(), AuthWriteFailure>;
}

#[async_trait::async_trait(?Send)]
impl AuthWriter for JsonFileStore {
    async fn write(&self, path: &str, value: &Value) -> Result<(), AuthWriteFailure> {
        self.write_json_file_atomic(
            path,
            value,
            JsonWriteOptions {
                mode: Some(0o600),
                ..Default::default()
            },
        )
        .await
        .map_err(|error| AuthWriteFailure {
            renamed: matches!(error, WriteFileError::Atomic(error) if error.renamed),
        })
    }
}

struct StoredState {
    snapshot: Rc<AuthSnapshot>,
    sessions: Vec<AuthBrowserSession>,
    unavailable: bool,
}

type AuthListener = Rc<dyn Fn(AuthChange) -> Result<(), BoxError>>;

pub struct AuthAccountStore {
    file_path: String,
    pub sessions_file_path: String,
    state: RefCell<StoredState>,
    lock: KeyedLock,
    writer: Rc<dyn AuthWriter>,
    clock: Rc<dyn Clock>,
    listeners: RefCell<Vec<AuthListener>>,
    logger: ScopedLogger,
}

impl AuthAccountStore {
    pub async fn open(config_dir: &str, clock: Rc<dyn Clock>) -> Result<Rc<Self>, BoxError> {
        let file_path = native::join(&[config_dir, "auth.json"]);
        Self::open_with_writer(file_path, clock, Rc::new(JsonFileStore::default())).await
    }

    pub async fn open_with_writer(
        file_path: String,
        clock: Rc<dyn Clock>,
        writer: Rc<dyn AuthWriter>,
    ) -> Result<Rc<Self>, BoxError> {
        let sessions_file_path =
            native::join(&[&native::dirname(&file_path), "auth-sessions.json"]);
        let disk = JsonFileStore::default();
        let parsed = disk
            .read_json_state_file(
                &file_path,
                || ParsedAuth {
                    jwt_secret: None,
                    account: None,
                    initialize: true,
                },
                |value| parse_stored_auth(&value),
            )
            .await?;
        let sessions = disk
            .read_json_state_file(&sessions_file_path, Vec::new, |value| {
                Ok(parse_stored_sessions(&value)?)
            })
            .await?;
        let snapshot = Rc::new(AuthSnapshot {
            jwt_secret: match parsed.jwt_secret {
                Some(secret) => secret,
                None => random_hex()?,
            },
            account: parsed.account,
        });
        let store = Rc::new(Self {
            file_path,
            sessions_file_path,
            state: RefCell::new(StoredState {
                snapshot: Rc::clone(&snapshot),
                sessions,
                unavailable: false,
            }),
            lock: KeyedLock::new(),
            writer,
            clock,
            listeners: RefCell::new(Vec::new()),
            logger: create_logger("auth:store"),
        });
        if parsed.initialize {
            store.persist(&snapshot).await?;
        }
        Ok(store)
    }

    pub async fn snapshot(&self) -> Result<Rc<AuthSnapshot>, DomainError> {
        tokio::task::yield_now().await;
        self.assert_healthy()?;
        Ok(Rc::clone(&self.state.borrow().snapshot))
    }

    pub fn assert_healthy(&self) -> Result<(), DomainError> {
        if self.is_unavailable() {
            Err(DomainError::new(
                ErrorCode::AUTH_STORAGE_UNAVAILABLE,
                "Credential durability is unknown. Resolve storage and restart the controller.",
                503,
                false,
            ))
        } else {
            Ok(())
        }
    }

    pub fn is_unavailable(&self) -> bool {
        self.state.borrow().unavailable
    }

    pub fn is_current(&self, owner_key: &str, revision: u64) -> bool {
        let state = self.state.borrow();
        !state.unavailable
            && state.snapshot.account.as_ref().is_some_and(|account| {
                account.owner_key == owner_key && account.credential_revision == revision
            })
    }

    pub fn is_session_current(
        &self,
        owner_key: &str,
        session_id: &str,
        expires_at_ms: u64,
    ) -> bool {
        let state = self.state.borrow();
        !state.unavailable
            && self.after_now(expires_at_ms)
            && state.sessions.iter().any(|session| {
                session.owner_key == owner_key
                    && session.session_id == session_id
                    && session.expires_at_ms == expires_at_ms
            })
    }

    pub fn on_change(&self, listener: AuthListener) -> impl FnOnce() + '_ {
        let mut listeners = self.listeners.borrow_mut();
        if !listeners.iter().any(|other| Rc::ptr_eq(other, &listener)) {
            listeners.push(Rc::clone(&listener));
        }
        move || {
            self.listeners
                .borrow_mut()
                .retain(|other| !Rc::ptr_eq(other, &listener))
        }
    }

    pub async fn open_session<T>(
        &self,
        expected: &Rc<AuthSnapshot>,
        prepare: impl FnOnce() -> Result<(AuthBrowserSession, T), BoxError>,
    ) -> Result<T, BoxError> {
        self.lock
            .run_exclusive(
                &self.file_path,
                || async {
                    self.assert_snapshot(expected)?;
                    let (session, result) = prepare()?;
                    self.add_session(session).await?;
                    Ok(result)
                },
                None,
            )
            .await?
    }

    pub async fn register<T>(
        &self,
        expected: &Rc<AuthSnapshot>,
        prepare: impl FnOnce() -> Result<(AuthAccount, AuthBrowserSession, T), BoxError>,
    ) -> Result<T, BoxError> {
        self.lock
            .run_exclusive(
                &self.file_path,
                || async {
                    self.assert_snapshot(expected)?;
                    let (account, session, result) = prepare()?;
                    let candidate = Rc::new(AuthSnapshot {
                        jwt_secret: expected.jwt_secret.clone(),
                        account: Some(account),
                    });
                    self.add_session(session).await?;
                    self.persist(&candidate).await?;
                    self.state.borrow_mut().snapshot = candidate;
                    self.publish(AuthChange::Credentials);
                    Ok(result)
                },
                None,
            )
            .await?
    }

    pub async fn commit<T>(
        &self,
        expected: &Rc<AuthSnapshot>,
        prepare: impl FnOnce() -> Result<(AuthAccount, T), BoxError>,
    ) -> Result<T, BoxError> {
        self.lock
            .run_exclusive(
                &self.file_path,
                || async {
                    self.assert_snapshot(expected)?;
                    let (account, result) = prepare()?;
                    let candidate = Rc::new(AuthSnapshot {
                        jwt_secret: expected.jwt_secret.clone(),
                        account: Some(account),
                    });
                    self.persist(&candidate).await?;
                    self.state.borrow_mut().snapshot = candidate;
                    self.publish(AuthChange::Credentials);
                    Ok(result)
                },
                None,
            )
            .await?
    }

    pub async fn revoke_session(&self, owner_key: &str, session_id: &str) -> Result<(), BoxError> {
        self.lock
            .run_exclusive(
                &self.file_path,
                || async {
                    self.assert_healthy()?;
                    let candidate = {
                        let state = self.state.borrow();
                        if !state
                            .snapshot
                            .account
                            .as_ref()
                            .is_some_and(|account| account.owner_key == owner_key)
                        {
                            return Err(DomainError::new(
                                ErrorCode::AUTH_SESSION_INVALID,
                                "Invalid session.",
                                401,
                                false,
                            )
                            .into());
                        }
                        if !state
                            .sessions
                            .iter()
                            .any(|session| session.session_id == session_id)
                        {
                            return Ok(());
                        }
                        state
                            .sessions
                            .iter()
                            .filter(|session| {
                                session.session_id != session_id
                                    && self.after_now(session.expires_at_ms)
                            })
                            .cloned()
                            .collect()
                    };
                    self.persist_sessions(candidate).await?;
                    self.publish(AuthChange::Sessions);
                    Ok(())
                },
                None,
            )
            .await?
    }

    async fn add_session(&self, session: AuthBrowserSession) -> Result<(), BoxError> {
        let mut candidate: Vec<_> = self
            .state
            .borrow()
            .sessions
            .iter()
            .filter(|entry| self.after_now(entry.expires_at_ms))
            .cloned()
            .collect();
        if candidate.len() >= AUTH_SESSION_LIMIT {
            return Err(DomainError::new(
                ErrorCode::AUTH_BUSY,
                "Too many active browser sessions. Log out an existing session or wait for it to expire.",
                429, false,
            ).into());
        }
        if candidate
            .iter()
            .any(|existing| existing.session_id == session.session_id)
        {
            return Err("Duplicate auth session".into());
        }
        candidate.push(session);
        self.persist_sessions(candidate).await
    }

    async fn persist_sessions(&self, candidate: Vec<AuthBrowserSession>) -> Result<(), BoxError> {
        let data = json!({ "version": 1, "sessions": &candidate });
        match self.writer.write(&self.sessions_file_path, &data).await {
            Ok(()) => self.state.borrow_mut().sessions = candidate,
            Err(error) if error.renamed => {
                self.state.borrow_mut().sessions = candidate;
                self.mark_unavailable(
                    "Session write durability is unknown; browser authentication fenced.",
                );
                self.assert_healthy()?;
            }
            Err(_) => {
                return Err(DomainError::new(
                    ErrorCode::AUTH_SAVE_FAILED,
                    "The session change could not be saved.",
                    500,
                    false,
                )
                .into());
            }
        }
        Ok(())
    }

    async fn persist(&self, candidate: &Rc<AuthSnapshot>) -> Result<(), BoxError> {
        let data = serde_json::to_value(&**candidate)?;
        match self.writer.write(&self.file_path, &data).await {
            Ok(()) => Ok(()),
            Err(error) if error.renamed => {
                self.state.borrow_mut().snapshot = Rc::clone(candidate);
                self.mark_unavailable(
                    "Auth write durability is unknown; browser authentication fenced.",
                );
                self.assert_healthy().map_err(Into::into)
            }
            Err(_) => {
                self.logger.error("Auth write failed before publication.");
                Err(DomainError::new(
                    ErrorCode::AUTH_SAVE_FAILED,
                    "Credentials were not changed.",
                    500,
                    false,
                )
                .into())
            }
        }
    }

    fn after_now(&self, expires_at_ms: u64) -> bool {
        i128::from(expires_at_ms) > i128::from(self.clock.now_ms())
    }

    fn assert_snapshot(&self, expected: &Rc<AuthSnapshot>) -> Result<(), BoxError> {
        self.assert_healthy()?;
        if !Rc::ptr_eq(&self.state.borrow().snapshot, expected) {
            return Err(AuthSnapshotChangedError.into());
        }
        Ok(())
    }

    fn mark_unavailable(&self, message: &str) {
        self.state.borrow_mut().unavailable = true;
        self.publish(AuthChange::StorageUnavailable);
        self.logger.error(message);
    }

    fn publish(&self, change: AuthChange) {
        let listeners = self.listeners.borrow().clone();
        for listener in listeners {
            if listener(change).is_err() {
                self.logger.error("Browser authorization cleanup failed.");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::path::Path;

    use garcon_js::{ManualClock, json::from_slice};
    use tokio::fs;

    use super::*;

    fn account() -> AuthAccount {
        AuthAccount {
            owner_key: "fixture-owner".into(),
            credential_revision: 1,
            username: "fixture-owner".into(),
            password_hash: "fixture-hash".into(),
            created_at: None,
        }
    }

    fn session(character: char, expires_at_ms: u64) -> AuthBrowserSession {
        AuthBrowserSession {
            session_id: character.to_string().repeat(64),
            owner_key: "fixture-owner".into(),
            expires_at_ms,
        }
    }

    async fn disk_json(file: impl AsRef<Path>) -> Value {
        let bytes = fs::read(file).await.unwrap();
        from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn persists_secret_and_upgrades_a_legacy_account_without_changing_its_authority() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().to_str().unwrap();
        let file = root.path().join("auth.json");
        let clock = Rc::new(ManualClock::new(1000));
        let fresh = AuthAccountStore::open(dir, clock.clone()).await.unwrap();
        let initial = fresh.snapshot().await.unwrap();
        assert!(initial.account.is_none());
        assert_eq!(initial.jwt_secret.len(), 64);
        assert_eq!(
            disk_json(&file).await,
            json!({"jwtSecret": initial.jwt_secret})
        );
        fs::write(
            &file,
            br#"{"jwtSecret":"fixture","username":"fixture-owner","passwordHash":"fixture-hash"}"#,
        )
        .await
        .unwrap();
        let migrated = AuthAccountStore::open(dir, clock).await.unwrap();
        assert!(migrated.is_current("fixture-owner", 1));
        assert_eq!(
            disk_json(&file).await,
            json!({
                "jwtSecret":"fixture", "ownerKey":"fixture-owner", "credentialRevision":1,
                "username":"fixture-owner", "passwordHash":"fixture-hash", "createdAt":null,
            })
        );
        #[cfg(unix)]
        garcon_base::private_file::assert_private_file(&file)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn each_login_has_a_unique_durable_session_and_revocation_survives_restart() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().to_str().unwrap();
        let clock = Rc::new(ManualClock::new(1000));
        let store = AuthAccountStore::open(dir, clock.clone()).await.unwrap();
        let first = session('a', 50_000);
        let second = session('b', 50_000);
        store
            .register(&store.snapshot().await.unwrap(), || {
                Ok((account(), first.clone(), ()))
            })
            .await
            .unwrap();
        let snapshot = store.snapshot().await.unwrap();
        store
            .open_session(&snapshot, || Ok((second.clone(), ())))
            .await
            .unwrap();
        assert!(store.is_session_current(&first.owner_key, &first.session_id, first.expires_at_ms));
        let identical_fields = Rc::new((*snapshot).clone());
        let error = store
            .open_session(&identical_fields, || Ok((session('c', 50_000), ())))
            .await
            .unwrap_err();
        assert!(error.is::<AuthSnapshotChangedError>());
        #[cfg(unix)]
        garcon_base::private_file::assert_private_file(&store.sessions_file_path)
            .await
            .unwrap();
        store
            .revoke_session(&first.owner_key, &first.session_id)
            .await
            .unwrap();
        let restarted = AuthAccountStore::open(dir, clock).await.unwrap();
        assert!(!restarted.is_session_current(
            &first.owner_key,
            &first.session_id,
            first.expires_at_ms
        ));
        assert!(restarted.is_session_current(
            &second.owner_key,
            &second.session_id,
            second.expires_at_ms
        ));
        restarted
            .revoke_session(&first.owner_key, &first.session_id)
            .await
            .unwrap();
        assert_eq!(
            disk_json(&restarted.sessions_file_path).await["sessions"],
            json!([second])
        );
    }

    struct FixtureWriter {
        failure: Cell<Option<bool>>,
    }

    #[async_trait::async_trait(?Send)]
    impl AuthWriter for FixtureWriter {
        async fn write(&self, path: &str, value: &Value) -> Result<(), AuthWriteFailure> {
            if let Some(renamed) = self.failure.get()
                && path.ends_with("auth-sessions.json")
            {
                if renamed {
                    JsonFileStore::default().write(path, value).await?;
                }
                return Err(AuthWriteFailure { renamed });
            }
            JsonFileStore::default().write(path, value).await
        }
    }

    #[tokio::test]
    async fn registry_failures_preserve_definite_versus_uncertain_logout() {
        for renamed in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let file = root.path().join("auth.json");
            let clock = Rc::new(ManualClock::new(1000));
            let writer = Rc::new(FixtureWriter {
                failure: Cell::new(None),
            });
            let store = AuthAccountStore::open_with_writer(
                file.to_string_lossy().into_owned(),
                clock.clone(),
                writer.clone(),
            )
            .await
            .unwrap();
            let first = session('a', 50_000);
            store
                .register(&store.snapshot().await.unwrap(), || {
                    Ok((account(), first.clone(), ()))
                })
                .await
                .unwrap();
            let observed = Rc::new(RefCell::new(Vec::new()));
            let events = Rc::clone(&observed);
            let stop = store.on_change(Rc::new(move |event| {
                events.borrow_mut().push(event);
                Ok(())
            }));
            writer.failure.set(Some(renamed));
            let error = store
                .revoke_session(&first.owner_key, &first.session_id)
                .await
                .unwrap_err();
            let code = error.downcast_ref::<DomainError>().unwrap().code;
            assert_eq!(
                code,
                if renamed {
                    ErrorCode::AUTH_STORAGE_UNAVAILABLE
                } else {
                    ErrorCode::AUTH_SAVE_FAILED
                }
            );
            assert_eq!(store.is_unavailable(), renamed);
            assert_eq!(
                store.is_session_current(&first.owner_key, &first.session_id, first.expires_at_ms),
                !renamed
            );
            let restarted = AuthAccountStore::open(root.path().to_str().unwrap(), clock)
                .await
                .unwrap();
            assert_eq!(
                restarted.is_session_current(
                    &first.owner_key,
                    &first.session_id,
                    first.expires_at_ms
                ),
                !renamed
            );
            assert_eq!(
                &*observed.borrow(),
                if renamed {
                    &[AuthChange::StorageUnavailable][..]
                } else {
                    &[]
                }
            );
            stop();
        }
    }
}
