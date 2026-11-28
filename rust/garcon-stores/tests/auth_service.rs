use std::cell::RefCell;
use std::error::Error;
use std::future::ready;
use std::rc::Rc;

use garcon_base::domain_error::DomainError;
use garcon_base::json_file_store::JsonFileStore;
use garcon_contract::error_codes::ErrorCode;
use garcon_js::ManualClock;
use garcon_stores::auth::passwords::Passwords;
use garcon_stores::auth::service::{AuthService, CredentialOperation};
use garcon_stores::auth::store::{AuthAccountStore, AuthWriteFailure, AuthWriter};
use garcon_stores::auth::token::{AuthTokens, VerifiedAuthClaims};
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

type PasswordError = Box<dyn Error>;

struct Gate {
    entered: oneshot::Sender<()>,
    release: oneshot::Receiver<()>,
}

impl Gate {
    async fn wait(self) {
        self.entered.send(()).unwrap();
        self.release.await.unwrap();
    }

    fn install(slot: &RefCell<Option<Self>>) -> (oneshot::Receiver<()>, oneshot::Sender<()>) {
        let (entered, entered_rx) = oneshot::channel();
        let (release_tx, release) = oneshot::channel();
        slot.replace(Some(Self { entered, release }));
        (entered_rx, release_tx)
    }
}

#[derive(Default)]
struct FixturePasswords(RefCell<Option<Gate>>);

#[async_trait::async_trait(?Send)]
impl Passwords for FixturePasswords {
    async fn verify(&self, password: &str, hash: &str) -> Result<bool, PasswordError> {
        let gate = self.0.borrow_mut().take();
        if let Some(gate) = gate {
            gate.wait().await;
        }
        Ok(hash.strip_prefix("fixture:") == Some(password))
    }

    async fn hash(&self, password: &str) -> Result<String, PasswordError> {
        Ok(format!("fixture:{password}"))
    }
}

#[derive(Default)]
struct FixtureWriter {
    gate: RefCell<Option<Gate>>,
    uncertain: std::cell::Cell<bool>,
}

#[async_trait::async_trait(?Send)]
impl AuthWriter for FixtureWriter {
    async fn write(&self, path: &str, value: &Value) -> Result<(), AuthWriteFailure> {
        let gate = self.gate.borrow_mut().take();
        if let Some(gate) = gate {
            gate.wait().await;
        }
        JsonFileStore::default().write(path, value).await?;
        if self.uncertain.get() {
            return Err(AuthWriteFailure { renamed: true });
        }
        Ok(())
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    service: AuthService,
    passwords: Rc<FixturePasswords>,
    writer: Rc<FixtureWriter>,
    cancel: CancellationToken,
}

impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let clock = Rc::new(ManualClock::new(1_700_000_000_000));
        let writer = Rc::new(FixtureWriter::default());
        let store = AuthAccountStore::open_with_writer(
            path.to_string_lossy().into_owned(),
            clock.clone(),
            writer.clone(),
        )
        .await
        .unwrap();
        let passwords = Rc::new(FixturePasswords::default());
        let service = AuthService::new(
            store,
            AuthTokens::new("30d".into(), clock.clone()),
            passwords.clone(),
            clock,
        );
        Self {
            _dir: dir,
            service,
            passwords,
            writer,
            cancel: CancellationToken::new(),
        }
    }

    async fn register(&self) -> VerifiedAuthClaims {
        let response = self.service.register(&login(), &self.cancel).await.unwrap();
        self.service
            .tokens
            .verify_auth_token_claims(&self.service.store, Some(&response.token))
            .await
            .unwrap()
            .unwrap()
    }

    async fn rename(
        &self,
        principal: &VerifiedAuthClaims,
        signal: &CancellationToken,
    ) -> Result<garcon_contract::auth::AuthSessionResponse, Box<dyn Error>> {
        self.service
            .change_credentials(
                CredentialOperation::Username,
                principal,
                ready(Ok(json!({
                    "currentPassword":"password-before", "username":" owner-next ",
                }))),
                signal,
            )
            .await
    }
}

fn login() -> Value {
    json!({"username":"owner-before", "password":"password-before"})
}

