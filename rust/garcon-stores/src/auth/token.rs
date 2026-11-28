use std::error::Error;
use std::io;
use std::rc::Rc;
use std::sync::LazyLock;

use garcon_base::domain_error::DomainError;
use garcon_contract::auth::{AuthTokenIdentity, parse_auth_token_identity};
use garcon_js::{Clock, Number, is_safe_integer, json::as_number, utf16};
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use super::sessions::AuthBrowserSession;
use super::store::{AuthAccountStore, AuthSnapshot, random_hex};

type BoxError = Box<dyn Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedAuthClaims {
    pub identity: AuthTokenIdentity,
    pub username: String,
    pub expires_at_ms: u64,
}

pub struct AuthTokens {
    expiry: String,
    clock: Rc<dyn Clock>,
    make_session_id: Rc<dyn Fn() -> io::Result<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Claims<'a> {
    sub: &'a str,
    credential_revision: u64,
    sid: &'a str,
    exp: Number,
    iat: i64,
}

impl AuthTokens {
    pub fn new(expiry: String, clock: Rc<dyn Clock>) -> Self {
        Self::with_session_id_generator(expiry, clock, Rc::new(random_hex))
    }

    pub fn with_session_id_generator(
        expiry: String,
        clock: Rc<dyn Clock>,
        make_session_id: Rc<dyn Fn() -> io::Result<String>>,
    ) -> Self {
        Self {
            expiry,
            clock,
            make_session_id,
        }
    }

    pub fn sign_auth_snapshot(
        &self,
        snapshot: &AuthSnapshot,
        session: &AuthBrowserSession,
    ) -> Result<String, BoxError> {
        self.sign(
            snapshot,
            &session.session_id,
            session.expires_at_ms as f64 / 1000.0,
            self.clock.now_ms().div_euclid(1000),
        )
    }

    pub fn prepare_auth_session(
        &self,
        snapshot: &AuthSnapshot,
    ) -> Result<(AuthBrowserSession, String), BoxError> {
        let account = snapshot
            .account
            .as_ref()
            .ok_or("Account is not configured")?;
        let session_id = (self.make_session_id)()?;
        let issued = self.clock.now_ms().div_euclid(1000);
        let duration = duration_ms(&self.expiry).ok_or(
            "\"expiresIn\" should be a number of seconds or string representing a timespan",
        )?;
        let exp = (issued as f64 + duration / 1000.0).floor();
        let token = self.sign(snapshot, &session_id, exp, issued)?;
        let exp = exp * 1000.0;
        if !is_safe_integer(exp) || exp <= self.clock.now_ms() as f64 || exp <= 0.0 {
            return Err("Invalid browser session expiry".into());
        }
        Ok((
            AuthBrowserSession {
                session_id,
                owner_key: account.owner_key.clone(),
                expires_at_ms: exp as u64,
            },
            token,
        ))
    }

    fn sign(
        &self,
        snapshot: &AuthSnapshot,
        sid: &str,
        exp: f64,
        iat: i64,
    ) -> Result<String, BoxError> {
        let account = snapshot
            .account
            .as_ref()
            .ok_or("Account is not configured")?;
        Ok(encode(
            &Header::new(Algorithm::HS256),
            &Claims {
                sub: &account.owner_key,
                credential_revision: account.credential_revision,
                sid,
                exp: Number(exp),
                iat,
            },
            &EncodingKey::from_secret(snapshot.jwt_secret.as_bytes())?,
        )?)
    }

    fn verify_signed(
        &self,
        snapshot: &AuthSnapshot,
        token: &str,
        ignore_expiration: bool,
    ) -> Option<VerifiedAuthClaims> {
        let account = snapshot.account.as_ref()?;
        let mut validation = Validation::new(Algorithm::HS256);
        validation.required_spec_claims.clear();
        validation.validate_exp = false;
        validation.validate_nbf = false;
        validation.validate_aud = false;
        let decoded = decode::<Value>(
            token,
            &DecodingKey::from_secret(snapshot.jwt_secret.as_bytes()).ok()?,
            &validation,
        )
        .ok()?
        .claims;
        let identity = parse_auth_token_identity(&decoded)?;
        let seconds = self.clock.now_ms().div_euclid(1000) as f64;
        let expiration = decoded.get("exp").and_then(as_number)?;
        if expiration <= 0.0 || !ignore_expiration && seconds >= expiration {
            return None;
        }
        if let Some(not_before) = decoded.get("nbf")
            && seconds < as_number(not_before)?
        {
            return None;
        }
        let expires_at_ms = expiration * 1000.0;
        is_safe_integer(expires_at_ms).then(|| VerifiedAuthClaims {
            identity,
            username: account.username.clone(),
            expires_at_ms: expires_at_ms as u64,
        })
    }

    async fn verify_signed_claims(
        &self,
        store: &AuthAccountStore,
        token: Option<&str>,
        ignore_expiration: bool,
    ) -> Result<Option<VerifiedAuthClaims>, DomainError> {
        store.assert_healthy()?;
        let Some(token) = token.filter(|token| !token.is_empty()) else {
            return Ok(None);
        };
        let snapshot = store.snapshot().await?;
        store.assert_healthy()?;
        Ok(self.verify_signed(&snapshot, token, ignore_expiration))
    }

    pub async fn verify_auth_token_claims(
        &self,
        store: &AuthAccountStore,
        token: Option<&str>,
    ) -> Result<Option<VerifiedAuthClaims>, DomainError> {
        let claims = self.verify_signed_claims(store, token, false).await?;
        store.assert_healthy()?;
        Ok(claims.filter(|claims| Self::is_current_browser_principal(store, claims)))
    }

    pub async fn verify_logout_token(
        &self,
        store: &AuthAccountStore,
        token: Option<&str>,
    ) -> Result<Option<VerifiedAuthClaims>, DomainError> {
        let claims = self.verify_signed_claims(store, token, true).await?;
        store.assert_healthy()?;
        Ok(claims)
    }

    pub fn is_current_browser_principal(
        store: &AuthAccountStore,
        claims: &VerifiedAuthClaims,
    ) -> bool {
        let identity = &claims.identity;
        store.is_current(&identity.owner_key, identity.credential_revision)
            && store.is_session_current(
                &identity.owner_key,
                &identity.session_id,
                claims.expires_at_ms,
            )
    }
}

static DURATION: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the fixed pattern matches the ms package's time-span grammar.
    Regex::new(r"(?i-u)^(-?(?:[0-9]+)?\.?[0-9]+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$").expect("JWT duration grammar")
});

fn duration_ms(text: &str) -> Option<f64> {
    if utf16::len(text) > 100 {
        return None;
    }
    let captures = DURATION.captures(text)?;
    let amount: f64 = captures.get(1)?.as_str().parse().ok()?;
    let units = captures
        .get(2)
        .map_or("ms", |unit| unit.as_str())
        .to_ascii_lowercase();
    let multiplier = match units.as_str() {
        "y" | "yr" | "yrs" | "year" | "years" => 86_400_000.0 * 365.25,
        "w" | "week" | "weeks" => 604_800_000.0,
        "d" | "day" | "days" => 86_400_000.0,
        "h" | "hr" | "hrs" | "hour" | "hours" => 3_600_000.0,
        "m" | "min" | "mins" | "minute" | "minutes" => 60_000.0,
        "s" | "sec" | "secs" | "second" | "seconds" => 1000.0,
        _ => 1.0,
    };
    Some(amount * multiplier)
}
