//! Ports `server/runtime/git/review-patch.ts`.

use garcon_base::errors::NamedError;
use garcon_contract::git::{
    GIT_REVIEW_DOCUMENT_LIMITS, GitFileReviewCategory, GitReviewBodyState, GitReviewFilePatchBody,
    GitReviewLimitReason,
};
use garcon_contract::git_execution::GIT_MAX_RESULT_BYTES;
use garcon_js::{Number, utf16};
use indexmap::IndexMap;
use serde::Serialize;

const MAX_ENCODED_BODY_BYTES: usize = GIT_MAX_RESULT_BYTES - 1024 * 1024;

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawDiffFileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub raw_status: String,
    pub patch_section_count: usize,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct SplitRawDiffPatch {
    #[serde(flatten)]
    pub entry: RawDiffFileEntry,
    pub patch: String,
}

fn patch_error(message: impl Into<String>) -> NamedError {
    NamedError {
        name: "Error".into(),
        message: message.into(),
        code: None,
    }
}

fn raw_diff_file_entries(raw: &str) -> Result<Vec<RawDiffFileEntry>, NamedError> {
    let mut fields = raw.split('\0');
    let mut entries = Vec::new();
    while let Some(header) = fields.next() {
        if !header.starts_with(':') {
            return Err(patch_error("Git returned malformed raw diff metadata."));
        }
        let raw_status = header.rsplit_once(' ').map_or(header, |(_, status)| status);
        let first = fields
            .next()
            .filter(|path| !path.is_empty())
            .ok_or_else(|| patch_error("Git raw diff metadata omitted a file path."))?;
        let (path, original_path) = if raw_status.starts_with(['R', 'C']) {
            let destination = fields
                .next()
                .filter(|path| !path.is_empty())
                .ok_or_else(|| patch_error("Git raw diff metadata omitted a destination path."))?;
            (destination, Some(first.to_owned()))
        } else {
            (first, None)
        };
        entries.push(RawDiffFileEntry {
            path: path.into(),
            original_path,
            raw_status: raw_status.into(),
            patch_section_count: if raw_status.starts_with('T') { 2 } else { 1 },
        });
    }
    Ok(entries)
}

pub fn split_patches_from_raw_diff(
    raw: &str,
) -> Result<IndexMap<String, SplitRawDiffPatch>, NamedError> {
    if raw.is_empty() {
        return Ok(IndexMap::new());
    }
    let boundary = raw
        .find("\0\0diff --git ")
        .ok_or_else(|| patch_error("Git diff output omitted raw file metadata."))?;
    let entries = raw_diff_file_entries(&raw[..boundary])?;
    let patch = &raw[boundary + 2..];
    let mut sections = Vec::new();
    let mut start = 0;
    for (newline, _) in patch.match_indices("\ndiff --git ") {
        sections.push(&patch[start..newline]);
        start = newline + 1;
    }
    sections.push(&patch[start..]);
    let section_count: usize = entries.iter().map(|entry| entry.patch_section_count).sum();
    if section_count != sections.len() {
        return Err(patch_error(
            "Git diff metadata did not match its patch sections.",
        ));
    }
    let mut patches = IndexMap::new();
    let mut start = 0;
    for entry in entries {
        if patches.contains_key(&entry.path) {
            return Err(patch_error(format!("Git diff repeated {}.", entry.path)));
        }
        let end = start + entry.patch_section_count;
        let mut patch = sections[start..end].join("\n");
        if !patch.ends_with('\n') {
            patch.push('\n');
        }
        patches.insert(entry.path.clone(), SplitRawDiffPatch { entry, patch });
        start = end;
    }
    Ok(patches)
}

pub fn category_for_path(file_path: &str) -> GitFileReviewCategory {
    let file_path = file_path.replace('\\', "/");
    let name = file_path.rsplit('/').next().unwrap_or(&file_path);
    if matches!(
        name,
        "bun.lock" | "package-lock.json" | "pnpm-lock.yaml" | "yarn.lock" | "Cargo.lock" | "go.sum"
    ) {
        GitFileReviewCategory::Lockfile
    } else if file_path.contains("/generated/")
        || file_path.ends_with(".min.js")
        || file_path.contains("/src/lib/paraglide/")
    {
        GitFileReviewCategory::Generated
    } else {
        GitFileReviewCategory::Normal
    }
}

