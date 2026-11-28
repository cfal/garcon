//! Ports `server/runtime/projects/file-mentions.ts`.

use std::collections::HashSet;

use garcon_base::path_boundary::realpath;
use garcon_contract::file_mention_context::FILE_CONTEXT_SEPARATOR;
use garcon_js::{path::native, trim};
use serde::Serialize;
use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncReadExt;

use crate::files::file_revision::{RevisionStat, stat_handle, stat_path};

pub use garcon_contract::file_mention_context::strip_resolved_file_mention_context;

const MAX_MENTIONED_FILES: usize = 8;
const MAX_FILE_BYTES: usize = 128 * 1024;
const MAX_TOTAL_BYTES: usize = 384 * 1024;
const BINARY_SAMPLE_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FileMentionToken {
    pub path: String,
    pub start: usize,
    pub end: usize,
}

fn whitespace(unit: u16) -> bool {
    char::from_u32(u32::from(unit))
        .is_some_and(|character| trim(character.encode_utf8(&mut [0; 4])).is_empty())
}

fn parse_quoted_mention(input: &[u16], start: usize, quote: u16) -> Option<(String, usize)> {
    let mut value = Vec::new();
    let mut index = start;
    while let Some(&unit) = input.get(index) {
        if unit == u16::from(b'\\')
            && let Some(&next) = input.get(index + 1)
        {
            value.push(next);
            index += 2;
            continue;
        }
        if unit == quote {
            return Some((String::from_utf16_lossy(&value), index + 1));
        }
        value.push(unit);
        index += 1;
    }
    None
}

fn parse_bare_mention(input: &[u16], start: usize) -> Option<(String, usize)> {
    let length = input[start..]
        .iter()
        .take_while(|&&unit| !whitespace(unit))
        .count();
    (length > 0).then(|| {
        (
            String::from_utf16_lossy(&input[start..start + length]),
            start + length,
        )
    })
}

pub fn parse_file_mention_tokens(input: &str) -> Vec<FileMentionToken> {
    let input: Vec<_> = input.encode_utf16().collect();
    let mut mentions = Vec::new();
    let mut index = 0;
    while let Some(&unit) = input.get(index) {
        if unit == u16::from(b'@') && (index == 0 || whitespace(input[index - 1])) {
            let parsed = match input.get(index + 1).copied() {
                Some(34 | 39) => parse_quoted_mention(&input, index + 2, input[index + 1]),
                _ => parse_bare_mention(&input, index + 1),
            };
            if let Some((path, end)) = parsed.filter(|(path, _)| !path.is_empty()) {
                mentions.push(FileMentionToken {
                    path,
                    start: index,
                    end,
                });
                index = end;
                continue;
            }
        }
        index += 1;
    }
    mentions
}

fn is_within_root(root: &str, target: &str) -> bool {
    target == root
        || target
            .strip_prefix(root)
            .is_some_and(|tail| tail.starts_with(native::SEP))
}

fn resolve_within_project(project_path: &str, input_path: &str) -> Option<String> {
    let cwd = if cfg!(unix) && native::is_absolute(project_path) {
        native::SEP.to_owned()
    } else {
        std::env::current_dir().ok()?.to_string_lossy().into_owned()
    };
    let root = native::resolve(&cwd, &[project_path]);
    let resolved = native::resolve(&root, &[input_path]);
    is_within_root(&root, &resolved).then_some(resolved)
}

fn path_candidates(input: &str) -> impl Iterator<Item = &str> {
    let stripped = input.trim_end_matches([')', ',', '.', ';', ':', '!', '?']);
    std::iter::once(input).chain((!stripped.is_empty() && stripped != input).then_some(stripped))
}

struct OpenedMentionFile {
    canonical_path: String,
    handle: File,
}

fn is_same_file(left: RevisionStat, right: RevisionStat) -> bool {
    left.dev as f64 == right.dev as f64 && left.ino as f64 == right.ino as f64
}

async fn open_existing_file<F: Future<Output = ()>>(
    project_path: &str,
    real_project_path: &str,
    input: &str,
    before_open: impl Fn() -> F,
) -> Option<OpenedMentionFile> {
    let mut open = OpenOptions::new();
    open.read(true);
    #[cfg(unix)]
    open.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    #[cfg(windows)]
    open.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    for candidate in path_candidates(input) {
        let Some(resolved) = resolve_within_project(project_path, candidate) else {
            continue;
        };
        let Ok(real_path) = realpath(&resolved).await else {
            continue;
        };
        let real_path = real_path.to_string_lossy();
        if !is_within_root(real_project_path, &real_path) {
            continue;
        }
        before_open().await;
        let Ok(handle) = open.open(real_path.as_ref()).await else {
            continue;
        };
        let Ok(opened_stat) = stat_handle(&handle).await else {
            continue;
        };
        if !opened_stat.is_file {
            continue;
        }
        let Ok(verified_path) = realpath(real_path.as_ref()).await else {
            continue;
        };
        let verified_path = verified_path.to_string_lossy().into_owned();
        if !is_within_root(real_project_path, &verified_path) {
            continue;
        }
        let Ok(verified_stat) = stat_path(&verified_path).await else {
            continue;
        };
        if is_same_file(opened_stat.revision, verified_stat.revision) {
            return Some(OpenedMentionFile {
                canonical_path: verified_path,
                handle,
            });
        }
    }
    None
}

