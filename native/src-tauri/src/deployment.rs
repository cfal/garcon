use url::Url;

#[derive(Clone, Debug)]
pub struct Deployment(Url);

impl Deployment {
    pub fn parse(input: &str) -> Result<Self, String> {
        let input = input.trim();
        if input.contains(['\\', '%'])
            || input.chars().any(char::is_control)
            || input.split('/').any(|part| part == "." || part == "..")
        {
            return Err("Enter a valid HTTP or HTTPS server URL.".into());
        }
        let mut url =
            Url::parse(input).map_err(|_| "Enter a complete HTTP or HTTPS server URL.")?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err("Use an HTTP or HTTPS server URL.".into());
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
            assert_eq!(Deployment::parse(input).unwrap().url().as_str(), expected);
        }
    }

    #[test]
    fn rejects_unsafe_or_ambiguous_servers() {
        for input in [
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
            assert!(Deployment::parse(input).is_err(), "{input}");
        }
    }

    #[test]
    fn accepts_http_and_https_for_all_hosts() {
        for host in [
            "localhost",
            "example.test",
            "garcon.vpn.test",
            "garcon",
            "localhost.example.test",
            "127.0.0.1",
            "[::1]",
            "192.168.1.2",
            "10.20.30.40",
            "100.64.0.2",
            "203.0.113.8",
            "[fd00::2]",
            "[2001:db8::2]",
        ] {
            let url = format!("http://{host}:3001");
            assert!(Deployment::parse(&url).is_ok(), "{url}");
            assert!(Deployment::parse(&format!("https://{host}:3001")).is_ok());
        }
        for url in [
            "ftp://192.168.1.2",
            "ftp://example.test",
            "file:///etc/passwd",
            "javascript:alert(1)",
        ] {
            assert!(Deployment::parse(url).is_err(), "{url}");
        }
    }

    #[test]
    fn http_keeps_url_and_navigation_boundaries() {
        for host in ["100.64.0.2", "[fd00::2]", "garcon.vpn.test", "garcon"] {
            let origin = format!("http://{host}:3001");
            let deployment = Deployment::parse(&format!("{origin}/garcon")).unwrap();
            assert!(deployment.allows(&Url::parse(&format!("{origin}/garcon/chat/123")).unwrap()));
            for target in [
                format!("{origin}/other/"),
                format!("{origin}/garcon-other/"),
                format!("{origin}/garcon/%2fother"),
                format!("http://{host}:3002/garcon/"),
                format!("https://{host}:3001/garcon/"),
                "http://other.vpn.test:3001/garcon/".into(),
                "http://203.0.113.8:3001/garcon/".into(),
            ] {
                assert!(
                    !deployment.allows(&Url::parse(&target).unwrap()),
                    "{target}"
                );
            }
            for input in [
                format!("http://user:secret@{host}:3001/"),
                format!("{origin}/?token=secret"),
                format!("{origin}/#secret"),
                format!("{origin}/a%2fb"),
            ] {
                assert!(Deployment::parse(&input).is_err(), "{input}");
            }
        }
    }

    #[test]
    fn navigation_stays_inside_the_selected_origin_and_mount() {
        let deployment = Deployment::parse("https://example.test/garcon").unwrap();
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
