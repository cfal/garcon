use url::Url;

#[derive(Clone, Debug)]
pub struct Deployment(Url);

impl Deployment {
    pub fn parse(input: &str, allow_loopback: bool) -> Result<Self, String> {
        let input = input.trim();
        if input.contains(['\\', '%'])
            || input.chars().any(char::is_control)
            || input.split('/').any(|part| part == "." || part == "..")
        {
            return Err("Enter a valid HTTPS server URL.".into());
        }
        let mut url = Url::parse(input).map_err(|_| "Enter a complete HTTPS server URL.")?;
        let loopback = url
            .host_str()
            .is_some_and(|host| host == "localhost" || host == "127.0.0.1" || host == "[::1]");
        if url.scheme() != "https" && !(allow_loopback && loopback && url.scheme() == "http") {
            return Err("Use HTTPS. Development builds also allow HTTP on loopback.".into());
        }
        if url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "Use a server URL without credentials, query parameters, or a fragment.".into(),
            );
        }
        // Encoded separators and dot segments make reverse-proxy mount boundaries ambiguous.
        if url.path().contains('%') || url.path().contains("//") {
            return Err("Use an unescaped server mount path without repeated slashes.".into());
        }
        if !url.path().ends_with('/') {
            url.set_path(&format!("{}/", url.path()));
        }
        Ok(Self(url))
    }

    pub fn url(&self) -> &Url {
        &self.0
    }

    pub fn allows(&self, url: &Url) -> bool {
        url.origin() == self.0.origin()
            && url.username().is_empty()
            && url.password().is_none()
            && !url.path().contains('%')
            && !url.path().contains("//")
            && (url.path().starts_with(self.0.path())
                || url.path() == self.0.path().trim_end_matches('/'))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_origin_and_mount() {
        for (input, expected) in [
            ("https://EXAMPLE.test:443", "https://example.test/"),
            (
                " https://example.test/tools/garcon ",
                "https://example.test/tools/garcon/",
            ),
        ] {
            assert_eq!(
                Deployment::parse(input, false).unwrap().url().as_str(),
                expected
            );
        }
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_servers() {
        for input in [
            "http://example.test",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "https://user@example.test",
            "https://example.test/?token=secret",
            "https://example.test/#secret",
            "https://example.test/a%2fb",
            "https://example.test/a//b",
            "https://example.test/a\\b",
            "https://exa\nmple.test",
            "https://example.test/%2e%2e/admin",
        ] {
            assert!(Deployment::parse(input, false).is_err(), "{input}");
        }
    }

    #[test]
    fn only_debug_loopback_may_use_http() {
        for host in ["localhost", "127.0.0.1", "[::1]"] {
            let url = format!("http://{host}:3001");
            assert!(Deployment::parse(&url, true).is_ok());
            assert!(Deployment::parse(&url, false).is_err());
        }
        assert!(Deployment::parse("http://192.168.1.2", true).is_err());
    }

    #[test]
    fn navigation_stays_inside_the_selected_origin_and_mount() {
        let deployment = Deployment::parse("https://example.test/garcon", false).unwrap();
        for path in ["/garcon", "/garcon/", "/garcon/chat/123?view=chat#message"] {
            assert!(
                deployment.allows(&Url::parse(&format!("https://example.test{path}")).unwrap())
            );
        }
        for target in [
            "https://example.test/garcon-other/",
            "https://example.test/other/",
            "https://example.test/garcon/../other/",
            "https://example.test/garcon/%2fother",
            "https://example.test:444/garcon/",
            "http://example.test/garcon/",
            "https://example.test.evil.test/garcon/",
            "https://user@example.test/garcon/",
        ] {
            assert!(!deployment.allows(&Url::parse(target).unwrap()), "{target}");
        }
    }
}