fn fence_for(content: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for byte in content.bytes() {
        if byte == b'`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat(3.max(longest + 1))
}

fn format_file_section(relative_path: &str, content: &str, truncated: bool) -> String {
    let fence = fence_for(content);
    let suffix = if truncated {
        format!("\n\n[Garcon truncated this file at {MAX_FILE_BYTES} bytes.]")
    } else {
        String::new()
    };
    format!("@{relative_path}\n{fence}\n{content}{suffix}\n{fence}")
}

async fn read_file_prefix(handle: &mut File, content_limit: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = vec![0; BINARY_SAMPLE_BYTES.max(content_limit + 1)];
    let mut count = 0;
    while count < bytes.len() {
        let read = handle.read(&mut bytes[count..]).await?;
        if read == 0 {
            break;
        }
        count += read;
    }
    bytes.truncate(count);
    Ok(bytes)
}

pub async fn resolve_file_mentions_in_command(command: &str, project_path: &str) -> String {
    if !command.contains('@') || project_path.is_empty() {
        return command.to_owned();
    }
    let tokens = parse_file_mention_tokens(command);
    if tokens.is_empty() {
        return command.to_owned();
    }
    let Ok(real_project_path) = realpath(project_path).await else {
        return command.to_owned();
    };
    let real_project_path = real_project_path.to_string_lossy();
    let mut resolved = Vec::new();
    let mut seen = HashSet::new();
    for token in tokens {
        if resolved.len() >= MAX_MENTIONED_FILES {
            break;
        }
        if let Some(opened) =
            open_existing_file(project_path, &real_project_path, &token.path, || {
                std::future::ready(())
            })
            .await
            && seen.insert(opened.canonical_path.clone())
        {
            resolved.push(opened);
        }
    }
    let mut sections = Vec::new();
    let mut total_bytes = 0;
    for OpenedMentionFile {
        canonical_path,
        mut handle,
    } in resolved
    {
        let relative = garcon_base::executor_path::to_executor_path(
            &native::relative(native::SEP, &real_project_path, &canonical_path),
            None,
        );
        if total_bytes >= MAX_TOTAL_BYTES {
            sections.push(format!("@{relative}\n[Garcon omitted this file because the @file context limit was reached.]"));
            continue;
        }
        let allowed = MAX_FILE_BYTES.min(MAX_TOTAL_BYTES - total_bytes);
        let Ok(prefix) = read_file_prefix(&mut handle, allowed).await else {
            continue;
        };
        if prefix[..prefix.len().min(BINARY_SAMPLE_BYTES)].contains(&0) {
            sections.push(format!("@{relative}\n[Garcon omitted this binary file.]"));
            continue;
        }
        let length = prefix.len().min(allowed);
        total_bytes += length;
        sections.push(format_file_section(
            &relative,
            &String::from_utf8_lossy(&prefix[..length]),
            prefix.len() > allowed,
        ));
    }
    if sections.is_empty() {
        command.to_owned()
    } else {
        format!("{command}{FILE_CONTEXT_SEPARATOR}{}", sections.join("\n\n"))
    }
}

#[cfg(test)]
mod tests {
    use garcon_cases::{CaseError, replay, text};
    use garcon_js::json::parse;

    use super::parse_file_mention_tokens;

    #[test]
    fn recorded_file_mention_tokens_match() {
        let stats = replay(
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/cases/projects/file-mentions"
            ),
            |function, args| {
                if function != "parseFileMentionTokens" {
                    return Err(CaseError::unhandled(function));
                }
                let input = text(function, args.first())?
                    .ok_or_else(|| CaseError::undeliverable("expected a command string"))?;
                Ok(
                    parse(&serde_json::to_string(&parse_file_mention_tokens(input)).unwrap())
                        .unwrap(),
                )
            },
        );
        assert_eq!(stats.with_wildcards, 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_a_replaced_parent_before_opening_a_mention() {
        use std::os::unix::fs::symlink;

        use tokio::fs;

        let fixture = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(fixture.path()).await.unwrap();
        let project = root.join("project");
        let parent = project.join("nested");
        let outside = root.join("outside");
        fs::create_dir_all(&parent).await.unwrap();
        fs::create_dir_all(&outside).await.unwrap();
        fs::write(parent.join("note"), "inside").await.unwrap();
        fs::write(outside.join("note"), "outside").await.unwrap();
        let path = project.to_str().unwrap();
        let opened = super::open_existing_file(path, path, "nested/note", || async {
            fs::rename(&parent, project.join("retired")).await.unwrap();
            symlink(&outside, &parent).unwrap();
        })
        .await;
        assert!(opened.is_none());
        let command = "Read @nested/note and @retired/note";
        let resolved = super::resolve_file_mentions_in_command(command, path).await;
        assert!(resolved.contains("inside"));
        assert!(!resolved.contains("outside"));
        assert_eq!(
            super::strip_resolved_file_mention_context(&resolved),
            command
        );
    }
}
