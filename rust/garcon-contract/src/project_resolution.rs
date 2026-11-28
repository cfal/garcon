//! Ports `common/project-resolution.ts`.

use std::fmt;

use async_trait::async_trait;
use garcon_js::{OptionalNullable, trim};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

use crate::chat_id::parse_chat_id;
use crate::executor_path::ExecutorPath;
use crate::executors::{ExecutorId, effective_executor_id, is_executor_id};

/// A project an operation runs in: the one a chat is bound to, or a path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ProjectTarget {
    Chat {
        chat_id: String,
        #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
        executor_id: OptionalNullable<ExecutorId>,
        project_path: String,
    },
    Path {
        #[serde(default, skip_serializing_if = "OptionalNullable::is_absent")]
        executor_id: OptionalNullable<ExecutorId>,
        project_path: String,
    },
}

pub const PROJECT_UNAVAILABLE_REASONS: &[ProjectUnavailableReason] = &[
    ProjectUnavailableReason::NotFound,
    ProjectUnavailableReason::NotADirectory,
    ProjectUnavailableReason::OutsideBase,
    ProjectUnavailableReason::PermissionDenied,
];

/// Why a project path cannot be used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectUnavailableReason {
    NotFound,
    NotADirectory,
    OutsideBase,
    PermissionDenied,
}

impl ProjectUnavailableReason {
    pub fn as_str(self) -> &'static str {
        match self {
            ProjectUnavailableReason::NotFound => "not-found",
            ProjectUnavailableReason::NotADirectory => "not-a-directory",
            ProjectUnavailableReason::OutsideBase => "outside-base",
            ProjectUnavailableReason::PermissionDenied => "permission-denied",
        }
    }
}

impl fmt::Display for ProjectUnavailableReason {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Whether a project path can be used, and under which key when it can.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ProjectResolution {
    Available { effective_project_key: ExecutorPath },
    Unavailable { reason: ProjectUnavailableReason },
}

/// The options a project inspection takes.
#[derive(Debug, Clone, Default)]
pub struct ProjectInspectOptions {
    /// Cancels the inspection.
    pub signal: Option<CancellationToken>,
    pub timeout_ms: Option<f64>,
    pub dispatch_deadline: Option<f64>,
}

/// Resolves a project path on an executor (`ProjectInspector`). The executor
/// is the Local one when `executor_id` is absent or `null`.
#[async_trait(?Send)]
pub trait ProjectInspector {
    async fn inspect(
        &self,
        project_path: ExecutorPath,
        executor_id: OptionalNullable<ExecutorId>,
        options: Option<ProjectInspectOptions>,
    ) -> ProjectResolution;
}

/// What an executor answered about a project path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectResolutionResponse {
    pub target: ProjectTarget,
    pub resolution: ProjectResolution,
}

/// A key that tells two targets apart: a declared chat and a raw path are
/// keyed separately, and an absent or `null` executor is the Local one.
pub fn project_target_key(target: &ProjectTarget) -> String {
    let (kind, chat_id, executor_id, project_path) = match target {
        ProjectTarget::Chat {
            chat_id,
            executor_id,
            project_path,
        } => ("chat", Some(chat_id), executor_id, project_path),
        ProjectTarget::Path {
            executor_id,
            project_path,
        } => ("path", None, executor_id, project_path),
    };
    let mut parts = vec![Value::String(kind.to_owned())];
    parts.extend(chat_id.map(|chat_id| Value::String(chat_id.clone())));
    parts.push(Value::String(effective_executor_id(executor_id.as_deref())));
    parts.push(Value::String(project_path.clone()));
    garcon_js::json::stringify(&Value::Array(parts))
}

/// Whether `value` names a reason a project path cannot be used.
pub fn is_project_unavailable_reason(value: &Value) -> Option<ProjectUnavailableReason> {
    let text = value.as_str()?;
    PROJECT_UNAVAILABLE_REASONS
        .iter()
        .copied()
        .find(|reason| reason.as_str() == text)
}

