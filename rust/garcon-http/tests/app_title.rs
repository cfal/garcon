use garcon_cases::{CaseError, replay, text, unknown};
use garcon_http::app_title::{
    PublicAppTitle, app_title_bootstrap_script, apply_manifest_title, escape_html,
    inject_app_title_into_shell,
};
use serde_json::{Value, json};

fn title_input(function: &str, value: Option<&Value>) -> Result<PublicAppTitle, CaseError> {
    serde_json::from_value(unknown(function, value)?.into_owned())
        .map_err(|error| CaseError::unhandled(&format!("{function}: {error}")))
}

#[test]
fn renders_titles_and_manifests_as_the_original_does() {
    replay(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/app-title"),
        |function, args| {
            let input = || text(function, args.first()).map(|value| value.unwrap_or_default());
            match function {
                "escapeHtml" => Ok(json!(escape_html(input()?))),
                "appTitleBootstrapScript" => Ok(json!(app_title_bootstrap_script(&title_input(
                    function,
                    args.first(),
                )?))),
                "injectAppTitleIntoShell" => Ok(json!(inject_app_title_into_shell(
                    input()?,
                    &title_input(function, args.get(1))?,
                ))),
                "applyManifestTitle" => Ok(json!(
                    apply_manifest_title(input()?, &title_input(function, args.get(1))?)
                        .map_err(|error| CaseError::unhandled(&format!("{function}: {error}")))?
                )),
                _ => Err(CaseError::unhandled(function)),
            }
        },
    );
}

#[test]
fn rejects_a_malformed_manifest() {
    assert!(apply_manifest_title("{", &PublicAppTitle::default()).is_err());
}
