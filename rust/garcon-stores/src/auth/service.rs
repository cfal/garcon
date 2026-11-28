use std::cell::{Cell, RefCell};
use std::error::Error;
use std::future::Future;
use std::rc::Rc;

use garcon_base::domain_error::DomainError;
use garcon_base::log::{Logger, ScopedLogger, create_logger};
use garcon_contract::auth::{
    AuthSessionResponse, AuthUser, parse_change_password_request, parse_change_username_request,
    parse_login_request, parse_register_request,
};
use garcon_contract::error_codes::ErrorCode;
use garcon_js::{Clock, to_iso_string};
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::passwords::Passwords;
use super::sessions::AuthBrowserSession;
use super::store::{
    AuthAccount, AuthAccountStore, AuthSnapshot, AuthSnapshotChangedError,
    account_already_configured,
};
use super::token::{AuthTokens, VerifiedAuthClaims};

type BoxError = Box<dyn Error>;

pub struct AuthService {
    pub store: Rc<AuthAccountStore>,
    pub tokens: AuthTokens,
    passwords: Rc<dyn Passwords>,
    clock: Rc<dyn Clock>,
    active: Cell<usize>,
    changing: Cell<bool>,
    changes: RefCell<Vec<i64>>,
    logger: ScopedLogger,
}

#[derive(Clone, Copy)]
pub enum CredentialOperation {
    Username,
    Password,
}

impl CredentialOperation {
    fn name(self) -> &'static str {
        match self {
            Self::Username => "username",
            Self::Password => "password",
        }
    }
}

struct Active<'a>(&'a Cell<usize>);

impl Drop for Active<'_> {
    fn drop(&mut self) {
        self.0.set(self.0.get() - 1);
    }
}

struct Changing<'a>(&'a Cell<bool>);

impl Drop for Changing<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

pub fn throw_if_aborted(signal: &CancellationToken) -> Result<(), BoxError> {
    if signal.is_cancelled() {
        return Err("The operation was aborted.".into());
    }
    Ok(())
}

fn busy() -> DomainError {
    DomainError::new(
        ErrorCode::AUTH_BUSY,
        "Authentication is busy. Try again shortly.",
        429,
        false,
    )
}

fn invalid_login() -> DomainError {
    DomainError::new(
        ErrorCode::AUTH_CREDENTIALS_INVALID,
        "Invalid username or password",
        401,
        false,
    )
}

pub fn invalid_principal() -> DomainError {
    DomainError::new(
        ErrorCode::AUTH_SESSION_INVALID,
        "Sign in again.",
        401,
        false,
    )
}

impl AuthAccount {
    pub fn user(&self) -> AuthUser {
        AuthUser {
            id: self.owner_key.clone(),
            username: self.username.clone(),
        }
    }
}

fn session_response(
    snapshot: &AuthSnapshot,
    token: String,
) -> Result<AuthSessionResponse, BoxError> {
    let account = snapshot
        .account
        .as_ref()
        .ok_or("Account is not configured")?;
    Ok(AuthSessionResponse {
        success: true,
        user: account.user(),
        token,
    })
}

impl AuthService {
    pub fn new(
        store: Rc<AuthAccountStore>,
        tokens: AuthTokens,
        passwords: Rc<dyn Passwords>,
        clock: Rc<dyn Clock>,
    ) -> Self {
        Self {
            store,
            tokens,
            passwords,
            clock,
            active: Cell::new(0),
            changing: Cell::new(false),
            changes: RefCell::new(Vec::new()),
            logger: create_logger("auth:service"),
        }
    }

    fn new_session(
        &self,
        snapshot: &AuthSnapshot,
    ) -> Result<(AuthBrowserSession, AuthSessionResponse), BoxError> {
        let (session, token) = self.tokens.prepare_auth_session(snapshot)?;
        Ok((session, session_response(snapshot, token)?))
    }

