//! Browser upgrade recognition and Bun's HTTP/1 handshake response.

use std::rc::Rc;

use base64::engine::{Engine, general_purpose::STANDARD};
use garcon_base::errors::ErrorInput;
use garcon_base::http_body::fetch_header_value;
use garcon_base::http_error::json_error_from_unknown;
use garcon_js::trim;
use http::header::{
    CONNECTION, HeaderValue, SEC_WEBSOCKET_ACCEPT, SEC_WEBSOCKET_EXTENSIONS, SEC_WEBSOCKET_KEY,
    SEC_WEBSOCKET_PROTOCOL, SEC_WEBSOCKET_VERSION, UPGRADE,
};
use http::{Method, Request, Response, StatusCode, Version};
use sha1::{Digest, Sha1};
use uuid::Uuid;

use crate::http_route::{shutting_down, text_response};
use crate::http_route_types::{RouteResponse, RouteResult};
use crate::listener::HttpRequest;
use crate::websocket_auth::select_web_socket_protocol;

use super::server_sockets::BrowserSockets;

const WEBSOCKET_GUID: &[u8] = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PERMESSAGE_DEFLATE: &str =
    "permessage-deflate; client_no_context_takeover; server_no_context_takeover";

impl BrowserSockets {
    pub(crate) async fn upgrade(
        self: &Rc<Self>,
        mut request: HttpRequest,
        target: UpgradeTarget,
    ) -> RouteResult {
        if self.options.shutting_down.get() {
            return Ok(shutting_down());
        }
        let method = request.method();
        if target == UpgradeTarget::Executor {
            return Ok(text_response(
                method,
                StatusCode::NOT_FOUND,
                "Executor is unavailable",
            ));
        }
        let principal = match self.auth.authenticate(&request).await {
            Ok(principal) => principal,
            Err(error) => {
                return Ok(
                    json_error_from_unknown(ErrorInput::Error(&error), None, None, None)?.map(Some),
                );
            }
        };
        if self.options.shutting_down.get() {
            return Ok(shutting_down());
        }
        let Some(principal) = principal else {
            return Ok(text_response(
                method,
                StatusCode::UNAUTHORIZED,
                "Unauthorized",
            ));
        };
        let reservation = match self.admission.try_reserve(Uuid::new_v4()) {
            Ok(reservation) => reservation,
            Err(error) => {
                return Ok(text_response(
                    method,
                    StatusCode::SERVICE_UNAVAILABLE,
                    error.reason(),
                ));
            }
        };
        let handshake = match browser_handshake(&request) {
            Ok(handshake) => handshake,
            Err(InvalidUpgrade::InvalidRequest) => {
                return Ok(text_response(
                    method,
                    StatusCode::BAD_REQUEST,
                    "WebSocket upgrade failed",
                ));
            }
            Err(InvalidUpgrade::UnsupportedVersion) => {
                let mut response = Response::new(None);
                *response.status_mut() = StatusCode::UPGRADE_REQUIRED;
                response
                    .headers_mut()
                    .insert(SEC_WEBSOCKET_VERSION, HeaderValue::from_static("13"));
                return Ok(response);
            }
        };
        self.begin_upgrade(
            hyper::upgrade::on(&mut request),
            handshake.extension,
            reservation,
            principal,
        );
        Ok(handshake.response())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UpgradeTarget {
    Browser,
    Executor,
}

pub(crate) fn upgrade_target<B>(request: &Request<B>, path: &str) -> Option<UpgradeTarget> {
    if !fetch_header_value(request.headers(), &UPGRADE)
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
    {
        return None;
    }
    if path == "/ws" {
        return Some(UpgradeTarget::Browser);
    }
    let id = path.strip_prefix("/executor/")?;
    (!id.is_empty()
        && id
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'-')))
    .then_some(UpgradeTarget::Executor)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InvalidUpgrade {
    InvalidRequest,
    UnsupportedVersion,
}

struct BrowserHandshake {
    accept: HeaderValue,
    protocol: Option<HeaderValue>,
    extension: Option<&'static str>,
}

fn browser_handshake<B>(request: &Request<B>) -> Result<BrowserHandshake, InvalidUpgrade> {
    if request.method() != Method::GET || request.version() != Version::HTTP_11 {
        return Err(InvalidUpgrade::InvalidRequest);
    }
    let headers = request.headers();
    let key = fetch_header_value(headers, &SEC_WEBSOCKET_KEY)
        .filter(|key| STANDARD.decode(key).is_ok_and(|key| key.len() == 16))
        .ok_or(InvalidUpgrade::InvalidRequest)?;
    if fetch_header_value(headers, &SEC_WEBSOCKET_VERSION).as_deref() != Some("13") {
        return Err(InvalidUpgrade::UnsupportedVersion);
    }
    let mut digest = Sha1::new();
    digest.update(key.as_bytes());
    digest.update(WEBSOCKET_GUID);
    let accept = STANDARD.encode(digest.finalize());
    // INFALLIBLE: SHA-1's base64 representation is visible ASCII.
    let accept = HeaderValue::from_str(&accept).expect("base64 WebSocket accept");
    let extension = fetch_header_value(headers, &SEC_WEBSOCKET_EXTENSIONS)
        .is_some_and(|offers| {
            offers
                .split(',')
                .any(|offer| offer.split(';').next().map(trim) == Some("permessage-deflate"))
        })
        .then_some(PERMESSAGE_DEFLATE);
    Ok(BrowserHandshake {
        accept,
        protocol: select_web_socket_protocol(headers),
        extension,
    })
}

impl BrowserHandshake {
    fn response(self) -> RouteResponse {
        let mut response = Response::new(None);
        *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
        let headers = response.headers_mut();
        headers.insert(UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert(CONNECTION, HeaderValue::from_static("Upgrade"));
        headers.insert(SEC_WEBSOCKET_ACCEPT, self.accept);
        if let Some(protocol) = self.protocol {
            headers.insert(SEC_WEBSOCKET_PROTOCOL, protocol);
        }
        if let Some(extension) = self.extension {
            headers.insert(
                SEC_WEBSOCKET_EXTENSIONS,
                HeaderValue::from_static(extension),
            );
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";

    #[test]
    fn recognizes_only_browser_and_lowercase_executor_upgrade_paths() {
        let request = Request::builder()
            .header(UPGRADE, "WebSocket")
            .body(())
            .unwrap();
        assert_eq!(
            upgrade_target(&request, "/ws"),
            Some(UpgradeTarget::Browser)
        );
        assert_eq!(
            upgrade_target(&request, "/executor/123-abc"),
            Some(UpgradeTarget::Executor)
        );
        for path in [
            "/ws/",
            "/somewhere/ws",
            "/executor/",
            "/executor/A",
            "/executor/a/b",
        ] {
            assert_eq!(upgrade_target(&request, path), None, "{path}");
        }
        assert_eq!(upgrade_target(&Request::new(()), "/ws"), None);
    }

    #[test]
    fn bun_requires_a_get_with_a_valid_key_before_rejecting_the_version() {
        for (method, key, version, expected) in [
            (Method::POST, KEY, "12", InvalidUpgrade::InvalidRequest),
            (Method::GET, "invalid", "12", InvalidUpgrade::InvalidRequest),
            (Method::GET, "", "13", InvalidUpgrade::InvalidRequest),
            (Method::GET, KEY, "", InvalidUpgrade::UnsupportedVersion),
            (Method::GET, KEY, "12", InvalidUpgrade::UnsupportedVersion),
            (
                Method::GET,
                KEY,
                "13, 13",
                InvalidUpgrade::UnsupportedVersion,
            ),
        ] {
            let request = Request::builder()
                .method(method)
                .header(SEC_WEBSOCKET_KEY, key)
                .header(SEC_WEBSOCKET_VERSION, version)
                .body(())
                .unwrap();
            assert_eq!(browser_handshake(&request).err(), Some(expected));
        }
    }

    #[test]
    fn refuses_the_http_1_0_upgrade_that_hyper_cannot_handoff() {
        let request = Request::builder()
            .version(Version::HTTP_10)
            .header(SEC_WEBSOCKET_KEY, KEY)
            .header(SEC_WEBSOCKET_VERSION, "13")
            .body(())
            .unwrap();
        assert_eq!(
            browser_handshake(&request).err(),
            Some(InvalidUpgrade::InvalidRequest)
        );
    }

    #[test]
    fn browser_deflate_offers_select_buns_exact_no_context_parameters() {
        for (offer, negotiated) in [
            ("permessage-deflate", true),
            ("permessage-deflate; client_max_window_bits", true),
            ("permessage-deflate; client_max_window_bits=12", true),
            (
                "x-unknown, permessage-deflate; server_max_window_bits=10",
                true,
            ),
            ("PERMESSAGE-DEFLATE", false),
            ("some-permessage-deflate", false),
        ] {
            let request = Request::builder()
                .header(SEC_WEBSOCKET_KEY, KEY)
                .header(SEC_WEBSOCKET_PROTOCOL, "first, garcon-v1")
                .header(SEC_WEBSOCKET_VERSION, "13")
                .header(SEC_WEBSOCKET_EXTENSIONS, offer)
                .body(())
                .unwrap();
            let response = browser_handshake(&request).ok().unwrap().response();
            assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
            assert_eq!(
                response.headers()[SEC_WEBSOCKET_ACCEPT],
                "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
            );
            assert_eq!(response.headers()[SEC_WEBSOCKET_PROTOCOL], "garcon-v1");
            assert_eq!(
                response
                    .headers()
                    .get(SEC_WEBSOCKET_EXTENSIONS)
                    .map(|value| value.to_str().unwrap()),
                negotiated.then_some(PERMESSAGE_DEFLATE)
            );
        }
    }
}