/// Reads what an executor answered about a project path, or `None` when the
/// answer holds a field it has no place for or lacks one it needs.
pub fn parse_project_resolution_response(value: &Value) -> Option<ProjectResolutionResponse> {
    let object = value.as_object()?;
    if !has_exact_keys(object, &["target", "resolution"]) {
        return None;
    }
    let target = parse_project_target(object.get("target")?)?;
    let resolution = parse_project_resolution(object.get("resolution")?)?;
    Some(ProjectResolutionResponse { target, resolution })
}

fn parse_project_target(value: &Value) -> Option<ProjectTarget> {
    let object = value.as_object()?;
    let project_path = object
        .get("projectPath")
        .and_then(Value::as_str)
        .filter(|project_path| !trim(project_path).is_empty())?;
    let executor_id = match object.get("executorId") {
        None => OptionalNullable::ABSENT,
        Some(Value::Null) => OptionalNullable::NULL,
        Some(executor_id) if is_executor_id(executor_id) => {
            // INFALLIBLE: `is_executor_id` accepted a string.
            let executor_id = executor_id.as_str().expect("an executor ID is a string");
            OptionalNullable::some(executor_id.to_owned())
        }
        Some(_) => return None,
    };
    let has_executor = object.contains_key("executorId");
    let kind = object.get("kind").and_then(Value::as_str);
    if kind == Some("path")
        && has_exact_keys(
            object,
            if has_executor {
                &["kind", "projectPath", "executorId"]
            } else {
                &["kind", "projectPath"]
            },
        )
    {
        return Some(ProjectTarget::Path {
            executor_id,
            project_path: project_path.to_owned(),
        });
    }
    if kind != Some("chat")
        || !has_exact_keys(
            object,
            if has_executor {
                &["kind", "chatId", "projectPath", "executorId"]
            } else {
                &["kind", "chatId", "projectPath"]
            },
        )
    {
        return None;
    }
    // The chat ID is read as a canonical one, whatever its value is here.
    let chat_id = parse_chat_id(object.get("chatId")?).ok()?;
    Some(ProjectTarget::Chat {
        chat_id: chat_id.as_str().to_owned(),
        executor_id,
        project_path: project_path.to_owned(),
    })
}

fn parse_project_resolution(value: &Value) -> Option<ProjectResolution> {
    let object = value.as_object()?;
    let kind = |kind: &str| object.get("kind").and_then(Value::as_str) == Some(kind);
    if kind("available")
        && has_exact_keys(object, &["kind", "effectiveProjectKey"])
        && let Some(effective_project_key) = object
            .get("effectiveProjectKey")
            .and_then(Value::as_str)
            .filter(|key| !trim(key).is_empty())
    {
        return Some(ProjectResolution::Available {
            effective_project_key: effective_project_key.to_owned(),
        });
    }
    if kind("unavailable")
        && has_exact_keys(object, &["kind", "reason"])
        && let Some(reason) = object.get("reason").and_then(is_project_unavailable_reason)
    {
        return Some(ProjectResolution::Unavailable { reason });
    }
    None
}