fn hunk_header(line: &str) -> bool {
    fn digits(value: &str) -> bool {
        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
    }
    fn line_range(value: &str) -> bool {
        value.split_once(',').map_or_else(
            || digits(value),
            |(start, count)| digits(start) && digits(count),
        )
    }
    let Some((before, rest)) = line
        .strip_prefix("@@ -")
        .and_then(|line| line.split_once(" +"))
    else {
        return false;
    };
    rest.split_once(" @@")
        .is_some_and(|(after, _)| line_range(before) && line_range(after))
}

#[derive(Default)]
struct InspectedUnifiedPatch {
    rendered_row_count: usize,
    has_binary_marker: bool,
    max_line_bytes: usize,
}

fn inspect_unified_patch(patch: &str, allow_multiple_file_sections: bool) -> InspectedUnifiedPatch {
    let mut inspected = InspectedUnifiedPatch::default();
    let mut inside_hunk = false;
    let mut saw_file_header = false;
    let mut count_rows = true;
    for line in patch.split_terminator('\n') {
        inspected.max_line_bytes = inspected.max_line_bytes.max(line.len());
        if line == "GIT binary patch"
            || line.starts_with("Binary files ") && line.ends_with(" differ")
        {
            inspected.has_binary_marker = true;
        }
        if line.starts_with("diff --git ") {
            if saw_file_header && !allow_multiple_file_sections {
                count_rows = false;
            }
            saw_file_header = true;
            inside_hunk = false;
            continue;
        }
        if !count_rows {
            continue;
        }
        if hunk_header(line) {
            inside_hunk = true;
            inspected.rendered_row_count += 1;
        } else if inside_hunk && (line.starts_with(['-', '+', ' ']) || line.is_empty()) {
            inspected.rendered_row_count += 1;
        }
    }
    inspected
}

pub fn limited_patch_file_body(
    path: &str,
    body_fingerprint: &str,
    limit_reason: GitReviewLimitReason,
    limit_message: impl Into<String>,
) -> GitReviewFilePatchBody {
    let is_binary = limit_reason == GitReviewLimitReason::Binary;
    GitReviewFilePatchBody {
        path: path.into(),
        patch_digest: None,
        body_fingerprint: body_fingerprint.into(),
        body_state: if is_binary {
            GitReviewBodyState::Binary
        } else {
            GitReviewBodyState::TooLarge
        },
        category: if is_binary {
            GitFileReviewCategory::Binary
        } else {
            GitFileReviewCategory::Large
        },
        is_binary,
        is_too_large: !is_binary,
        rendered_row_count: Number(0.0),
        patch_bytes: Number(0.0),
        patch: None,
        limit_reason: Some(limit_reason),
        limit_message: Some(limit_message.into()),
        error: None,
    }
}

pub fn error_patch_file_body(
    path: &str,
    body_fingerprint: &str,
    message: &str,
) -> GitReviewFilePatchBody {
    let mut error = utf16::truncate(message, 16_384).to_owned();
    if utf16::char_code_at(message, 16_384).is_some_and(|unit| (0xDC00..=0xDFFF).contains(&unit)) {
        error.push(char::REPLACEMENT_CHARACTER);
    }
    GitReviewFilePatchBody {
        path: path.into(),
        patch_digest: None,
        body_fingerprint: body_fingerprint.into(),
        body_state: GitReviewBodyState::Error,
        category: category_for_path(path),
        is_binary: false,
        is_too_large: false,
        rendered_row_count: Number(0.0),
        patch_bytes: Number(0.0),
        patch: None,
        limit_reason: None,
        limit_message: None,
        error: Some(error),
    }
}

