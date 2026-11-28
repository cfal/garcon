//! Ports common/ws-auth.ts.

use garcon_js::trim;

pub const GARCON_WS_PROTOCOL: &str = "garcon-v1";
pub const GARCON_WS_AUTH_PROTOCOL_PREFIX: &str = "garcon-auth.";

pub fn web_socket_protocols_for_auth(token: Option<&str>) -> Vec<String> {
    let mut protocols = vec![GARCON_WS_PROTOCOL.to_owned()];
    let Some(token) = token.map(trim).filter(|token| !token.is_empty()) else {
        return protocols;
    };
    if token.bytes().all(is_http_token_byte) {
        protocols.push(format!("{GARCON_WS_AUTH_PROTOCOL_PREFIX}{token}"));
    }
    protocols
}

fn is_http_token_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"!#$%&'*+-.^_\x60|~".contains(&byte)
}

pub fn parse_web_socket_protocol_header(header: Option<&str>) -> Vec<&str> {
    header
        .into_iter()
        .flat_map(|header| header.split(','))
        .map(trim)
        .filter(|protocol| !protocol.is_empty())
        .collect()
}

pub fn web_socket_protocol_header_contains(header: Option<&str>, protocol: &str) -> bool {
    parse_web_socket_protocol_header(header).contains(&protocol)
}

pub fn bearer_token_from_web_socket_protocol_header(header: Option<&str>) -> Option<&str> {
    parse_web_socket_protocol_header(header)
        .into_iter()
        .find_map(|protocol| protocol.strip_prefix(GARCON_WS_AUTH_PROTOCOL_PREFIX))
        .filter(|token| !token.is_empty())
}

pub const AUTH_REVOKED_CLOSE_CODE: u16 = 4001;
pub const AUTH_REVOKED_CLOSE_REASON: &str = "AUTH_REVOKED";
pub const AUTH_UNAVAILABLE_CLOSE_CODE: u16 = 4002;
pub const AUTH_UNAVAILABLE_CLOSE_REASON: &str = "AUTH_STORAGE_UNAVAILABLE";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_bearer_auth_without_putting_the_token_in_the_url() {
        assert_eq!(
            web_socket_protocols_for_auth(Some("\u{feff}jwt-token ")),
            [GARCON_WS_PROTOCOL, "garcon-auth.jwt-token"]
        );
    }

    #[test]
    fn omits_invalid_subprotocol_tokens() {
        for token in ["", "bad token", "x/y", "x\u{212a}"] {
            assert_eq!(
                web_socket_protocols_for_auth(Some(token)),
                [GARCON_WS_PROTOCOL]
            );
        }
    }

    #[test]
    fn parses_the_bearer_token_from_the_protocol_header() {
        assert_eq!(
            bearer_token_from_web_socket_protocol_header(Some("garcon-v1, garcon-auth.jwt-token")),
            Some("jwt-token")
        );
        assert_eq!(
            bearer_token_from_web_socket_protocol_header(Some("garcon-auth.,garcon-auth.second")),
            None
        );
        assert_eq!(
            bearer_token_from_web_socket_protocol_header(Some("garcon-auth.bad token")),
            Some("bad token")
        );
    }
}
