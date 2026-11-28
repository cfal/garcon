//! Ports `server/runtime/git/conflicts.ts`.

use garcon_base::path_boundary::realpath;
use garcon_contract::git::{
    ConflictAcceptOptions, ConflictDetailsOptions, FileOptions, GitConflictContent,
    GitConflictContentLimitReason, GitConflictDetails, GitConflictFile, GitConflictSide,
    GitConflictStatus, GitConflictsResult, GitMutationResult,
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, trim};
use indexmap::IndexMap;
use tokio::fs::{File, OpenOptions};
use tokio::io::AsyncReadExt;
use tokio_util::sync::CancellationToken;

use crate::files::file_revision::{FileStat, close_file, stat_handle, stat_path};

use super::git_domain_error::GitDomainError;
use super::operation_context::{
    assert_git_working_path, check_git_cancelled, git_operation_signal,
};
use super::pathspecs::literal_git_pathspec;
use super::porcelain_status::parse_porcelain_v1_z;
use super::run::{
    assert_git_repository, read_only_git_options, resolve_path_within_project, run_git,
};
use super::types::GitCommandOptions;

const MAX_CONFLICT_CONTENT_BYTES: usize = 256 * 1024;
const MAX_CONFLICT_CONTENT_LINES: usize = 4_000;
const READ_CHUNK_BYTES: usize = 64 * 1024;

fn empty_conflict_content() -> GitConflictContent {
    GitConflictContent {
        content: None,
        truncated: false,
        byte_length: Number(0.0),
        line_count: Number(0.0),
        limit_reason: None,
    }
}

fn too_large_conflict_content(byte_length: f64) -> GitConflictContent {
    GitConflictContent {
        truncated: true,
        byte_length: Number(byte_length),
        limit_reason: Some(GitConflictContentLimitReason::ContentTooLarge),
        ..empty_conflict_content()
    }
}

fn limit_conflict_content(content: String, byte_length: usize) -> GitConflictContent {
    let lines: Vec<_> = content.split('\n').collect();
    let line_count = Number(lines.len() as f64);
    let byte_length = Number(byte_length as f64);
    if lines.len() > MAX_CONFLICT_CONTENT_LINES {
        return GitConflictContent {
            content: Some(lines[..MAX_CONFLICT_CONTENT_LINES].join("\n")),
            truncated: true,
            byte_length,
            line_count,
            limit_reason: Some(GitConflictContentLimitReason::TooManyLines),
        };
    }
    GitConflictContent {
        content: Some(content),
        truncated: false,
        byte_length,
        line_count,
        limit_reason: None,
    }
}

fn parse_unmerged_index_stages(output: &str) -> IndexMap<&str, u8> {
    let mut stages = IndexMap::new();
    for record in output.split('\0') {
        if let Some((metadata, file)) = record.split_once('\t')
            && let Some(stage) = trim(metadata)
                .split(|character: char| trim(character.encode_utf8(&mut [0; 4])).is_empty())
                .filter(|part| !part.is_empty())
                .nth(2)
                .and_then(|value| value.parse::<f64>().ok())
            && matches!(stage, 1.0 | 2.0 | 3.0)
        {
            *stages.entry(file).or_default() |= 1 << (stage as u8 - 1);
        }
    }
    stages
}

fn options(signal: Option<&CancellationToken>) -> GitCommandOptions {
    GitCommandOptions {
        signal: signal.cloned(),
        ..Default::default()
    }
}

fn check_cancelled(signal: Option<&CancellationToken>) -> ExecutorResult<()> {
    if let Some(signal) = signal {
        check_git_cancelled(signal)?;
    }
    Ok(())
}

async fn read_stage_blob(
    project: &str,
    stage: u8,
    file: &str,
    signal: Option<&CancellationToken>,
) -> GitConflictContent {
    let object = format!(":{stage}:{file}");
    let opts = read_only_git_options(options(signal));
    let result = async {
        let size = run_git(
            project,
            vec!["cat-file".into(), "-s".into(), object.clone()],
            opts.clone(),
        )
        .await?;
        let byte_length = trim(&size.stdout).parse::<f64>().unwrap_or(f64::NAN);
        if byte_length.is_finite() && byte_length > MAX_CONFLICT_CONTENT_BYTES as f64 {
            return Ok(too_large_conflict_content(byte_length));
        }
        let output = run_git(project, vec!["show".into(), object], opts)
            .await?
            .stdout;
        let byte_length = output.len();
        Ok::<_, Box<dyn std::error::Error>>(limit_conflict_content(output, byte_length))
    }
    .await;
    result.unwrap_or_else(|_| empty_conflict_content())
}

