use std::cell::Cell;
use std::future::Future;
use std::rc::Rc;

use garcon_base::domain_error::DomainError;
use garcon_base::errors::ErrorInput;
use garcon_base::http_body::get_token_from_request;
use garcon_base::http_error::{json_error, json_error_from_unknown};
use garcon_contract::auth::{
    AuthStatusResponse, AuthTokenIdentity, AuthUser, AuthUserResponse, AuthValidationError,
    LogoutResponse,
};
use garcon_contract::error_codes::ErrorCode;
use garcon_js::SystemClock;
use garcon_stores::auth::service::{
    AuthService, CredentialOperation, invalid_principal, throw_if_aborted,
};
use garcon_stores::auth::token::VerifiedAuthClaims;
use http::header::{CACHE_CONTROL, HeaderValue, RETRY_AFTER};
use http::{Method, StatusCode};
use tokio_util::task::TaskTracker;

use crate::auth_body::AuthBodyReaders;
use crate::compose_routes::RouteMap;
use crate::http_route_types::{
    HttpRouteContext, Route, RouteMetadata, RouteResult, ServerPrincipal,
};
use crate::json_route::json_response;
use crate::listener::HttpRequest;
use crate::rate_limit::{InvalidRateLimits, RateLimited, RateLimiter, RateLimits};

pub struct AuthRoutes {
    service: Rc<AuthService>,
    disabled: bool,
    readers: AuthBodyReaders,
    login_limiter: Rc<RateLimiter>,
    register_limiter: Rc<RateLimiter>,
    credential_limiter: Rc<RateLimiter>,
    logout_limiter: Rc<RateLimiter>,
    logout_active: Cell<bool>,
    writes: TaskTracker,
}

struct ActiveLogout<'a>(&'a Cell<bool>);

impl Drop for ActiveLogout<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

impl AuthRoutes {
    pub fn new(
        service: Rc<AuthService>,
        disabled: bool,
        trust_proxy: bool,
    ) -> Result<Rc<Self>, InvalidRateLimits> {
        let limiter = || RateLimiter::new(RateLimits::default(), trust_proxy, SystemClock);
        Ok(Rc::new(Self {
            service,
            disabled,
            readers: AuthBodyReaders::default(),
            login_limiter: limiter(),
            register_limiter: limiter(),
            credential_limiter: limiter(),
            logout_limiter: RateLimiter::new(
                RateLimits::new(60_000.0, 30.0, 10_000.0)?,
                trust_proxy,
                SystemClock,
            ),
            logout_active: Cell::new(false),
            writes: TaskTracker::new(),
        }))
    }

    /// Runs after the listener stops accepting requests, before releasing the workspace lease.
    pub async fn drain(&self) {
        self.writes.close();
        self.writes.wait().await;
    }

    fn require_enabled(&self) -> Result<(), DomainError> {
        if self.disabled {
            return Err(forbidden(
                "Authentication is disabled by server configuration",
            ));
        }
        Ok(())
    }

    async fn status(&self) -> RouteResult {
        let store = &self.service.store;
        store.assert_healthy()?;
        let needs_setup = !self.disabled && store.snapshot().await?.account.is_none();
        store.assert_healthy()?;
        Ok(json_response(
            StatusCode::OK,
            &AuthStatusResponse {
                needs_setup,
                is_authenticated: self.disabled,
                auth_disabled: self.disabled,
            },
        )?)
    }

    async fn user(&self, principal: Option<ServerPrincipal>) -> RouteResult {
        if self.disabled {
            return Ok(json_response(
                StatusCode::OK,
                &AuthUserResponse {
                    user: AuthUser {
                        id: "local".into(),
                        username: "local".into(),
                    },
                },
            )?);
        }
        let store = &self.service.store;
        let snapshot = store.snapshot().await?;
        store.assert_healthy()?;
        if let Some(principal) = browser_claims(principal)
            && !garcon_stores::auth::token::AuthTokens::is_current_browser_principal(
                store, &principal,
            )
        {
            return Err(invalid_principal().into());
        }
        let account = snapshot.account.as_ref().ok_or_else(invalid_principal)?;
        Ok(json_response(
            StatusCode::OK,
            &AuthUserResponse {
                user: account.user(),
            },
        )?)
    }

