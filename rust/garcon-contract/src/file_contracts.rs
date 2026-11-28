//! Ports `common/file-contracts.ts`.
//!
//! `parseFileTreeResponse` and the file tree readers it uses are not ported
//! yet: the original reads a file's modification time with `Date.parse`.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::executors::{ExecutorId, parse_executor_id};
use garcon_js::{Number, utf16};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalFileIdentity {
    pub executor_id: ExecutorId,
    pub canonical_file_root_path: String,
    pub normalized_relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentityResponse {
    pub success: bool,
    pub identity: CanonicalFileIdentity,
}

pub type FileRevision = String;

pub const FILE_REVISION_HEADER: &str = "X-Garcon-File-Revision";
pub const MAX_FILE_REVISION_LENGTH: usize = 128;
pub const MAX_FILE_VIEW_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_FILE_SAVE_BYTES: usize = 4 * 1024 * 1024;

/// Whether a file has a revision, or is missing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum FileRevisionResponse {
    Ready { revision: FileRevision },
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextResponse {
    pub content: String,
    pub path: String,
    pub revision: FileRevision,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileSaveConflictResolution {
    Reject,
    Overwrite,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextRequest {
    pub content: String,
    pub expected_revision: FileRevision,
    pub conflict_resolution: FileSaveConflictResolution,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTextResponse {
    pub success: bool,
    pub path: String,
    pub message: String,
    pub revision: FileRevision,
}

// Longest single path segment the common filesystems accept.
pub const MAX_DIRECTORY_NAME_BYTES: usize = 255;

/// Why a name cannot identify one new directory inside its parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DirectoryNameProblem {
    Empty,
    Reserved,
    InvalidCharacter,
    TooLong,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDirectoryRequest {
    pub name: String,
}

/// One directory as browsing lists it and as creation returns it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub r#type: FileTreeEntryType,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileTreeEntryType {
    File,
    Directory,
}

/// One entry of a browsed directory.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeEntry {
    pub name: String,
    pub path: String,
    pub relative_path: String,
    pub r#type: FileTreeEntryType,
    pub size: Number,
    pub modified: Option<String>,
    pub permissions_rwx: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeBreadcrumb {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeDirectory {
    pub path: String,
    pub relative_path: String,
    pub parent_path: Option<String>,
    pub breadcrumbs: Vec<FileTreeBreadcrumb>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeHomeDirectory {
    pub path: String,
    pub breadcrumbs: Vec<FileTreeBreadcrumb>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeResponse {
    pub file_root_path: String,
    pub home_directory: Option<FileTreeHomeDirectory>,
    pub directory: FileTreeDirectory,
    pub entries: Vec<FileTreeEntry>,
}

fn is_non_empty_string(value: &Value) -> bool {
    value.as_str().is_some_and(|text| !text.is_empty())
}

static FILE_REVISION_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the original holds the same pattern as a regular expression literal.
    Regex::new(r"^v1:[A-Za-z0-9_-]+$").expect("the file revision pattern compiles")
});

/// Whether `value` is a file revision.
pub fn is_file_revision(value: &Value) -> bool {
    value.as_str().is_some_and(|text| {
        utf16::len(text) <= MAX_FILE_REVISION_LENGTH && FILE_REVISION_PATTERN.is_match(text)
    })
}

/// Reads whether a file has a revision.
pub fn parse_file_revision_response(value: &Value) -> Option<FileRevisionResponse> {
    let input = value.as_object()?;
    match input.get("status").and_then(Value::as_str) {
        Some("missing") => Some(FileRevisionResponse::Missing),
        Some("ready") => {
            let revision = input.get("revision")?;
            if !is_file_revision(revision) {
                return None;
            }
            Some(FileRevisionResponse::Ready {
                revision: revision.as_str()?.to_owned(),
            })
        }
        _ => None,
    }
}

/// Reads a file's text as the executor returns it.
pub fn parse_read_text_response(value: &Value) -> Option<ReadTextResponse> {
    let input = value.as_object()?;
    let content = input.get("content")?.as_str()?;
    let path = input.get("path")?;
    let revision = input.get("revision")?;
    if !is_non_empty_string(path) || !is_file_revision(revision) {
        return None;
    }
    Some(ReadTextResponse {
        content: content.to_owned(),
        path: path.as_str()?.to_owned(),
        revision: revision.as_str()?.to_owned(),
    })
}

/// Reads a request to save a file's text.
pub fn parse_save_text_request(value: &Value) -> Option<SaveTextRequest> {
    let input = value.as_object()?;
    let content = input.get("content")?.as_str()?;
    let expected_revision = input.get("expectedRevision")?;
    let conflict_resolution = input.get("conflictResolution")?;
    if !is_file_revision(expected_revision) {
        return None;
    }
    let conflict_resolution = match conflict_resolution {
        Value::String(resolution) if resolution == "reject" => FileSaveConflictResolution::Reject,
        Value::String(resolution) if resolution == "overwrite" => {
            FileSaveConflictResolution::Overwrite
        }
        _ => return None,
    };
    Some(SaveTextRequest {
        content: content.to_owned(),
        expected_revision: expected_revision.as_str()?.to_owned(),
        conflict_resolution,
    })
}

/// Reports why `name` cannot identify one new directory inside its parent.
/// Separators and dot segments would address another directory.
pub fn directory_name_problem(name: &str) -> Option<DirectoryNameProblem> {
    if name.is_empty() {
        return Some(DirectoryNameProblem::Empty);
    }
    if name == "." || name == ".." {
        return Some(DirectoryNameProblem::Reserved);
    }
    // `TextEncoder` measures a string in UTF-8 bytes, which is `str::len`.
    if name
        .chars()
        .any(|character| matches!(character, '\u{0000}'..='\u{001f}' | '\u{007f}' | '/' | '\\'))
    {
        return Some(DirectoryNameProblem::InvalidCharacter);
    }
    (name.len() > MAX_DIRECTORY_NAME_BYTES).then_some(DirectoryNameProblem::TooLong)
}

/// Reads a request to create a directory.
pub fn parse_create_directory_request(value: &Value) -> Option<CreateDirectoryRequest> {
    let name = value.as_object()?.get("name")?.as_str()?;
    Some(CreateDirectoryRequest {
        name: name.to_owned(),
    })
}

/// Reads one directory as browsing lists it and as creation returns it.
pub fn parse_directory_entry(value: &Value) -> Option<DirectoryEntry> {
    let input = value.as_object()?;
    let name = input.get("name")?;
    let path = input.get("path")?;
    if input.get("type").and_then(Value::as_str) != Some("directory")
        || !is_non_empty_string(name)
        || !is_non_empty_string(path)
    {
        return None;
    }
    Some(DirectoryEntry {
        name: name.as_str()?.to_owned(),
        path: path.as_str()?.to_owned(),
        r#type: FileTreeEntryType::Directory,
    })
}

/// Reads the reply to a request to save a file's text.
pub fn parse_save_text_response(value: &Value) -> Option<SaveTextResponse> {
    let input = value.as_object()?;
    if input.get("success") != Some(&Value::Bool(true)) {
        return None;
    }
    let path = input.get("path")?;
    let message = input.get("message")?;
    let revision = input.get("revision")?;
    if !is_non_empty_string(path) || !is_non_empty_string(message) || !is_file_revision(revision) {
        return None;
    }
    Some(SaveTextResponse {
        success: true,
        path: path.as_str()?.to_owned(),
        message: message.as_str()?.to_owned(),
        revision: revision.as_str()?.to_owned(),
    })
}

/// Reads the identity of a file.
pub fn parse_file_identity_response(value: &Value) -> Option<FileIdentityResponse> {
    let input = value.as_object()?;
    let identity = input.get("identity")?.as_object()?;
    if input.get("success") != Some(&Value::Bool(true)) {
        return None;
    }
    // An absent executor ID reads like `null` here and names the Local executor.
    let executor_id = parse_executor_id(identity.get("executorId").unwrap_or(&Value::Null))?;
    let canonical_file_root_path = identity.get("canonicalFileRootPath")?;
    let normalized_relative_path = identity.get("normalizedRelativePath")?;
    if !is_non_empty_string(canonical_file_root_path)
        || !is_non_empty_string(normalized_relative_path)
    {
        return None;
    }
    Some(FileIdentityResponse {
        success: true,
        identity: CanonicalFileIdentity {
            executor_id,
            canonical_file_root_path: canonical_file_root_path.as_str()?.to_owned(),
            normalized_relative_path: normalized_relative_path.as_str()?.to_owned(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_a_bounded_ascii_revision() {
        let padded = |count: usize| format!("v1:{}", "a".repeat(count));
        for (revision, valid) in [
            (json!("v1:synthetic_revision-1"), true),
            (json!(padded(MAX_FILE_REVISION_LENGTH - 3)), true),
            (json!(padded(MAX_FILE_REVISION_LENGTH - 2)), false),
            (json!("v1:"), false),
            (json!("v1:invalid revision"), false),
            (json!("v1:é"), false),
            (json!(null), false),
        ] {
            assert_eq!(is_file_revision(&revision), valid, "{revision}");
            assert_eq!(
                parse_file_revision_response(&json!({ "status": "ready", "revision": revision }))
                    .is_some(),
                valid,
                "{revision}"
            );
            assert_eq!(
                parse_read_text_response(
                    &json!({ "content": "text", "path": "/project/file.txt", "revision": revision })
                )
                .is_some(),
                valid,
                "{revision}"
            );
            assert_eq!(
                parse_save_text_response(&json!({
                    "success": true,
                    "path": "/project/file.txt",
                    "message": "Saved",
                    "revision": revision,
                }))
                .is_some(),
                valid,
                "{revision}"
            );
            for conflict_resolution in ["reject", "overwrite"] {
                assert_eq!(
                    parse_save_text_request(&json!({
                        "content": "text",
                        "expectedRevision": revision,
                        "conflictResolution": conflict_resolution,
                    }))
                    .is_some(),
                    valid,
                    "{revision} {conflict_resolution}"
                );
            }
        }
    }

    #[test]
    fn classifies_a_directory_name() {
        let cases: Vec<(String, Option<DirectoryNameProblem>)> = [
            ("project".to_owned(), None),
            (".hidden".to_owned(), None),
            ("with space".to_owned(), None),
            // 127 two-byte characters and one one-byte character: 255 bytes.
            (format!("{}x", "é".repeat(127)), None),
            (" padded ".to_owned(), None),
            (String::new(), Some(DirectoryNameProblem::Empty)),
            (".".to_owned(), Some(DirectoryNameProblem::Reserved)),
            ("..".to_owned(), Some(DirectoryNameProblem::Reserved)),
            (
                "a/b".to_owned(),
                Some(DirectoryNameProblem::InvalidCharacter),
            ),
            (
                "a\\b".to_owned(),
                Some(DirectoryNameProblem::InvalidCharacter),
            ),
            (
                "line\nbreak".to_owned(),
                Some(DirectoryNameProblem::InvalidCharacter),
            ),
            (
                "nul\0byte".to_owned(),
                Some(DirectoryNameProblem::InvalidCharacter),
            ),
            (
                "delete\u{007f}".to_owned(),
                Some(DirectoryNameProblem::InvalidCharacter),
            ),
            (
                "x".repeat(MAX_DIRECTORY_NAME_BYTES + 1),
                Some(DirectoryNameProblem::TooLong),
            ),
            ("é".repeat(128), Some(DirectoryNameProblem::TooLong)),
        ]
        .to_vec();
        for (name, problem) in cases {
            assert_eq!(directory_name_problem(&name), problem, "{name:?}");
        }
    }

    #[test]
    fn parses_only_typed_requests_and_created_directories() {
        assert_eq!(
            parse_create_directory_request(&json!({ "name": "project", "ignored": true })),
            Some(CreateDirectoryRequest {
                name: "project".to_owned()
            })
        );
        for value in [
            json!(null),
            json!([]),
            json!({}),
            json!({ "name": 7 }),
            json!("project"),
        ] {
            assert_eq!(parse_create_directory_request(&value), None, "{value}");
        }
        let created = DirectoryEntry {
            name: "project".to_owned(),
            path: "/base/project".to_owned(),
            r#type: FileTreeEntryType::Directory,
        };
        assert_eq!(
            parse_directory_entry(&json!({
                "name": "project",
                "path": "/base/project",
                "type": "directory",
                "ignored": true,
            })),
            Some(created.clone())
        );
        for value in [
            json!(null),
            json!({ "name": "project", "path": "/base/project", "type": "file" }),
            json!({ "name": "project", "path": "", "type": "directory" }),
            json!({ "name": "", "path": "/base/project", "type": "directory" }),
            json!({ "name": "project" }),
        ] {
            assert_eq!(parse_directory_entry(&value), None, "{value}");
        }
        assert_eq!(
            serde_json::to_string(&created).unwrap(),
            r#"{"name":"project","path":"/base/project","type":"directory"}"#
        );
    }
}
