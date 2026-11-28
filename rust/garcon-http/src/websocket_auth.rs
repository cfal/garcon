//! Ports `server/controller/lib/websocket-auth.ts`.

use std::rc::Rc;

use garcon_base::domain_error::DomainError;
use garcon_base::http_body::{fetch_header_value, get_token_from_request};
use garcon_contract::ws_auth::{
    AUTH_REVOKED_CLOSE_CODE, AUTH_REVOKED_CLOSE_REASON, AUTH_UNAVAILABLE_CLOSE_CODE,
    AUTH_UNAVAILABLE_CLOSE_REASON, GARCON_WS_PROTOCOL,
    bearer_token_from_web_socket_protocol_header, parse_web_socket_protocol_header,
};
use garcon_stores::auth::service::AuthService;
use garcon_stores::auth::token::{AuthTokens, VerifiedAuthClaims};
use http::header::{HeaderValue, SEC_WEBSOCKET_PROTOCOL};
use http::{HeaderMap, Request};

pub(crate) enum BrowserPrincipal {
    Local,
    Authenticated(VerifiedAuthClaims),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BrowserClose {
    pub(crate) code: u16,
    pub(crate) reason: &'static str,
}

pub(crate) struct BrowserAuth {
    pub(crate) service: Rc<AuthService>,
    pub(crate) disabled: bool,
}

impl BrowserAuth {
    pub(crate) async fn authenticate<B>(
        &self,
        request: &Request<B>,
    ) -> Result<Option<BrowserPrincipal>, DomainError> {
        if self.disabled {
            return Ok(Some(BrowserPrincipal::Local));
        }
        let token = get_web_socket_auth_token(request);
        let claims = self
            .service
            .tokens
            .verify_auth_token_claims(&self.service.store, token.as_deref())
            .await?;
        Ok(claims.map(BrowserPrincipal::Authenticated))
    }

    pub(crate) fn rejection(&self, principal: &BrowserPrincipal) -> Option<BrowserClose> {
        let BrowserPrincipal::Authenticated(claims) = principal else {
            return None;
        };
        if AuthTokens::is_current_browser_principal(&self.service.store, claims) {
            return None;
        }
        Some(if self.service.store.is_unavailable() {
            BrowserClose {
                code: AUTH_UNAVAILABLE_CLOSE_CODE,
                reason: AUTH_UNAVAILABLE_CLOSE_REASON,
            }
        } else {
            BrowserClose {
                code: AUTH_REVOKED_CLOSE_CODE,
                reason: AUTH_REVOKED_CLOSE_REASON,
            }
        })
    }
}

pub(crate) fn get_web_socket_auth_token<B>(request: &Request<B>) -> Option<String> {
    get_token_from_request(request).or_else(|| {
        let protocols = fetch_header_value(request.headers(), &SEC_WEBSOCKET_PROTOCOL);
        bearer_token_from_web_socket_protocol_header(protocols.as_deref()).map(str::to_owned)
    })
}

pub(crate) fn select_web_socket_protocol(headers: &HeaderMap) -> Option<HeaderValue> {
    let offered = fetch_header_value(headers, &SEC_WEBSOCKET_PROTOCOL);
    let offered = parse_web_socket_protocol_header(offered.as_deref());
    if offered.contains(&GARCON_WS_PROTOCOL) {
        return Some(HeaderValue::from_static(GARCON_WS_PROTOCOL));
    }
    // Without the application's explicit choice, Bun selects the first offer.
    HeaderValue::from_bytes(
        &offered
            .first()?
            .chars()
            .map(|c| c as u8)
            .collect::<Vec<_>>(),
    )
    .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::header::AUTHORIZATION;

    #[test]
    fn prefers_the_http_bearer_to_the_protocol_token_and_joins_protocol_fields() {
        let request = Request::builder()
            .header(SEC_WEBSOCKET_PROTOCOL, "ordinary")
            .header(
                SEC_WEBSOCKET_PROTOCOL,
                "garcon-auth.protocol-token, garcon-v1",
            )
            .body(())
            .unwrap();
        assert_eq!(
            get_web_socket_auth_token(&request).as_deref(),
            Some("protocol-token")
        );
        assert_eq!(
            select_web_socket_protocol(request.headers()).unwrap(),
            "garcon-v1"
        );
        let mut request = request;
        request.headers_mut().insert(
            AUTHORIZATION,
            HeaderValue::from_static("Bearer header-token"),
        );
        assert_eq!(
            get_web_socket_auth_token(&request).as_deref(),
            Some("header-token")
        );
        request
            .headers_mut()
            .append(AUTHORIZATION, HeaderValue::from_static("surplus"));
        assert_eq!(
            get_web_socket_auth_token(&request).as_deref(),
            Some("header-token, surplus")
        );
    }

    #[test]
    fn selects_the_exact_protocol_or_the_first_offered_token() {
        for (header, expected) in [
            ("three,two,one", Some("three")),
            ("three,garcon-v1,one", Some("garcon-v1")),
            ("GARCON-V1,other", Some("GARCON-V1")),
            ("garcon-auth.fixture", Some("garcon-auth.fixture")),
            ("", None),
        ] {
            let mut headers = HeaderMap::new();
            headers.append(SEC_WEBSOCKET_PROTOCOL, HeaderValue::from_static(header));
            let selected = select_web_socket_protocol(&headers);
            assert_eq!(
                selected.as_ref().and_then(|value| value.to_str().ok()),
                expected
            );
        }
    }
}