pub fn create_review_patch_body(
    path: &str,
    body_fingerprint: &str,
    patch: String,
    allow_multiple_file_sections: bool,
) -> GitReviewFilePatchBody {
    use GitReviewLimitReason::{Binary, FileTooManyBytes, FileTooManyRows, LineTooLong};

    let inspected = inspect_unified_patch(&patch, allow_multiple_file_sections);
    let limit = GIT_REVIEW_DOCUMENT_LIMITS;
    let patch_bytes = patch.len();
    let limit_reason = if inspected.has_binary_marker {
        Some((Binary, "Binary diff is not available.".into()))
    } else if patch_bytes > limit.max_file_patch_bytes {
        Some((
            FileTooManyBytes,
            format!(
                "Diff exceeds {} byte display limit.",
                limit.max_file_patch_bytes
            ),
        ))
    } else if inspected.max_line_bytes > limit.max_line_bytes {
        Some((
            LineTooLong,
            format!("Diff contains a line over {} bytes.", limit.max_line_bytes),
        ))
    } else if inspected.rendered_row_count > limit.max_file_rows {
        Some((
            FileTooManyRows,
            format!("Diff exceeds {} rendered rows.", limit.max_file_rows),
        ))
    } else {
        None
    };
    if let Some((reason, message)) = limit_reason {
        return limited_patch_file_body(path, body_fingerprint, reason, message);
    }
    let body = GitReviewFilePatchBody {
        path: path.into(),
        patch_digest: None,
        body_fingerprint: body_fingerprint.into(),
        body_state: GitReviewBodyState::Loaded,
        category: category_for_path(path),
        is_binary: false,
        is_too_large: false,
        rendered_row_count: Number(inspected.rendered_row_count as f64),
        patch_bytes: Number(patch_bytes as f64),
        patch: Some(patch),
        limit_reason: None,
        limit_message: None,
        error: None,
    };
    // INFALLIBLE: the body contains only strings and finite counts, as in JSON.stringify.
    let encoded = serde_json::to_vec(&body).expect("serializable review patch body");
    if encoded.len() > MAX_ENCODED_BODY_BYTES {
        return limited_patch_file_body(
            path,
            body_fingerprint,
            FileTooManyBytes,
            format!("Encoded diff exceeds {MAX_ENCODED_BODY_BYTES} byte display limit."),
        );
    }
    body
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use garcon_cases::{CaseError, markers, replay, text};
    use serde_json::Value;

    use super::*;

    #[test]
    fn recorded_review_patch_matches() {
        const CASES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/cases/git/review-patch");
        replay(PathBuf::from(CASES), |function, args| {
            let required = |index| {
                text(function, args.get(index))?.ok_or_else(|| CaseError::unhandled(function))
            };
            fn encoded(value: impl Serialize) -> Result<Value, CaseError> {
                let bytes = serde_json::to_vec(&value)
                    .map_err(|error| CaseError::undeliverable(error.to_string()))?;
                garcon_js::json::from_slice(&bytes)
                    .map_err(|error| CaseError::undeliverable(error.to_string()))
            }
            match function {
                "splitPatchesFromRawDiff" => {
                    let entries = split_patches_from_raw_diff(required(0)?)
                        .map_err(|error| CaseError::new(error.name, error.message))?;
                    Ok(markers::marker(
                        "map",
                        encoded(entries.into_iter().collect::<Vec<_>>())?,
                    ))
                }
                "categoryForPath" => encoded(category_for_path(required(0)?)),
                "createReviewPatchBody" => encoded(create_review_patch_body(
                    required(0)?,
                    required(1)?,
                    required(2)?.into(),
                    args.get(3)
                        .and_then(|options| options.get("allowMultipleFileSections"))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )),
                "errorPatchFileBody" => encoded(error_patch_file_body(
                    required(0)?,
                    required(1)?,
                    required(2)?,
                )),
                "limitedPatchFileBody" => {
                    let reason: GitReviewLimitReason =
                        serde_json::from_value(Value::String(required(2)?.to_owned()))
                            .map_err(|error| CaseError::undeliverable(error.to_string()))?;
                    encoded(limited_patch_file_body(
                        required(0)?,
                        required(1)?,
                        reason,
                        required(3)?,
                    ))
                }
                _ => Err(CaseError::unhandled(function)),
            }
        });
    }

    #[test]
    fn limits_encoded_bodies_below_the_raw_patch_budget_for_the_two_uncaptured_over_one_mib_cases()
    {
        for (character, rows) in [('x', 450), ('\t', 250)] {
            let line = format!("+{}\n", character.to_string().repeat(9999));
            let patch = format!(
                "diff --git a/example.txt b/example.txt\n@@ -0,0 +1,{rows} @@\n{}",
                line.repeat(rows),
            );
            assert!(patch.len() < GIT_REVIEW_DOCUMENT_LIMITS.max_file_patch_bytes);
            let body =
                create_review_patch_body("example.txt", "synthetic-fingerprint", patch, false);
            assert_eq!(body.body_state, GitReviewBodyState::TooLarge);
            assert_eq!(
                body.limit_reason,
                Some(GitReviewLimitReason::FileTooManyBytes)
            );
            assert_eq!(body.patch, None);
        }
    }
}
