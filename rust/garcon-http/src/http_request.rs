use std::rc::Rc;

use garcon_base::errors::ErrorInput;
use garcon_base::http_body::get_token_from_request;
use garcon_base::http_error::json_error_from_unknown;
use garcon_stores::auth::service::AuthService;
use http::Request;
use http::header::HOST;
use subtle::ConstantTimeEq;
use url::Url;

use crate::http_route::route_error;
use crate::http_route_types::{
    AuthenticateHttpRequest, RouteFuture, RouteResponse, ServerPrincipal,
};
use crate::listener::HttpRequest;

pub struct HttpAuthentication {
    service: Rc<AuthService>,
    local_capability: String,
}

impl HttpAuthentication {
    pub fn new(service: Rc<AuthService>, local_capability: String) -> Self {
        Self {
            service,
            local_capability,
        }
    }
}

impl AuthenticateHttpRequest for HttpAuthentication {
    fn authenticate<'a>(
        &'a self,
        request: &'a HttpRequest,
    ) -> RouteFuture<'a, Result<ServerPrincipal, Box<RouteResponse>>> {
        Box::pin(async move {
            let token = get_token_from_request(request);
            if !self.local_capability.is_empty()
                && token.as_ref().is_some_and(|token| {
                    bool::from(token.as_bytes().ct_eq(self.local_capability.as_bytes()))
                })
            {
                return Ok(ServerPrincipal::Local);
            }
            let claims = match self
                .service
                .tokens
                .verify_auth_token_claims(&self.service.store, token.as_deref())
                .await
            {
                Ok(Some(claims)) => claims,
                Ok(None) => {
                    return Err(Box::new(route_error(
                        "Invalid token",
                        401.0,
                        Some("AUTH_SESSION_INVALID"),
                        None,
                    )));
                }
                Err(error) => {
                    // INFALLIBLE: the auth store reports a fixed status and a string-only envelope.
                    let response =
                        json_error_from_unknown(ErrorInput::Error(&error), None, None, None)
                            .expect("fixed auth store error response");
                    return Err(Box::new(response.map(Some)));
                }
            };
            Ok(ServerPrincipal::Authenticated {
                owner_key: claims.identity.owner_key,
                credential_revision: claims.identity.credential_revision,
                session_id: claims.identity.session_id,
                username: claims.username,
                expires_at_ms: claims.expires_at_ms,
            })
        })
    }
}

#[derive(Debug, thiserror::Error)]
#[error("Invalid URL")]
pub struct InvalidRequestUrl;

/// Constructs the handler URL only after route selection and authentication.
/// Bun uses Host even when the HTTP request target is an absolute URL.
pub fn request_url<B>(request: &Request<B>) -> Result<Url, InvalidRequestUrl> {
    let host = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && !value
                    .bytes()
                    .any(|byte| byte <= b' ' || matches!(byte, b'@' | b'/' | b'\\' | b'?' | b'#'))
        })
        .ok_or(InvalidRequestUrl)?;
    let target = request
        .uri()
        .path_and_query()
        .map_or("/", |target| target.as_str());
    Url::parse(&format!("http://{host}{target}")).map_err(|_| InvalidRequestUrl)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_the_first_host_and_normalizes_the_handler_url_after_routing() {
        let request = Request::builder()
            .uri("https://ignored.example/a/../wild//abc?q=%20")
            .header(HOST, "UPPERCASE.example:1234")
            .header(HOST, "second.example")
            .body(())
            .unwrap();
        assert_eq!(request.uri().path(), "/a/../wild//abc");
        assert_eq!(
            request_url(&request).unwrap().as_str(),
            "http://uppercase.example:1234/wild//abc?q=%20"
        );
    }

    #[test]
    fn declines_the_invalid_hosts_from_the_bun_listener_probe() {
        for host in [
            "",
            "a b",
            "[broken",
            "example:65536",
            "user@example",
            "example/path",
            "example#x",
        ] {
            let request = Request::builder()
                .uri("/")
                .header(HOST, host)
                .body(())
                .unwrap();
            assert!(request_url(&request).is_err(), "{host}");
        }
        assert!(request_url(&Request::new(())).is_err());
        for (host, expected) in [
            ("[::1]:123", "http://[::1]:123/p"),
            ("example.com:", "http://example.com/p"),
            ("exa%6Dple.com", "http://example.com/p"),
        ] {
            let request = Request::builder()
                .uri("/p")
                .header(HOST, host)
                .body(())
                .unwrap();
            assert_eq!(request_url(&request).unwrap().as_str(), expected);
        }
    }
}
