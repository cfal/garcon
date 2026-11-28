use garcon_cases::{CaseError, unknown};
use garcon_contract::git_refs::{is_git_ref_kind, parse_git_ref_sort};
use serde_json::json;

use crate::helpers::{plain, recorded_cases};

#[test]
fn git_refs_cases_match() {
    recorded_cases(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/common/git-refs"),
        "git-refs",
        |function, args| match function {
            "isGitRefKind" => Ok(json!(is_git_ref_kind(
                unknown(function, args.first())?.as_ref()
            ))),
            "parseGitRefSort" => Ok(plain(parse_git_ref_sort(
                unknown(function, args.first())?.as_ref(),
                unknown(function, args.get(1))?.as_ref(),
            ))),
            _ => Err(CaseError::unhandled(function)),
        },
    );
}