async fn open_working_conflict_file(
    project: &str,
    file: &str,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<(File, FileStat)> {
    check_cancelled(signal)?;
    let working = resolve_path_within_project(project, file)?;
    assert_git_working_path(&working).await?;
    let real = realpath(&working).await?.to_string_lossy().into_owned();
    assert_git_working_path(&real).await?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let handle = options.open(real).await?;
    let stats = async {
        let stats = stat_handle(&handle).await?;
        if !stats.is_file {
            return Err(GitDomainError::new(
                "INVALID_INPUT",
                "Conflict content must be a regular file.",
            )
            .into());
        }
        assert_git_working_path(&working).await?;
        let current = stat_path(&working).await?;
        if stats.revision.dev as f64 != current.revision.dev as f64
            || stats.revision.ino as f64 != current.revision.ino as f64
        {
            return Err(GitDomainError::new(
                "INVALID_INPUT",
                "Conflict file changed while opening it.",
            )
            .into());
        }
        check_cancelled(signal)?;
        Ok::<_, Box<dyn std::error::Error>>(stats)
    }
    .await;
    match stats {
        Ok(stats) => Ok((handle, stats)),
        Err(error) => {
            close_file(handle).await?;
            Err(error)
        }
    }
}

async fn read_working_conflict_content(
    project: &str,
    file: &str,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitConflictContent> {
    let result = async {
        let (mut handle, stats) = open_working_conflict_file(project, file, signal).await?;
        let content = async {
            let mut byte_length = stats.revision.size as f64;
            if byte_length <= MAX_CONFLICT_CONTENT_BYTES as f64 {
                let mut buffer = vec![0; MAX_CONFLICT_CONTENT_BYTES + 1];
                let mut size = 0;
                while size < buffer.len() {
                    check_cancelled(signal)?;
                    let end = (size + READ_CHUNK_BYTES).min(buffer.len());
                    let count = handle.read(&mut buffer[size..end]).await?;
                    check_cancelled(signal)?;
                    if count == 0 {
                        break;
                    }
                    size += count;
                }
                if size <= MAX_CONFLICT_CONTENT_BYTES {
                    return Ok(limit_conflict_content(
                        String::from_utf8_lossy(&buffer[..size]).into_owned(),
                        size,
                    ));
                }
                byte_length = (size as f64).max(stat_handle(&handle).await?.revision.size as f64);
            }
            Ok::<_, Box<dyn std::error::Error>>(too_large_conflict_content(byte_length))
        }
        .await;
        close_file(handle).await?;
        content
    }
    .await;
    match result {
        Ok(content) => Ok(content),
        Err(_) => {
            check_cancelled(signal)?;
            Ok(empty_conflict_content())
        }
    }
}

fn unmerged_status(index: char, worktree: char) -> Option<GitConflictStatus> {
    use GitConflictStatus::{AA, AU, DD, DU, UA, UD, UU};
    Some(match (index, worktree) {
        ('U', 'U') => UU,
        ('A', 'A') => AA,
        ('D', 'D') => DD,
        ('A', 'U') => AU,
        ('U', 'A') => UA,
        ('D', 'U') => DU,
        ('U', 'D') => UD,
        _ => return None,
    })
}

pub async fn get_conflicts(
    project: &str,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitConflictsResult> {
    assert_git_repository(project, None).await?;
    let opts = read_only_git_options(options(signal));
    let status = run_git(
        project,
        ["status", "--porcelain=v1", "-z", "-uall"]
            .map(str::to_owned)
            .into(),
        opts.clone(),
    );
    let unmerged = run_git(
        project,
        ["ls-files", "-u", "-z"].map(str::to_owned).into(),
        opts,
    );
    let (status, unmerged) = tokio::try_join!(biased; status, unmerged)?;
    let stages = parse_unmerged_index_stages(&unmerged.stdout);
    let conflicts = parse_porcelain_v1_z(&status.stdout)
        .into_iter()
        .filter_map(|entry| {
            let status = unmerged_status(entry.index_status, entry.work_tree_status)?;
            let stages = stages.get(entry.path.as_str()).copied().unwrap_or_default();
            Some(GitConflictFile {
                path: entry.path,
                status,
                base_available: stages & 1 != 0,
                ours_available: stages & 2 != 0,
                theirs_available: stages & 4 != 0,
            })
        })
        .collect();
    Ok(GitConflictsResult { conflicts })
}

pub async fn get_conflict_details(
    request: &ConflictDetailsOptions,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitConflictDetails> {
    let project = &request.project_path;
    let file = &request.file;
    assert_git_repository(project, None).await?;
    let operation_signal = git_operation_signal();
    let (base, ours, theirs, working) = tokio::join!(biased;
        read_stage_blob(project, 1, file, signal),
        read_stage_blob(project, 2, file, signal),
        read_stage_blob(project, 3, file, signal),
        read_working_conflict_content(project, file, operation_signal.as_ref().or(signal)),
    );
    let working = working?;
    Ok(GitConflictDetails {
        path: file.clone(),
        truncated: base.truncated || ours.truncated || theirs.truncated || working.truncated,
        base,
        ours,
        theirs,
        working,
    })
}

fn successful_mutation() -> GitMutationResult {
    GitMutationResult {
        success: true,
        output: None,
        output_truncated: None,
        message: None,
        remote_name: None,
        remote_branch: None,
        worktree_path: None,
    }
}

async fn stage_conflict_file(
    project: &str,
    file: &str,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<()> {
    run_git(
        project,
        vec!["add".into(), "--".into(), literal_git_pathspec(file)],
        options(signal),
    )
    .await?;
    Ok(())
}

pub async fn accept_conflict_side(
    request: &ConflictAcceptOptions,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitMutationResult> {
    let project = &request.project_path;
    let file = &request.file;
    assert_git_repository(project, None).await?;
    let side = match request.side {
        GitConflictSide::Ours => "--ours",
        GitConflictSide::Theirs => "--theirs",
    };
    run_git(
        project,
        vec![
            "checkout".into(),
            side.into(),
            "--".into(),
            literal_git_pathspec(file),
        ],
        options(signal),
    )
    .await?;
    stage_conflict_file(project, file, signal).await?;
    Ok(successful_mutation())
}

fn has_conflict_marker(text: &[u8]) -> bool {
    text.iter().enumerate().any(|(offset, &byte)| {
        let prefix = match byte {
            b'\r' | b'\n' => 1,
            0xe2 if text[offset..].starts_with("\u{2028}".as_bytes())
                || text[offset..].starts_with("\u{2029}".as_bytes()) =>
            {
                3
            }
            _ => return false,
        };
        [b"<<<<<<<", b"=======", b">>>>>>>"]
            .iter()
            .any(|marker| text[offset + prefix..].starts_with(*marker))
    })
}

async fn assert_no_conflict_markers(
    handle: &mut File,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<()> {
    // The longest UTF-8 boundary plus marker is ten bytes; carry all but one.
    const MAX_TAIL: usize = 9;
    let mut buffer = vec![0; READ_CHUNK_BYTES + MAX_TAIL];
    buffer[0] = b'\n';
    let mut tail = 1;
    loop {
        check_cancelled(signal)?;
        let count = handle
            .read(&mut buffer[tail..tail + READ_CHUNK_BYTES])
            .await?;
        check_cancelled(signal)?;
        let end = tail + count;
        if has_conflict_marker(&buffer[..end]) {
            return Err(GitDomainError::new(
                "INVALID_INPUT",
                "Conflict markers remain in this file. Remove them before marking it resolved.",
            )
            .into());
        }
        if count == 0 {
            return Ok(());
        }
        tail = end.min(MAX_TAIL);
        buffer.copy_within(end - tail..end, 0);
    }
}

pub async fn mark_conflict_resolved(
    request: &FileOptions,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitMutationResult> {
    let project = &request.project_path;
    let file = &request.file;
    assert_git_repository(project, None).await?;
    let operation_signal = git_operation_signal();
    let read_signal = operation_signal.as_ref().or(signal);
    let (mut handle, _) = open_working_conflict_file(project, file, read_signal).await?;
    let result = assert_no_conflict_markers(&mut handle, read_signal).await;
    close_file(handle).await?;
    result?;
    check_cancelled(read_signal)?;
    stage_conflict_file(project, file, signal).await?;
    Ok(successful_mutation())
}