    fn admit(&self) -> Result<Active<'_>, DomainError> {
        let active = self.active.get();
        if active >= 2 {
            return Err(busy());
        }
        self.active.set(active + 1);
        Ok(Active(&self.active))
    }

    pub async fn login(
        &self,
        value: &Value,
        signal: &CancellationToken,
    ) -> Result<AuthSessionResponse, BoxError> {
        let input = parse_login_request(value)?;
        let _admission = self.admit()?;
        let snapshot = self.store.snapshot().await?;
        if let Some(account) = &snapshot.account
            && input.username == account.username
            && self
                .passwords
                .verify(&input.password, &account.password_hash)
                .await?
        {
            return self
                .store
                .open_session(&snapshot, || {
                    throw_if_aborted(signal)?;
                    self.new_session(&snapshot)
                })
                .await
                .map_err(|error| {
                    if error.is::<AuthSnapshotChangedError>() {
                        invalid_login().into()
                    } else {
                        error
                    }
                });
        }
        self.store.assert_healthy()?;
        Err(invalid_login().into())
    }

    pub async fn register(
        &self,
        value: &Value,
        signal: &CancellationToken,
    ) -> Result<AuthSessionResponse, BoxError> {
        let input = parse_register_request(value)?;
        let _admission = self.admit()?;
        let snapshot = self.store.snapshot().await?;
        if snapshot.account.is_some() {
            return Err(account_already_configured().into());
        }
        let password_hash = self.passwords.hash(&input.password).await?;
        self.store
            .register(&snapshot, || {
                throw_if_aborted(signal)?;
                let account = AuthAccount {
                    owner_key: input.username.clone(),
                    username: input.username,
                    credential_revision: 1,
                    password_hash,
                    created_at: Some(to_iso_string(self.clock.now_ms())?),
                };
                let replacement = AuthSnapshot {
                    jwt_secret: snapshot.jwt_secret.clone(),
                    account: Some(account.clone()),
                };
                let (session, result) = self.new_session(&replacement)?;
                Ok((account, session, result))
            })
            .await
            .map_err(|error| {
                if error.is::<AuthSnapshotChangedError>() {
                    account_already_configured().into()
                } else {
                    error
                }
            })
    }

    pub async fn change_credentials(
        &self,
        operation: CredentialOperation,
        principal: &VerifiedAuthClaims,
        read: impl Future<Output = Result<Value, BoxError>>,
        signal: &CancellationToken,
    ) -> Result<AuthSessionResponse, BoxError> {
        self.store.assert_healthy()?;
        let now = self.clock.now_ms();
        {
            let mut changes = self.changes.borrow_mut();
            changes.retain(|at| *at > now.saturating_sub(60_000));
            if self.changing.get() || changes.len() >= 10 {
                return Err(busy().into());
            }
            changes.push(now);
            self.changing.set(true);
        }
        let _changing = Changing(&self.changing);
        let value = read.await?;
        let (current_password, replacement) = match operation {
            CredentialOperation::Username => {
                let input = parse_change_username_request(&value)?;
                (input.current_password, input.username)
            }
            CredentialOperation::Password => {
                let input = parse_change_password_request(&value)?;
                (input.current_password, input.new_password)
            }
        };
        let _admission = self.admit()?;
        let snapshot = self.store.snapshot().await?;
        let mut account = self.account_for_principal(principal, &snapshot)?.clone();
        if !self
            .passwords
            .verify(&current_password, &account.password_hash)
            .await?
        {
            return Err(DomainError::new(
                ErrorCode::AUTH_CURRENT_PASSWORD_INVALID,
                "Current password is incorrect.",
                400,
                false,
            )
            .into());
        }
        throw_if_aborted(signal)?;
        match operation {
            CredentialOperation::Username => {
                if replacement == account.username {
                    return Err(DomainError::new(
                        ErrorCode::AUTH_NO_CHANGE,
                        "Username is unchanged.",
                        400,
                        false,
                    )
                    .into());
                }
                account.username = replacement;
            }
            CredentialOperation::Password => {
                if replacement == current_password {
                    return Err(DomainError::new(
                        ErrorCode::AUTH_NO_CHANGE,
                        "Password is unchanged.",
                        400,
                        false,
                    )
                    .into());
                }
                account.password_hash = self.passwords.hash(&replacement).await?;
            }
        }
        let previous_revision = account.credential_revision;
        if previous_revision == (1_u64 << 53) - 1 {
            return Err(DomainError::new(
                ErrorCode::AUTH_REVISION_EXHAUSTED,
                "Credential revision is exhausted.",
                409,
                false,
            )
            .into());
        }
        let result = self
            .store
            .commit(&snapshot, || {
                self.account_for_principal(principal, &snapshot)?;
                throw_if_aborted(signal)?;
                account.credential_revision += 1;
                let replacement = AuthSnapshot {
                    jwt_secret: snapshot.jwt_secret.clone(),
                    account: Some(account.clone()),
                };
                let token = self.tokens.sign_auth_snapshot(
                    &replacement,
                    &AuthBrowserSession {
                        owner_key: principal.identity.owner_key.clone(),
                        session_id: principal.identity.session_id.clone(),
                        expires_at_ms: principal.expires_at_ms,
                    },
                )?;
                Ok((account, session_response(&replacement, token)?))
            })
            .await
            .map_err(|error| {
                if error.is::<AuthSnapshotChangedError>() {
                    BoxError::from(invalid_principal())
                } else {
                    error
                }
            })?;
        self.logger.info(&format!(
            "Account credentials changed: {} (revision {previous_revision} to {})",
            operation.name(),
            previous_revision + 1
        ));
        Ok(result)
    }

    fn account_for_principal<'a>(
        &self,
        principal: &VerifiedAuthClaims,
        snapshot: &'a AuthSnapshot,
    ) -> Result<&'a AuthAccount, DomainError> {
        let identity = &principal.identity;
        snapshot
            .account
            .as_ref()
            .filter(|account| {
                account.owner_key == identity.owner_key
                    && account.credential_revision == identity.credential_revision
                    && self.store.is_session_current(
                        &identity.owner_key,
                        &identity.session_id,
                        principal.expires_at_ms,
                    )
            })
            .ok_or_else(invalid_principal)
    }
}
