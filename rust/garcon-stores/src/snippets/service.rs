//! Independent validation from `server/controller/snippets/service.ts`.

use garcon_contract::snippets::{
    ExpandSnippetRequest, SNIPPET_VALIDATION_ERROR_MESSAGE, SnippetDefinitionInput,
    SnippetErrorCode, normalize_expand_snippet_request, normalize_snippet_definition_input,
};
use garcon_js::trim;
use serde_json::Value;

use super::{Result, errors::SnippetDomainError};

pub fn validate_id(id: &str) -> Result<&str, SnippetDomainError> {
    let id = trim(id);
    if id.is_empty() {
        Err(validation_error())
    } else {
        Ok(id)
    }
}

pub fn validate_definition(value: &Value) -> Result<SnippetDefinitionInput, SnippetDomainError> {
    normalize_snippet_definition_input(value).ok_or_else(validation_error)
}

pub fn validate_expansion_request(
    value: &Value,
) -> Result<ExpandSnippetRequest, SnippetDomainError> {
    normalize_expand_snippet_request(value).ok_or_else(validation_error)
}

fn validation_error() -> SnippetDomainError {
    SnippetDomainError::new(
        SnippetErrorCode::VALIDATION_FAILED,
        SNIPPET_VALIDATION_ERROR_MESSAGE,
        400,
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn mutation_and_expansion_validation_does_not_consult_a_project_or_chat() {
        assert_eq!(validate_id(" \u{feff} item ").unwrap(), "item");
        assert_eq!(validate_id(" \u{feff} ").unwrap_err().status, 400);
        let good = validate_definition(&json!({
            "shortName":"fixture", "template":"Synthetic {{arguments}}", "defaultArguments":" a\n "
        }))
        .unwrap();
        assert_eq!(good.default_arguments, " a\n ");
        let rejected = validate_definition(&json!({
            "shortName":"fixture", "template":"No argument token", "defaultArguments":"unexpected"
        }))
        .unwrap_err();
        assert_eq!(rejected.code, SnippetErrorCode::VALIDATION_FAILED);
        let rejected = validate_expansion_request(&json!({
            "shortName":"fixture", "arguments":{"type":"default"},
            "context":{"type":"chat","chatId":"not-a-chat-id"}
        }))
        .unwrap_err();
        assert_eq!(rejected.message, SNIPPET_VALIDATION_ERROR_MESSAGE);
        assert!(
            validate_expansion_request(&json!({
                "shortName":"fixture", "arguments":{"type":"default"},
                "context":{"type":"new-chat","chatId":"1234567890123456","projectPath":"/workspace"}
            }))
            .is_ok()
        );
    }
}