    async fn register(&self, request: HttpRequest, context: HttpRouteContext) -> RouteResult {
        self.require_enabled()?;
        self.register_limiter
            .check(request.headers(), Some(context.peer.ip()))?;
        let signal = request.body().cancellation().clone();
        let body = self.readers.read_username_write(request, &signal).await?;
        Ok(json_response(
            StatusCode::OK,
            &self.service.register(&body, &signal).await?,
        )?)
    }

    async fn login(&self, request: HttpRequest, context: HttpRouteContext) -> RouteResult {
        self.require_enabled()?;
        self.login_limiter
            .check(request.headers(), Some(context.peer.ip()))?;
        let signal = request.body().cancellation().clone();
        let body = self.readers.read(request, &signal).await?;
        Ok(json_response(
            StatusCode::OK,
            &self.service.login(&body, &signal).await?,
        )?)
    }

    async fn credential(
        &self,
        operation: CredentialOperation,
        request: HttpRequest,
        context: HttpRouteContext,
    ) -> RouteResult {
        self.require_enabled()?;
        let principal = browser_claims(context.principal)
            .ok_or_else(|| forbidden("Sign in to change credentials."))?;
        if self
            .credential_limiter
            .check(request.headers(), Some(context.peer.ip()))
            .is_err()
        {
            return Err(DomainError::new(
                ErrorCode::AUTH_BUSY,
                "Too many credential changes. Try again shortly.",
                429,
                false,
            )
            .into());
        }
        let signal = request.body().cancellation().clone();
        let read = async {
            match operation {
                CredentialOperation::Username => {
                    self.readers.read_username_write(request, &signal).await
                }
                CredentialOperation::Password => self.readers.read(request, &signal).await,
            }
        };
        let response = self
            .service
            .change_credentials(operation, &principal, read, &signal)
            .await?;
        Ok(json_response(StatusCode::OK, &response)?)
    }

    async fn logout(&self, request: HttpRequest, context: HttpRouteContext) -> RouteResult {
        self.require_enabled()?;
        if context
            .principal
            .is_some_and(|principal| !matches!(principal, ServerPrincipal::Authenticated { .. }))
        {
            return Err(forbidden("Only browser sessions can log out.").into());
        }
        self.logout_limiter
            .check(request.headers(), Some(context.peer.ip()))?;
        if self.logout_active.replace(true) {
            return Err(DomainError::new(
                ErrorCode::AUTH_BUSY,
                "Logout is busy. Try again shortly.",
                429,
                false,
            )
            .into());
        }
        let _active = ActiveLogout(&self.logout_active);
        let token = get_token_from_request(&request);
        let store = &self.service.store;
        let claims = self
            .service
            .tokens
            .verify_logout_token(store, token.as_deref())
            .await?
            .ok_or_else(|| {
                DomainError::new(
                    ErrorCode::AUTH_SESSION_INVALID,
                    "Invalid session.",
                    401,
                    false,
                )
            })?;
        throw_if_aborted(request.body().cancellation())?;
        store
            .revoke_session(&claims.identity.owner_key, &claims.identity.session_id)
            .await?;
        Ok(json_response(
            StatusCode::OK,
            &LogoutResponse { success: true },
        )?)
    }
}

fn forbidden(message: &str) -> DomainError {
    DomainError::new(ErrorCode::AUTH_CHANGE_FORBIDDEN, message, 403, false)
}

