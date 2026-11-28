//! The recorded cases of `common/file-contracts.ts`.

use garcon_cases::{CaseError, text, unknown};
use garcon_contract::file_contracts::{
    directory_name_problem, is_file_revision, parse_create_directory_request,
    parse_directory_entry, parse_file_identity_response, parse_file_revision_response,
    parse_file_tree_response, parse_read_text_response, parse_save_text_request,
    parse_save_text_response,
};
use serde_json::{Value, json};

use super::helpers::{self, optional, plain};

fn dispatch_file_contracts(function: &str, args: &[Value]) -> Result<Value, CaseError> {
    // Each parser takes `unknown`, which reads `undefined` as any other non-record.
    let argument = |function: &str| unknown(function, args.first());
    match function {
        "isFileRevision" => {
            let value = argument(function)?;
            Ok(json!(is_file_revision(&value)))
        }
        "directoryNameProblem" => {
            // The original takes a typed string.
            let name =
                text(function, args.first())?.ok_or_else(|| CaseError::unhandled(function))?;
            Ok(optional(directory_name_problem(name), |problem| {
                json!(problem)
            }))
        }
        "parseFileRevisionResponse" => {
            let value = argument(function)?;
            Ok(plain(parse_file_revision_response(&value)))
        }
        "parseReadTextResponse" => {
            let value = argument(function)?;
            Ok(plain(parse_read_text_response(&value)))
        }
        "parseSaveTextRequest" => {
            let value = argument(function)?;
            Ok(plain(parse_save_text_request(&value)))
        }
        "parseCreateDirectoryRequest" => {
            let value = argument(function)?;
            Ok(plain(parse_create_directory_request(&value)))
        }
        "parseDirectoryEntry" => {
            let value = argument(function)?;
            Ok(plain(parse_directory_entry(&value)))
        }
        "parseSaveTextResponse" => {
            let value = argument(function)?;
            Ok(plain(parse_save_text_response(&value)))
        }
        "parseFileIdentityResponse" => {
            let value = argument(function)?;
            Ok(plain(parse_file_identity_response(&value)))
        }
        "parseFileTreeResponse" => {
            let value = argument(function)?;
            let result = parse_file_tree_response(&value);
            Ok(garcon_js::json::parse(&serde_json::to_string(&result).unwrap()).unwrap())
        }
        _ => Err(CaseError::unhandled(function)),
    }
}

#[test]
fn file_contracts_cases_match() {
    helpers::recorded_cases(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/common/file-contracts"
        ),
        "common/file-contracts.ts",
        dispatch_file_contracts,
    );
}
