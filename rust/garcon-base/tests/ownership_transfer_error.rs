use std::{error::Error, io};

use garcon_base::{
    domain_error::{DomainError, DomainErrorKind, as_domain_error},
    errors::{ErrorInput, error_metadata},
    http_error::json_error_from_unknown,
};
use garcon_cases::{CaseError, replay, text};
use serde_json::json;

#[test]
fn ownership_transfer_pending_error_keeps_its_metadata_and_http_response_after_erasure() {
    replay(
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/cases/ownership-transfer-error"
        ),
        |function, args| {
            if function != "ownershipTransferError" {
                return Err(CaseError::unhandled(function));
            }
            let mut error = DomainError::new_ownership_transfer_pending();
            if let Some(cause) = text(function, args.first())? {
                error = error.with_cause(Box::new(io::Error::other(cause.to_owned())));
            }
            let error: Box<dyn Error> = Box::new(error);
            let domain = as_domain_error(error.as_ref());
            let metadata = error_metadata(error.as_ref());
            let response =
                json_error_from_unknown(ErrorInput::Error(error.as_ref()), None, None, None)
                    .map_err(|error| CaseError::undeliverable(error.to_string()))?;
            let body = std::str::from_utf8(response.body())
                .map_err(|error| CaseError::undeliverable(error.to_string()))?;
            Ok(json!({
                "recognized": domain.is_some(),
                "name": metadata.name,
                "code": metadata.code,
                "status": domain.map(|error| error.status),
                "message": error.to_string(),
                "retryable": domain.map(|error| error.retryable),
                "cause": error.source().map(ToString::to_string),
                "responseStatus": response.status().as_u16(),
                "response": body,
            }))
        },
    );
}

#[test]
fn the_handoff_error_can_be_matched_by_kind() {
    let error: Box<dyn Error> = Box::new(DomainError::new_ownership_transfer_pending());
    assert_eq!(
        as_domain_error(error.as_ref()).map(|domain| &domain.kind),
        Some(&DomainErrorKind::OwnershipTransferPending),
    );
}