/// Whether `object` has exactly the own keys `keys` names, as many as there
/// are and no other.
fn has_exact_keys(object: &Map<String, Value>, keys: &[&str]) -> bool {
    object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const CHAT_ID: &str = "1783725900000800";

    fn chat_target(executor_id: OptionalNullable<ExecutorId>) -> ProjectTarget {
        ProjectTarget::Chat {
            chat_id: CHAT_ID.to_owned(),
            executor_id,
            project_path: "/project".to_owned(),
        }
    }

    #[test]
    fn round_trips_both_target_and_resolution_variants() {
        let chat = parse_project_resolution_response(&json!({
            "target": { "kind": "chat", "chatId": CHAT_ID, "projectPath": "/workspace/project" },
            "resolution": { "kind": "available", "effectiveProjectKey": "/real/project" },
        }))
        .unwrap();
        assert_eq!(
            chat,
            ProjectResolutionResponse {
                target: ProjectTarget::Chat {
                    chat_id: CHAT_ID.to_owned(),
                    executor_id: OptionalNullable::ABSENT,
                    project_path: "/workspace/project".to_owned(),
                },
                resolution: ProjectResolution::Available {
                    effective_project_key: "/real/project".to_owned(),
                },
            }
        );
        let path = parse_project_resolution_response(&json!({
            "target": { "kind": "path", "projectPath": "/workspace/missing" },
            "resolution": { "kind": "unavailable", "reason": "not-found" },
        }))
        .unwrap();
        assert_eq!(
            path,
            ProjectResolutionResponse {
                target: ProjectTarget::Path {
                    executor_id: OptionalNullable::ABSENT,
                    project_path: "/workspace/missing".to_owned(),
                },
                resolution: ProjectResolution::Unavailable {
                    reason: ProjectUnavailableReason::NotFound,
                },
            }
        );
    }

    #[test]
    fn rejects_malformed_and_open_ended_payloads() {
        for value in [
            Value::Null,
            json!({}),
            json!({
                "target": { "kind": "chat", "chatId": "chat", "projectPath": "/workspace/project" },
                "resolution": { "kind": "available", "effectiveProjectKey": "/real/project" },
            }),
            json!({
                "target": { "kind": "path", "projectPath": " " },
                "resolution": { "kind": "unavailable", "reason": "missing" },
            }),
            json!({
                "target": { "kind": "path", "projectPath": "/workspace/project", "extra": true },
                "resolution": { "kind": "available", "effectiveProjectKey": "/real/project" },
            }),
            json!({
                "target": { "kind": "path", "projectPath": "/workspace/project" },
                "resolution": { "kind": "available", "effectiveProjectKey": "", "reason": "not-found" },
            }),
        ] {
            assert_eq!(parse_project_resolution_response(&value), None, "{value}");
        }
    }

    #[test]
    fn keys_declared_chat_and_raw_path_targets_separately() {
        assert_ne!(
            project_target_key(&chat_target(OptionalNullable::ABSENT)),
            project_target_key(&ProjectTarget::Path {
                executor_id: OptionalNullable::ABSENT,
                project_path: "/project".to_owned(),
            })
        );
    }

    #[test]
    fn keys_name_the_effective_executor() {
        let path = |executor_id: OptionalNullable<ExecutorId>| ProjectTarget::Path {
            executor_id,
            project_path: "/project \"a\"\n".to_owned(),
        };
        // An absent and a `null` executor are both the Local one.
        assert_eq!(
            project_target_key(&path(OptionalNullable::ABSENT)),
            r#"["path","local","/project \"a\"\n"]"#
        );
        assert_eq!(
            project_target_key(&path(OptionalNullable::NULL)),
            r#"["path","local","/project \"a\"\n"]"#
        );
        let remote = "22222222-2222-4222-8222-222222222222";
        assert_eq!(
            project_target_key(&path(OptionalNullable::some(remote.to_owned()))),
            r#"["path","22222222-2222-4222-8222-222222222222","/project \"a\"\n"]"#
        );
        assert_eq!(
            project_target_key(&chat_target(OptionalNullable::NULL)),
            r#"["chat","1783725900000800","local","/project"]"#
        );
    }

    #[test]
    fn reads_an_executor_and_keeps_it_as_it_came() {
        let remote = "22222222-2222-4222-8222-222222222222";
        let resolution = json!({ "kind": "available", "effectiveProjectKey": "/real" });
        for (executor, expected) in [
            (json!(null), OptionalNullable::NULL),
            (json!("local"), OptionalNullable::some("local".to_owned())),
            (json!(remote), OptionalNullable::some(remote.to_owned())),
        ] {
            let target = json!({ "kind": "path", "executorId": executor, "projectPath": "/w" });
            let response = parse_project_resolution_response(
                &json!({ "target": target, "resolution": resolution }),
            );
            assert_eq!(
                response.map(|response| response.target),
                Some(ProjectTarget::Path {
                    executor_id: expected,
                    project_path: "/w".to_owned(),
                }),
                "{executor}"
            );
        }
        let chat = json!({ "kind": "chat", "chatId": CHAT_ID, "executorId": "local", "projectPath": "/w" });
        let response = parse_project_resolution_response(&json!({
            "target": chat,
            "resolution": resolution,
        }))
        .unwrap();
        assert_eq!(
            response.target,
            ProjectTarget::Chat {
                chat_id: CHAT_ID.to_owned(),
                executor_id: OptionalNullable::some("local".to_owned()),
                project_path: "/w".to_owned(),
            }
        );
        // An executor ID that names no executor rejects the target, whatever
        // its type; the executor is checked before the keys are.
        for target in [
            json!({ "kind": "path", "executorId": "worker", "projectPath": "/w" }),
            json!({ "kind": "path", "executorId": 5, "projectPath": "/w" }),
            json!({ "kind": "path", "executorId": "LOCAL", "projectPath": "/w" }),
            json!({ "kind": "path", "executorId": " local ", "projectPath": "/w" }),
        ] {
            let response = parse_project_resolution_response(&json!({
                "target": target,
                "resolution": resolution,
            }));
            assert_eq!(response, None, "{target}");
        }
    }

    #[test]
    fn reads_each_reason_and_rejects_any_other() {
        for (reason, expected) in [
            ("not-found", Some(ProjectUnavailableReason::NotFound)),
            (
                "not-a-directory",
                Some(ProjectUnavailableReason::NotADirectory),
            ),
            ("outside-base", Some(ProjectUnavailableReason::OutsideBase)),
            (
                "permission-denied",
                Some(ProjectUnavailableReason::PermissionDenied),
            ),
        ] {
            assert_eq!(is_project_unavailable_reason(&json!(reason)), expected);
            assert_eq!(
                expected.map(|reason| reason.to_string()),
                Some(reason.to_owned())
            );
            let response = parse_project_resolution_response(&json!({
                "target": { "kind": "path", "projectPath": "/w" },
                "resolution": { "kind": "unavailable", "reason": reason },
            }));
            assert_eq!(
                response.map(|response| response.resolution),
                Some(ProjectResolution::Unavailable {
                    reason: expected.unwrap(),
                }),
            );
        }
        for other in [
            json!("missing"),
            json!("NotFound"),
            json!(null),
            json!(5),
            json!([]),
        ] {
            assert_eq!(is_project_unavailable_reason(&other), None, "{other}");
            let response = parse_project_resolution_response(&json!({
                "target": { "kind": "path", "projectPath": "/w" },
                "resolution": { "kind": "unavailable", "reason": other },
            }));
            assert_eq!(response, None, "{other}");
        }
    }

    #[test]
    fn writes_a_target_and_a_resolution_in_the_original_shape() {
        let target = ProjectTarget::Chat {
            chat_id: CHAT_ID.to_owned(),
            executor_id: OptionalNullable::NULL,
            project_path: "/w".to_owned(),
        };
        assert_eq!(
            serde_json::to_string(&target).unwrap(),
            r#"{"kind":"chat","chatId":"1783725900000800","executorId":null,"projectPath":"/w"}"#
        );
        assert_eq!(
            serde_json::to_string(&chat_target(OptionalNullable::ABSENT)).unwrap(),
            r#"{"kind":"chat","chatId":"1783725900000800","projectPath":"/project"}"#
        );
        assert_eq!(
            serde_json::to_string(&ProjectResolution::Unavailable {
                reason: ProjectUnavailableReason::NotADirectory,
            })
            .unwrap(),
            r#"{"kind":"unavailable","reason":"not-a-directory"}"#
        );
        assert_eq!(
            serde_json::to_string(&ProjectResolution::Available {
                effective_project_key: "/real".to_owned(),
            })
            .unwrap(),
            r#"{"kind":"available","effectiveProjectKey":"/real"}"#
        );
    }
}
