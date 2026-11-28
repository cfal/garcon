//! Environment proxy selection for Bun's provider requests.

use std::net::IpAddr;

use ipnet::IpNet;
use reqwest::Url;

enum BypassHost {
    Network(IpNet),
    Domain(String),
}

struct Bypass {
    host: BypassHost,
    port: Option<u16>,
}

impl Bypass {
    fn parse(token: &str) -> Option<Self> {
        let token = token.trim();
        if token.is_empty() {
            return None;
        }
        let (host, port) = if let Some(bracketed) = token.strip_prefix('[') {
            let (host, tail) = bracketed.split_once(']')?;
            let port = if tail.is_empty() {
                None
            } else {
                Some(tail.strip_prefix(':')?.parse().ok()?)
            };
            (host, port)
        } else if token.split(':').count() == 2 {
            let (host, port) = token.rsplit_once(':')?;
            (host, Some(port.parse().ok()?))
        } else {
            (token, None)
        };
        let host = host.trim_start_matches('.');
        let host = if let Ok(network) = host.parse::<IpNet>() {
            BypassHost::Network(network)
        } else if let Ok(ip) = host.parse::<IpAddr>() {
            BypassHost::Network(IpNet::from(ip))
        } else {
            BypassHost::Domain(host.to_ascii_lowercase())
        };
        Some(Self { host, port })
    }

    fn matches(&self, url: &Url) -> bool {
        if self
            .port
            .is_some_and(|port| url.port_or_known_default() != Some(port))
        {
            return false;
        }
        let Some(host) = url.host_str() else {
            return false;
        };
        match &self.host {
            BypassHost::Network(network) => host
                .trim_matches(['[', ']'])
                .parse::<IpAddr>()
                .is_ok_and(|ip| network.contains(&ip)),
            BypassHost::Domain(domain) => {
                host == domain
                    || host
                        .strip_suffix(domain)
                        .is_some_and(|prefix| prefix.ends_with('.'))
            }
        }
    }
}

pub(super) struct ProviderProxy {
    http: Option<String>,
    https: Option<String>,
    all: Option<String>,
    bypass_all: bool,
    bypass: Vec<Bypass>,
}

impl ProviderProxy {
    pub(super) fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Self {
        let read = |lower, upper| {
            lookup(lower)
                .filter(|value| !value.is_empty())
                .or_else(|| lookup(upper).filter(|value| !value.is_empty()))
        };
        let no_proxy = read("no_proxy", "NO_PROXY").unwrap_or_default();
        let entries = no_proxy.split(',');
        Self {
            http: read("http_proxy", "HTTP_PROXY"),
            https: read("https_proxy", "HTTPS_PROXY"),
            all: read("all_proxy", "ALL_PROXY"),
            bypass_all: entries.clone().any(|entry| entry.trim() == "*"),
            bypass: entries.filter_map(Bypass::parse).collect(),
        }
    }

    pub(super) fn for_url(&self, url: &Url) -> Option<String> {
        if self.bypass_all || self.bypass.iter().any(|entry| entry.matches(url)) {
            return None;
        }
        let specific = match url.scheme() {
            "http" => self.http.as_ref(),
            "https" => self.https.as_ref(),
            _ => return None,
        };
        specific.or(self.all.as_ref()).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_nonempty_lowercase_values_before_uppercase_values_and_all_proxy() {
        let read = |key: &str| match key {
            "http_proxy" => Some("http://lowercase".into()),
            "HTTP_PROXY" => Some("http://uppercase".into()),
            "https_proxy" => Some(String::new()),
            "HTTPS_PROXY" => Some("http://https-uppercase".into()),
            _ => None,
        };
        let proxy = ProviderProxy::from_lookup(read);
        assert_eq!(
            proxy
                .for_url(&Url::parse("http://fixture.invalid").unwrap())
                .as_deref(),
            Some("http://lowercase")
        );
        assert_eq!(
            proxy
                .for_url(&Url::parse("https://fixture.invalid").unwrap())
                .as_deref(),
            Some("http://https-uppercase")
        );
        let fallback = ProviderProxy::from_lookup(|key| match key {
            "HTTP_PROXY" => Some("http://only-for-http".into()),
            "ALL_PROXY" => Some("http://fallback".into()),
            _ => None,
        });
        assert_eq!(
            fallback
                .for_url(&Url::parse("https://fixture.invalid").unwrap())
                .as_deref(),
            Some("http://fallback")
        );
    }

    #[test]
    fn bypasses_exact_hosts_matching_ports_and_ip_networks() {
        let proxy = ProviderProxy::from_lookup(|key| match key {
            "ALL_PROXY" => Some("http://proxy.fixture.invalid".into()),
            "NO_PROXY" => Some(" .fixture.invalid:443, 127.0.0.0/8, [::1]:8080 ".into()),
            _ => None,
        });
        for value in [
            "https://sub.fixture.invalid",
            "http://127.0.0.42:8080",
            "http://[::1]:8080",
        ] {
            assert!(
                proxy.for_url(&Url::parse(value).unwrap()).is_none(),
                "{value}"
            );
        }
        for value in [
            "http://sub.fixture.invalid",
            "https://notfixture.invalid",
            "http://[::1]:8000",
        ] {
            assert!(
                proxy.for_url(&Url::parse(value).unwrap()).is_some(),
                "{value}"
            );
        }
    }
}
