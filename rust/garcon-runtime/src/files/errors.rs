//! Ports `server/runtime/files/errors.ts`.

use std::error::Error;

use garcon_base::domain_error::DomainError;
use garcon_base::errors::{ErrorInput, has_node_error_code};
use garcon_base::path_boundary::is_project_boundary_error;
use garcon_contract::error_codes::ErrorCode;

pub fn file_operation_error(error: Box<dyn Error>) -> Box<dyn Error> {
    if is_project_boundary_error(error.as_ref()) {
        return Box::new(DomainError::new(
            ErrorCode::FILE_OUTSIDE_ROOT,
            "Path must be under project root",
            403,
            false,
        ));
    }
    if is_missing(error.as_ref()) {
        Box::new(DomainError::new(
            ErrorCode::FILE_NOT_FOUND,
            "File or directory not found",
            404,
            false,
        ))
    } else if is_denied(error.as_ref()) {
        Box::new(permission_denied())
    } else if has_any_node_code(error.as_ref(), &["ELOOP"]) {
        Box::new(file_revision_conflict())
    } else {
        error
    }
}

pub fn directory_creation_error(error: Box<dyn Error>) -> Box<dyn Error> {
    if has_any_node_code(error.as_ref(), &["EEXIST"]) {
        Box::new(DomainError::new(
            ErrorCode::FILE_ALREADY_EXISTS,
            "A file or directory with that name already exists",
            409,
            false,
        ))
    } else if has_any_node_code(error.as_ref(), &["ENAMETOOLONG", "EINVAL"]) {
        Box::new(DomainError::new_validation(
            "Directory name is not valid on this filesystem",
        ))
    } else if has_any_node_code(error.as_ref(), &["EROFS"]) {
        Box::new(permission_denied())
    } else {
        error
    }
}

pub fn file_revision_conflict() -> DomainError {
    DomainError::new(
        ErrorCode::FILE_REVISION_CONFLICT,
        "File changed on disk",
        409,
        false,
    )
}

fn permission_denied() -> DomainError {
    DomainError::new(
        ErrorCode::FILE_PERMISSION_DENIED,
        "Permission denied",
        403,
        false,
    )
}

pub(crate) fn has_any_node_code(error: &(dyn Error + 'static), codes: &[&str]) -> bool {
    codes
        .iter()
        .any(|code| has_node_error_code(ErrorInput::Error(error), code))
}

pub(crate) fn is_missing(error: &(dyn Error + 'static)) -> bool {
    has_any_node_code(error, &["ENOENT", "ENOTDIR"])
}

pub(crate) fn is_denied(error: &(dyn Error + 'static)) -> bool {
    has_any_node_code(error, &["EACCES", "EPERM"])
}

pub(super) fn is_skippable_entry_error(error: &(dyn Error + 'static)) -> bool {
    is_project_boundary_error(error)
        || has_any_node_code(
            error,
            &[
                "EACCES", "EPERM", "ENOENT", "ENOTDIR", "ELOOP", "ENOTCONN", "ESTALE", "EBUSY",
            ],
        )
}
