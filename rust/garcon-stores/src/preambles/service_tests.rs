use std::cell::RefCell;

use garcon_contract::project_resolution::{
    ProjectInspectOptions, ProjectResolution, ProjectUnavailableReason,
};
use garcon_js::OptionalNullable;
use serde_json::json;

use super::*;

const REMOTE: &str = "11111111-1111-4111-8111-111111111111";

#[derive(Default)]
struct Inspector(RefCell<Vec<(String, Option<String>)>>);

#[async_trait::async_trait(?Send)]
impl ProjectInspector for Inspector {
    async fn inspect(
        &self,
        path: String,
        executor: OptionalNullable<String>,
        options: Option<ProjectInspectOptions>,
    ) -> ProjectResolution {
        assert!(options.is_none());
        self.0
            .borrow_mut()
            .push((path.clone(), executor.as_option().cloned()));
        let reason = match path.as_str() {
            "/absent" => ProjectUnavailableReason::NotFound,
            "/outside" => ProjectUnavailableReason::OutsideBase,
            "/file" => ProjectUnavailableReason::NotADirectory,
            "/private" => ProjectUnavailableReason::PermissionDenied,
            _ => {
                return ProjectResolution::Available {
                    effective_project_key: "/canonical".into(),
                };
            }
        };
        ProjectResolution::Unavailable { reason }
    }
}

fn definition(rules: Value) -> Value {
    json!({"enabled":true,"title":"Scoped","content":"Fixture", "scope":{"type":"project-paths","rules":rules}})
}

#[tokio::test]
async fn unchanged_scope_uses_effective_executor_identity_without_inspection() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let inspector = Rc::new(Inspector::default());
            let previous = definition(json!([
                {"projectPath":"/absent","includeNested":false},
                {"projectPath":"/private","includeNested":true,"executorId":REMOTE},
            ]));
            let current = normalize_preamble_definition_input(&previous).unwrap();
            let updated = definition(json!([
                {"projectPath":"/absent","includeNested":false,"executorId":null},
                {"projectPath":"/private","includeNested":true,"executorId":REMOTE},
                {"projectPath":"/alias","includeNested":true,"executorId":REMOTE},
            ]));
            let next = validate_definition(&updated, Some(&current), inspector.clone())
                .await
                .unwrap();
            assert_eq!(
                inspector.0.borrow().as_slice(),
                [("/alias".into(), Some(REMOTE.into()))]
            );
            let PreambleScope::ProjectPaths { rules } = next.scope else {
                panic!("expected rules")
            };
            assert_eq!(
                rules
                    .iter()
                    .map(|rule| rule.project_path.as_str())
                    .collect::<Vec<_>>(),
                ["/absent", "/private", "/canonical"]
            );
            let changed_nested =
                definition(json!([{"projectPath":"/absent","includeNested":true}]));
            let error = validate_definition(&changed_nested, Some(&current), inspector.clone())
                .await
                .unwrap_err();
            assert_eq!(
                error.downcast_ref::<PreambleDomainError>().unwrap().code,
                PreambleErrorCode::PROJECT_PATH_NOT_FOUND
            );
        })
        .await;
}

#[tokio::test]
async fn canonical_aliases_conflict_only_when_the_executor_is_the_same() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let inspector = Rc::new(Inspector::default());
            let different = definition(json!([
                {"projectPath":"/a","includeNested":true},
                {"projectPath":"/b","includeNested":false,"executorId":REMOTE},
            ]));
            assert!(
                validate_definition(&different, None, inspector.clone())
                    .await
                    .is_ok()
            );
            let same = definition(json!([
                {"projectPath":"/a","includeNested":true},
                {"projectPath":"/b","includeNested":false,"executorId":null},
            ]));
            assert_eq!(
                validate_definition(&same, None, inspector)
                    .await
                    .unwrap_err()
                    .to_string(),
                "Project paths must be unique"
            );
        })
        .await;
}

#[tokio::test]
async fn preserves_project_error_codes_statuses_and_text() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let inspector = Rc::new(Inspector::default());
            for (path, code, status, message) in [
                (
                    "/absent",
                    PreambleErrorCode::PROJECT_PATH_NOT_FOUND,
                    404,
                    "Project path not found: /absent",
                ),
                (
                    "/outside",
                    PreambleErrorCode::PROJECT_PATH_OUTSIDE_BASE,
                    403,
                    "Project path is outside the allowed base directory",
                ),
                (
                    "/file",
                    PreambleErrorCode::PROJECT_PATH_NOT_DIRECTORY,
                    400,
                    "Project path is not a directory: /file",
                ),
                (
                    "/private",
                    PreambleErrorCode::PROJECT_PATH_INACCESSIBLE,
                    403,
                    "Project path is not accessible: /private",
                ),
            ] {
                let request = definition(json!([{"projectPath":path,"includeNested":false}]));
                let error = validate_definition(&request, None, inspector.clone())
                    .await
                    .unwrap_err();
                let error = error.downcast_ref::<PreambleDomainError>().unwrap();
                assert_eq!(
                    (error.code, error.status, error.message.as_str()),
                    (code, status, message)
                );
            }
        })
        .await;
}
