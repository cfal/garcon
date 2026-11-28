use http::Request;
use http::header::HOST;
use url::Url;

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
