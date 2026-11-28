//! The recorded cases of `common/gh-identity.ts`.

use garcon_cases::{CaseError, round_tripped, unknown};
use garcon_contract::gh::GhRepositoryIdentity;
use garcon_contract::gh_identity::{
    gh_repository_identity, is_gh_actor_identity, is_gh_repository_identity, same_gh_repository,
};
use serde_json::{Value, json};

use super::helpers::{self, optional, plain};

/// A recorded argument as the typed identity it holds, once the original's
/// own guard accepts it; anything else cannot be handed to the port.
fn identity_argument(
    function: &str,
    argument: Option<&Value>,
) -> Result<GhRepositoryIdentity, CaseError> {
    let value = unknown(function, argument)?;
    if !is_gh_repository_identity(&value) {
        return Err(CaseError::unhandled(function));
    }
    let read = |key: &str| {
        value[key]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| CaseError::unhandled(function))
    };
    Ok(GhRepositoryIdentity {
        host: read("host")?,
        name_with_owner: read("nameWithOwner")?,
    })
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
            Ok(optional(
                gh_repository_identity(text("nameWithOwner")?, text("url")?),
                |identity| plain(Some(identity)),
            ))
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