fn browser_claims(principal: Option<ServerPrincipal>) -> Option<VerifiedAuthClaims> {
    let ServerPrincipal::Authenticated {
        owner_key,
        username,
        expires_at_ms,
        credential_revision,
        session_id,
    } = principal?
    else {
        return None;
    };
    Some(VerifiedAuthClaims {
        identity: AuthTokenIdentity {
            owner_key,
            credential_revision,
            session_id,
        },
        username,
        expires_at_ms,
    })
}

fn auth_route<F, R>(auth: &Rc<AuthRoutes>, method: Method, no_auth: bool, handler: F) -> Route
where
    F: Fn(Rc<AuthRoutes>, HttpRequest, HttpRouteContext) -> R + 'static,
    R: Future<Output = RouteResult> + 'static,
{
    let auth = Rc::clone(auth);
    Route::new(
        RouteMetadata {
            no_auth,
            no_store: true,
            ..Default::default()
        },
        move |request, _, context| {
            let result = handler(Rc::clone(&auth), request, context);
            let writes = (method != Method::GET).then(|| auth.writes.clone());
            async move {
                // Dropping the HTTP future signals cancellation, but cannot release a write's
                // admission or store lock while its filesystem operation is still settling.
                let result = match writes {
                    Some(writes) => writes.spawn_local(result).await?,
                    None => result.await,
                };
                let mut response = match result {
                    Ok(response) => response,
                    Err(error) => {
                        let response = if let Some(error) =
                            error.downcast_ref::<AuthValidationError>()
                        {
                            json_error(
                                error.to_string(),
                                400.0,
                                Some(ErrorCode::AUTH_VALIDATION_FAILED.as_str()),
                                Some(false),
                                None,
                            )?
                        } else if let Some(error) = error.downcast_ref::<RateLimited>() {
                            json_error(
                                error.to_string(),
                                429.0,
                                Some("RATE_LIMITED"),
                                Some(true),
                                None,
                            )?
                        } else {
                            json_error_from_unknown(ErrorInput::Error(&*error), None, None, None)?
                        };
                        response.map(Some)
                    }
                };
                response
                    .headers_mut()
                    .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
                if response.status() == StatusCode::TOO_MANY_REQUESTS {
                    response
                        .headers_mut()
                        .insert(RETRY_AFTER, HeaderValue::from_static("5"));
                }
                Ok(response)
            }
        },
    )
}

pub fn create_auth_routes(auth: &Rc<AuthRoutes>) -> RouteMap<Route> {
    use CredentialOperation::{Password, Username};

    [
        (
            "status",
            Method::GET,
            auth_route(auth, Method::GET, true, |auth, _, _| async move {
                auth.status().await
            }),
        ),
        (
            "register",
            Method::POST,
            auth_route(
                auth,
                Method::POST,
                true,
                |auth, request, context| async move { auth.register(request, context).await },
            ),
        ),
        (
            "login",
            Method::POST,
            auth_route(
                auth,
                Method::POST,
                true,
                |auth, request, context| async move { auth.login(request, context).await },
            ),
        ),
        (
            "user",
            Method::GET,
            auth_route(auth, Method::GET, false, |auth, _, context| async move {
                auth.user(context.principal).await
            }),
        ),
        (
            "username",
            Method::PATCH,
            auth_route(
                auth,
                Method::PATCH,
                false,
                |auth, request, context| async move {
                    auth.credential(Username, request, context).await
                },
            ),
        ),
        (
            "password",
            Method::PATCH,
            auth_route(
                auth,
                Method::PATCH,
                false,
                |auth, request, context| async move {
                    auth.credential(Password, request, context).await
                },
            ),
        ),
        (
            "logout",
            Method::POST,
            auth_route(
                auth,
                Method::POST,
                true,
                |auth, request, context| async move { auth.logout(request, context).await },
            ),
        ),
    ]
    .into_iter()
    .map(|(suffix, method, route)| {
        (
            format!("/api/v1/auth/{suffix}"),
            [(method, route)].into_iter().collect(),
        )
    })
    .collect()
}
