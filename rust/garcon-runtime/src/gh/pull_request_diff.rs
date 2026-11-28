//! Splits a GitHub CLI diff into compact review bodies.

use std::sync::LazyLock;

use garcon_contract::git::GitReviewFilePatchBody;
use garcon_js::{Number, trim, utf16};
use regress::Regex;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::git::review_patch::create_review_patch_body;
use crate::git::run::strip_diff_headers;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffPatchFile {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub original_path: Option<String>,
    pub status: String,
    pub change_kind: String,
    pub additions: Number,
    pub deletions: Number,
    pub is_binary: bool,
    pub body: GitReviewFilePatchBody,
}

static QUOTED_ESCAPE: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: this is the original's fixed C-style escape pattern.
    Regex::new(r#"\\([0-7]{1,3}|[abfnrtv"\\])"#).expect("valid Git path escape")
});

static DIFF_PATHS: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: this is the original's fixed header path pattern.
    Regex::new(r#"^("(?:[^"\\]|\\.)*"|a/.*?) ("(?:[^"\\]|\\.)*"|b/.*)$"#)
        .expect("valid Git diff header paths")
});

fn strip_ab_prefix(path: &str) -> &str {
    path.strip_prefix("a/")
        .or_else(|| path.strip_prefix("b/"))
        .unwrap_or(path)
}

fn decode_git_path(value: &str) -> String {
    if value == "\"" {
        return String::new();
    }
    let Some(quoted) = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    else {
        return value.into();
    };
    let mut parts = Vec::new();
    let mut offset = 0;
    for matched in QUOTED_ESCAPE.find_iter(quoted) {
        let Some(range) = matched.group(1) else {
            continue;
        };
        let escape = &quoted[range];
        let byte = match escape {
            "a" => 0x07,
            "b" => 0x08,
            "f" => 0x0c,
            "n" => b'\n',
            "r" => b'\r',
            "t" => b'\t',
            "v" => 0x0b,
            "\"" => b'"',
            "\\" => b'\\',
            octal => match u16::from_str_radix(octal, 8) {
                Ok(unit) => unit as u8,
                Err(_) => continue,
            },
        };
        parts.extend_from_slice(&quoted.as_bytes()[offset..matched.start()]);
        parts.push(byte);
        offset = matched.end();
    }
    parts.extend_from_slice(&quoted.as_bytes()[offset..]);
    String::from_utf8_lossy(&parts).into_owned()
}

fn diff_header_paths(paths: &str) -> (Option<String>, Option<String>) {
    // Equal unquoted paths disambiguate an embedded " b/" in the name.
    let length = utf16::len(paths);
    if length % 2 == 1 && paths.starts_with("a/") {
        let middle = (length / 2) as isize;
        if utf16::slice(paths, middle, Some(middle + 3)) == " b/" {
            let old = utf16::slice(paths, 2, Some(middle));
            let new = utf16::slice(paths, middle + 3, None);
            if old == new {
                return (Some(old.into()), Some(new.into()));
            }
        }
    }
    let Some(matched) = DIFF_PATHS.find(paths) else {
        return (None, None);
    };
    let path = |group| {
        matched
            .group(group)
            .map(|range| strip_ab_prefix(&decode_git_path(&paths[range])).into())
    };
    (path(1), path(2))
}

fn file_header_path(path: &str) -> String {
    let value = if path.starts_with('"') {
        path
    } else {
        path.split_once('\t').map_or(path, |(name, _)| name)
    };
    strip_ab_prefix(&decode_git_path(value)).into()
}

fn parse_diff_file_patch(segment: &str) -> Option<GitDiffPatchFile> {
    let mut lines = segment.split('\n');
    let (mut old, mut new) = diff_header_paths(lines.next()?.strip_prefix("diff --git ")?);
    let mut status = "M";
    let mut rename_from = None;
    let mut rename_to = None;
    for line in lines {
        if line.starts_with("@@") {
            break;
        }
        if line.starts_with("new file mode") {
            status = "A";
        } else if line.starts_with("deleted file mode") {
            status = "D";
        } else if let Some(value) = line.strip_prefix("rename from ") {
            rename_from = Some(decode_git_path(value));
            status = "R";
        } else if let Some(value) = line.strip_prefix("rename to ") {
            rename_to = Some(decode_git_path(value));
            status = "R";
        } else if let Some(value) = line.strip_prefix("--- ") {
            if value != "/dev/null" {
                old = Some(file_header_path(value));
            }
        } else if let Some(value) = line.strip_prefix("+++ ")
            && value != "/dev/null"
        {
            new = Some(file_header_path(value));
        }
    }
    let path = if status == "D" {
        old.as_ref().or(new.as_ref())
    } else {
        rename_to.as_ref().or(new.as_ref()).or(old.as_ref())
    }
    .filter(|path| !path.is_empty())?
    .clone();

    let patch = strip_diff_headers(segment);
    let mut additions = 0;
    let mut deletions = 0;
    let mut in_hunk = false;
    for line in patch.split('\n') {
        if line.starts_with("@@") {
            in_hunk = true;
        } else if in_hunk {
            additions += usize::from(line.starts_with('+'));
            deletions += usize::from(line.starts_with('-'));
        }
    }
    let fingerprint = format!("{:x}", Sha1::digest(segment.as_bytes()));
    let body = create_review_patch_body(&path, &fingerprint[..16], patch.to_owned(), false);
    Some(GitDiffPatchFile {
        path,
        original_path: if status == "R" {
            rename_from.or(old)
        } else {
            None
        },
        status: status.into(),
        change_kind: match status {
            "A" => "added",
            "D" => "deleted",
            "R" | "C" => "renamed",
            _ => "modified",
        }
        .into(),
        additions: Number(additions as f64),
        deletions: Number(deletions as f64),
        is_binary: body.is_binary,
        body,
    })
}

pub fn parse_multi_file_diff_patches(diff: &str) -> Vec<GitDiffPatchFile> {
    if trim(diff).is_empty() {
        return Vec::new();
    }
    let mut start = 0;
    let mut files = Vec::new();
    for (end, _) in diff.match_indices("\ndiff --git ") {
        files.extend(parse_diff_file_patch(&diff[start..end]));
        start = end + 1;
    }
    files.extend(parse_diff_file_patch(&diff[start..]));
    files
}