fn code(error: &(dyn Error + 'static)) -> ErrorCode {
    error.downcast_ref::<DomainError>().unwrap().code
}

#[tokio::test]
async fn login_verification_straddling_a_commit_cannot_sign_the_new_revision() {
    for uncertain in [false, true] {
        let f = Fixture::new().await;
        let principal = f.register().await;
        let (entered, release) = Gate::install(&f.passwords.0);
        let run_login = async {
            let mut input = login();
            if uncertain {
                input["password"] = json!("wrong-password");
            }
            f.service.login(&input, &f.cancel).await.unwrap_err()
        };
        let rotate = async {
            entered.await.unwrap();
            f.writer.uncertain.set(uncertain);
            let result = f.rename(&principal, &f.cancel).await;
            release.send(()).unwrap();
            result
        };
        let (login, rename) = tokio::join!(run_login, rotate);
        if uncertain {
            assert_eq!(
                code(&*rename.unwrap_err()),
                ErrorCode::AUTH_STORAGE_UNAVAILABLE
            );
            assert_eq!(code(&*login), ErrorCode::AUTH_STORAGE_UNAVAILABLE);
        } else {
            assert_eq!(rename.unwrap().user.username, "owner-next");
            assert_eq!(code(&*login), ErrorCode::AUTH_CREDENTIALS_INVALID);
        }
    }
}

#[tokio::test]
async fn cancelled_verification_retains_admission_until_actual_settlement() {
    let f = Fixture::new().await;
    f.register().await;
    let (first_entered, first_release) = Gate::install(&f.passwords.0);
    let first_signal = CancellationToken::new();
    let input = login();
    let first = f.service.login(&input, &first_signal);
    let controller = async {
        first_entered.await.unwrap();
        let (second_entered, second_release) = Gate::install(&f.passwords.0);
        let second = f.service.login(&input, &f.cancel);
        let try_third = async {
            second_entered.await.unwrap();
            first_signal.cancel();
            let rejected = f.service.login(&input, &f.cancel).await.unwrap_err();
            first_release.send(()).unwrap();
            second_release.send(()).unwrap();
            assert_eq!(code(&*rejected), ErrorCode::AUTH_BUSY);
        };
        let (second, ()) = tokio::join!(second, try_third);
        assert!(second.is_ok());
    };
    let (first, ()) = tokio::join!(first, controller);
    assert_eq!(first.unwrap_err().to_string(), "The operation was aborted.");
}

#[tokio::test]
async fn cancellation_after_persistence_begins_still_publishes_and_retires_authority() {
    let f = Fixture::new().await;
    let principal = f.register().await;
    let (entered, release) = Gate::install(&f.writer.gate);
    let rotate = f.rename(&principal, &f.cancel);
    let blocked = async {
        entered.await.unwrap();
        f.cancel.cancel();
        let no_read = async { panic!("the second body must not be read during a mutation") };
        let error = f
            .service
            .change_credentials(
                CredentialOperation::Password,
                &principal,
                no_read,
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        release.send(()).unwrap();
        assert_eq!(code(&*error), ErrorCode::AUTH_BUSY);
    };
    let (result, ()) = tokio::join!(rotate, blocked);
    let result = result.unwrap();
    assert_eq!(result.user.username, "owner-next");
    assert_eq!(result.user.id, principal.identity.owner_key);
    assert!(!AuthTokens::is_current_browser_principal(
        &f.service.store,
        &principal
    ));
    let new = f
        .service
        .tokens
        .verify_auth_token_claims(&f.service.store, Some(&result.token))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(new.identity.credential_revision, 2);
    assert_eq!(new.identity.session_id, principal.identity.session_id);
    assert_eq!(new.expires_at_ms, principal.expires_at_ms);
}

#[tokio::test]
async fn concurrent_registration_produces_one_account_and_one_conflict() {
    let f = Fixture::new().await;
    let input = login();
    let (a, b) = tokio::join!(
        f.service.register(&input, &f.cancel),
        f.service.register(&input, &f.cancel)
    );
    let (result, error) = match (a, b) {
        (Ok(result), Err(error)) | (Err(error), Ok(result)) => (result, error),
        _ => panic!("one registration must win"),
    };
    assert_eq!(result.user.id, "owner-before");
    let error = error.downcast::<DomainError>().unwrap();
    assert_eq!(error.status, 409);
    assert_eq!(error.message, "Account already configured");
}
