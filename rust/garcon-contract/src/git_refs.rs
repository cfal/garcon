//! Ports `common/git-refs.ts`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitRefKind {
    LocalBranch,
    RemoteBranch,
    Tag,
    Other,
}

pub const GIT_REF_KINDS: &[GitRefKind] = &[
    GitRefKind::LocalBranch,
    GitRefKind::RemoteBranch,
    GitRefKind::Tag,
    GitRefKind::Other,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitRefSortKey {
    Name,
    Updated,
}

pub const GIT_REF_SORT_KEYS: &[GitRefSortKey] = &[GitRefSortKey::Name, GitRefSortKey::Updated];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GitRefSortDirection {
    Asc,
    Desc,
}

pub const GIT_REF_SORT_DIRECTIONS: &[GitRefSortDirection] =
    &[GitRefSortDirection::Asc, GitRefSortDirection::Desc];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitRefSort {
    pub key: GitRefSortKey,
    pub direction: GitRefSortDirection,
}

pub const DEFAULT_GIT_REF_SORT: GitRefSort = GitRefSort {
    key: GitRefSortKey::Name,
    direction: GitRefSortDirection::Asc,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitRefResultLimits {
    pub default: usize,
    pub max: usize,
}

pub const GIT_REF_RESULT_LIMITS: GitRefResultLimits = GitRefResultLimits {
    default: 200,
    max: 500,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRefOption {
    pub name: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub kind: GitRefKind,
    pub updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_current: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitRefsResponse {
    pub refs: Vec<GitRefOption>,
}

pub fn is_git_ref_kind(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some("local-branch" | "remote-branch" | "tag" | "other")
    )
}

pub fn parse_git_ref_sort(key: &Value, direction: &Value) -> Option<GitRefSort> {
    if key.is_null() && direction.is_null() {
        return Some(DEFAULT_GIT_REF_SORT);
    }
    let key = match key.as_str()? {
        "name" => GitRefSortKey::Name,
        "updated" => GitRefSortKey::Updated,
        _ => return None,
    };
    let direction = match direction.as_str()? {
        "asc" => GitRefSortDirection::Asc,
        "desc" => GitRefSortDirection::Desc,
        _ => return None,
    };
    Some(GitRefSort { key, direction })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_only_when_both_sort_values_are_absent() {
        assert_eq!(
            parse_git_ref_sort(&Value::Null, &Value::Null),
            Some(DEFAULT_GIT_REF_SORT)
        );
        assert_eq!(parse_git_ref_sort(&json!("name"), &Value::Null), None);
        assert_eq!(parse_git_ref_sort(&Value::Null, &json!("asc")), None);
    }

    #[test]
    fn accepts_every_supported_sort_pair() {
        for &key in GIT_REF_SORT_KEYS {
            for &direction in GIT_REF_SORT_DIRECTIONS {
                assert_eq!(
                    parse_git_ref_sort(&json!(key), &json!(direction)),
                    Some(GitRefSort { key, direction })
                );
            }
        }
    }

    #[test]
    fn rejects_empty_and_unknown_sort_values() {
        for (key, direction) in [("", ""), ("created", "asc"), ("name", "forward")] {
            assert_eq!(parse_git_ref_sort(&json!(key), &json!(direction)), None);
        }
    }

    #[test]
    fn accepts_only_canonical_ref_kinds() {
        for kind in GIT_REF_KINDS {
            assert!(is_git_ref_kind(&json!(kind)));
        }
        assert!(!is_git_ref_kind(&json!("branch")));
        assert!(!is_git_ref_kind(&Value::Null));
    }
}
