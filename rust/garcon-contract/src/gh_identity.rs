//! Ports `common/gh-identity.ts`.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::gh::GhRepositoryIdentity;
use garcon_js::utf16;

// The original's patterns carry the `i` flag without `u`, which folds ASCII
// letters only; the same is written as `(?i-u)` here.
static REPOSITORY_NAME_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the original holds the same pattern as a regular expression literal.
    Regex::new(r"(?i-u)^[a-z0-9][a-z0-9-]*/[a-z0-9_.-]+$")
        .expect("the repository name pattern compiles")
});
static HOST_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the original holds the same pattern as a regular expression literal.
    Regex::new(r"(?i-u)^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
        .expect("the host pattern compiles")
});

/// Whether a host and an `owner/name` are spelled as GitHub spells them.
fn is_repository_identity(host: &str, name_with_owner: &str) -> bool {
    utf16::len(host) <= 253
        && HOST_PATTERN.is_match(host)
        && utf16::len(name_with_owner) <= 140
        && REPOSITORY_NAME_PATTERN.is_match(name_with_owner)
}

/// Whether `value` is the identity of a GitHub repository: a host and an
/// `owner/name`, and nothing else.
pub fn is_gh_repository_identity(value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    let fields = || {
        Some((
            input.get("host").and_then(Value::as_str)?,
            input.get("nameWithOwner").and_then(Value::as_str)?,
        ))
    };
    input
        .keys()
        .all(|key| key == "host" || key == "nameWithOwner")
        && fields()
            .is_some_and(|(host, name_with_owner)| is_repository_identity(host, name_with_owner))
}

/// Whether `value` is the identity of a GitHub account: an ID and a login,
/// and nothing else.
pub fn is_gh_actor_identity(value: &Value) -> bool {
    let Some(input) = value.as_object() else {
        return false;
    };
    let is_identifier = |value: Option<&Value>| {
        value.and_then(Value::as_str).is_some_and(|text| {
            let length = utf16::len(text);
            length > 0 && length <= 256 && !text.contains('\0')
        })
    };
    input.keys().all(|key| key == "id" || key == "login")
        && is_identifier(input.get("id"))
        && is_identifier(input.get("login"))
}

/// The identity of the repository a `url` names, when the URL is the plain
/// `https` address of `name_with_owner` on its host. Repository URLs bind
/// persisted names to the GitHub host that owns them.
pub fn gh_repository_identity(name_with_owner: &str, url: &str) -> Option<GhRepositoryIdentity> {
    let url = url::Url::parse(url).ok()?;
    let identity = GhRepositoryIdentity {
        host: url.host_str().unwrap_or_default().to_lowercase(),
        name_with_owner: name_with_owner.to_lowercase(),
    };
    let path = url.path();
    // `search` and `hash` are empty for a bare `?` or `#`, which the original
    // therefore reads as absent.
    let search = url.query().unwrap_or_default();
    let hash = url.fragment().unwrap_or_default();
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some_and(|password| !password.is_empty())
        || url.port().is_some()
        || !search.is_empty()
        || !hash.is_empty()
        || path.strip_suffix('/').unwrap_or(path).to_lowercase()
            != format!("/{}", identity.name_with_owner)
        || !is_repository_identity(&identity.host, &identity.name_with_owner)
    {
        return None;
    }
    Some(identity)
}

/// Whether two identities name the same repository.
pub fn same_gh_repository(left: &GhRepositoryIdentity, right: &GhRepositoryIdentity) -> bool {
    left.host.to_lowercase() == right.host.to_lowercase()
        && left.name_with_owner.to_lowercase() == right.name_with_owner.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn repository_identity_includes_the_host_and_agrees_with_the_canonical_url() {
        let repository = GhRepositoryIdentity {
            host: "github.example.invalid".to_owned(),
            name_with_owner: "acme/app".to_owned(),
        };
        assert_eq!(
            gh_repository_identity("Acme/App", "https://GitHub.example.invalid/Acme/App/"),
            Some(repository.clone())
        );
        assert!(same_gh_repository(
            &repository,
            &GhRepositoryIdentity {
                host: repository.host.clone(),
                name_with_owner: "Acme/App".to_owned()
            }
        ));
        assert!(!same_gh_repository(
            &repository,
            &GhRepositoryIdentity {
                host: "another.example.invalid".to_owned(),
                name_with_owner: repository.name_with_owner.clone()
            }
        ));
        for url in [
            "https://github.example.invalid/other/app",
            "https://viewer@github.example.invalid/acme/app",
            "http://github.example.invalid/acme/app",
        ] {
            assert_eq!(gh_repository_identity("acme/app", url), None, "{url}");
        }
    }

    #[test]
    fn identities_hold_their_fields_and_nothing_else() {
        assert!(is_gh_repository_identity(
            &json!({ "host": "github.example.invalid", "nameWithOwner": "acme/app" })
        ));
        assert!(!is_gh_repository_identity(
            &json!({ "host": "github.example.invalid", "nameWithOwner": "acme/app", "extra": 1 })
        ));
        assert!(!is_gh_repository_identity(
            &json!({ "host": "--invalid", "nameWithOwner": "acme/app" })
        ));
        assert!(!is_gh_repository_identity(
            &json!({ "nameWithOwner": "acme/app" })
        ));
        assert!(is_gh_actor_identity(
            &json!({ "id": "actor-a", "login": "viewer" })
        ));
        assert!(!is_gh_actor_identity(&json!({ "login": "viewer" })));
        assert!(!is_gh_actor_identity(
            &json!({ "id": "", "login": "viewer" })
        ));
        assert!(!is_gh_repository_identity(&json!(null)));
        assert!(!is_gh_repository_identity(&json!("acme/app")));
    }
}
