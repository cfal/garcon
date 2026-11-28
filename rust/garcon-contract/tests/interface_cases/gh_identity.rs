//! The recorded cases of `common/gh-identity.ts`.

use garcon_cases::{CaseError, round_tripped, unknown};
use garcon_contract::gh::GhRepositoryIdentity;
use garcon_contract::gh_identity::{
    gh_repository_identity, is_gh_actor_identity, is_gh_repository_identity, same_gh_repository,
};
use serde_json::{Value, json};

use super::helpers::{self, plain};

fn identity_argument(
    function: &str,
    argument: Option<&Value>,
) -> Result<GhRepositoryIdentity, CaseError> {
    serde_json::from_value(unknown(function, argument)?.into_owned())
        .map_err(|_| CaseError::unhandled(function))
}

fn dispatch_gh_identity(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    match function {
        "isGhRepositoryIdentity" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_gh_repository_identity(&value)))
        }
        "isGhActorIdentity" => {
            let value = unknown(function, args.first())?;
            Ok(json!(is_gh_actor_identity(&value)))
        }
        "ghRepositoryIdentity" => {
            // The original takes a typed repository, of a name and a URL.
            let repository = round_tripped(function, args.first())?;
            let text = |key: &str| -> Result<&str, CaseError> {
                repository
                    .as_deref()
                    .and_then(|repository| repository.get(key))
                    .and_then(Value::as_str)
                    .ok_or_else(|| CaseError::unhandled(function))
            };
            Ok(plain(gh_repository_identity(
                text("nameWithOwner")?,
                text("url")?,
            )))
        }
        "sameGhRepository" => {
            let left = identity_argument(function, args.first())?;
            let right = identity_argument(function, args.get(1))?;
            Ok(json!(same_gh_repository(&left, &right)))
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn gh_identity_cases_match() {
    helpers::recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/gh-identity"
        ),
        "common/gh-identity.ts",
        dispatch_gh_identity,
    );
}
