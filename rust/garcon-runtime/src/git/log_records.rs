//! Ports `server/runtime/git/log-records.ts`.

use super::git_domain_error::GitDomainError;

pub fn nul_records<'a>(
    output: &'a str,
    field_count: usize,
    description: &str,
) -> Result<Vec<Vec<&'a str>>, GitDomainError> {
    let mut fields: Vec<_> = output.split('\0').collect();
    if fields.pop() != Some("") || field_count == 0 || !fields.len().is_multiple_of(field_count) {
        return Err(GitDomainError::new(
            "INVALID_RESULT",
            format!("Git returned an unreadable {description}."),
        ));
    }
    Ok(fields.chunks(field_count).map(<[_]>::to_vec).collect())
}
