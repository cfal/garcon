//! Ports `server/runtime/git/file-history.ts`.

use garcon_contract::git::{
    BlameOptions, FileHistoryOptions, GitBlameLine, GitBlameResult, GitFileHistoryEntry,
    GitFileHistoryResult, GitGraphCommit, GitGraphResult, GraphOptions,
};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, to_iso_string, trim, trim_end};
use tokio_util::sync::CancellationToken;

use super::log_records::nul_records;
use super::pathspecs::literal_git_pathspec;
use super::ref_validation::assert_existing_commit_ref;
use super::run::{assert_git_repository, read_only_git_options, run_git};
use super::types::GitCommandOptions;

const MAX_HISTORY_LIMIT: u32 = 200;
const MAX_BLAME_LINES: u32 = 2_000;
const MAX_GRAPH_LIMIT: u32 = 500;

fn clamp_limit(value: Option<u32>, fallback: u32, max: u32) -> u32 {
    value
        .filter(|&value| value > 0)
        .map_or(fallback, |value| value.min(max))
}

fn parse_file_history(output: &str) -> ExecutorResult<Vec<GitFileHistoryEntry>> {
    Ok(nul_records(output, 5, "file history")?
        .into_iter()
        .map(|row| GitFileHistoryEntry {
            hash: row[0].into(),
            author: row[1].into(),
            email: row[2].into(),
            date: row[3].into(),
            subject: row[4].into(),
        })
        .collect())
}

pub async fn get_file_history(
    options: &FileHistoryOptions,
    signal: Option<CancellationToken>,
) -> ExecutorResult<GitFileHistoryResult> {
    assert_git_repository(&options.project_path, None).await?;
    let safe_limit = clamp_limit(options.limit, 50, MAX_HISTORY_LIMIT);
    let result = run_git(
        &options.project_path,
        vec![
            "log".into(),
            "--follow".into(),
            "-z".into(),
            format!("-n{safe_limit}"),
            "--format=%H%x00%an%x00%ae%x00%ai%x00%s".into(),
            "--".into(),
            literal_git_pathspec(&options.file),
        ],
        read_only_git_options(GitCommandOptions {
            signal,
            ..Default::default()
        }),
    )
    .await?;
    Ok(GitFileHistoryResult {
        commits: parse_file_history(&result.stdout)?,
    })
}

fn lowercase_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')
}

fn blame_header(line: &str) -> Option<GitBlameLine> {
    fn digits(value: &str) -> bool {
        !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
    }
    let mut fields = line.split(' ');
    let (commit, original, final_line) = (fields.next()?, fields.next()?, fields.next()?);
    if commit.len() != 40
        || !commit.bytes().all(lowercase_hex)
        || !digits(original)
        || !digits(final_line)
        || fields.next().is_some_and(|count| !digits(count))
        || fields.next().is_some()
    {
        return None;
    }
    let original_line = Number(original.parse().ok()?);
    let final_line = Number(final_line.parse().ok()?);
    Some(GitBlameLine {
        line: final_line,
        original_line,
        final_line,
        commit: commit.into(),
        author: String::new(),
        author_mail: String::new(),
        author_time: String::new(),
        summary: String::new(),
        content: String::new(),
    })
}

fn parse_blame(output: &str) -> ExecutorResult<Vec<GitBlameLine>> {
    let mut result = Vec::new();
    let mut current = None;
    for line in output.split('\n') {
        if let Some(header) = blame_header(line) {
            current = Some(header);
            continue;
        }
        let Some(record) = &mut current else { continue };
        if let Some(author) = line.strip_prefix("author ") {
            record.author = author.into();
        } else if let Some(mail) = line.strip_prefix("author-mail ") {
            record.author_mail = mail.into();
        } else if let Some(time) = line.strip_prefix("author-time ") {
            let time = trim(time);
            let seconds = if time.is_empty() {
                0.0
            } else {
                time.parse().unwrap_or(f64::NAN)
            };
            let milliseconds = seconds * 1000.0;
            if !milliseconds.is_finite() || milliseconds.abs() > 8.64e15 {
                return Err(garcon_base::errors::NamedError {
                    name: "RangeError".into(),
                    message: "Invalid Date".into(),
                    code: None,
                }
                .into());
            }
            record.author_time = to_iso_string(milliseconds as i64)?;
        } else if let Some(summary) = line.strip_prefix("summary ") {
            record.summary = summary.into();
        } else if let Some(content) = line.strip_prefix('\t')
            && let Some(mut record) = current.take()
        {
            record.content = content.into();
            result.push(record);
        }
    }
    Ok(result)
}

pub async fn get_blame(
    options: &BlameOptions,
    signal: Option<CancellationToken>,
) -> ExecutorResult<GitBlameResult> {
    assert_git_repository(&options.project_path, None).await?;
    let reference = options.reference.as_deref().unwrap_or("HEAD");
    assert_existing_commit_ref(&options.project_path, reference, "blame", signal.clone()).await?;
    let safe_limit = clamp_limit(options.limit, MAX_BLAME_LINES, MAX_BLAME_LINES);
    let result = run_git(
        &options.project_path,
        vec![
            "blame".into(),
            "--line-porcelain".into(),
            "-L".into(),
            format!("1,+{safe_limit}"),
            reference.into(),
            "--".into(),
            options.file.clone(),
        ],
        read_only_git_options(GitCommandOptions {
            signal,
            ..Default::default()
        }),
    )
    .await?;
    let lines = parse_blame(&result.stdout)?;
    Ok(GitBlameResult {
        truncated: lines.len() >= safe_limit as usize,
        lines,
    })
}

fn parse_graph(output: &str) -> Vec<GitGraphCommit> {
    output
        .split('\n')
        .filter_map(|line| {
            let offset = line
                .as_bytes()
                .windows(40)
                .position(|window| window.iter().copied().all(lowercase_hex))?;
            let mut fields = line[offset..].split('\0');
            Some(GitGraphCommit {
                graph: trim_end(&line[..offset]).into(),
                hash: fields.next().unwrap_or_default().into(),
                parents: fields
                    .next()
                    .unwrap_or_default()
                    .split(' ')
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_owned)
                    .collect(),
                decorations: fields
                    .next()
                    .unwrap_or_default()
                    .split(',')
                    .map(trim)
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_owned)
                    .collect(),
                author: fields.next().unwrap_or_default().into(),
                date: fields.next().unwrap_or_default().into(),
                subject: fields.next().unwrap_or_default().into(),
            })
        })
        .collect()
}

pub async fn get_graph(
    options: &GraphOptions,
    signal: Option<CancellationToken>,
) -> ExecutorResult<GitGraphResult> {
    assert_git_repository(&options.project_path, None).await?;
    let safe_limit = clamp_limit(options.limit, 200, MAX_GRAPH_LIMIT);
    let result = run_git(
        &options.project_path,
        vec![
            "log".into(),
            "--graph".into(),
            "--decorate".into(),
            "--date=relative".into(),
            "--pretty=format:%H%x00%P%x00%D%x00%an%x00%ad%x00%s".into(),
            format!("-n{safe_limit}"),
        ],
        read_only_git_options(GitCommandOptions {
            signal,
            ..Default::default()
        }),
    )
    .await?;
    Ok(GitGraphResult {
        commits: parse_graph(&result.stdout),
    })
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use garcon_base::errors::NamedError;

    use super::parse_blame;

    #[test]
    fn invalid_blame_author_times_use_the_original_bun_range_error() {
        let output = Command::new("bun")
            .args([
                "-e",
                r#"
                if (Bun.version !== '1.4.3') throw new Error('Expected Bun 1.4.3');
                console.log(JSON.stringify(['invalid', '8640000000001'].map(time => {
                    try { return new Date(Number(time) * 1000).toISOString(); }
                    catch (error) { return [error.name, error.message]; }
                })));
            "#,
            ])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let expected: Vec<(String, String)> = garcon_js::json::from_slice(&output.stdout).unwrap();
        assert_eq!(expected.len(), 2);
        for (time, (name, message)) in ["invalid", "8640000000001"].into_iter().zip(expected) {
            let blame = format!("{} 1 1 1\nauthor-time {time}\n\tline\n", "a".repeat(40));
            let error = parse_blame(&blame).unwrap_err();
            let error = error.downcast_ref::<NamedError>().unwrap();
            assert_eq!(error.name, name);
            assert_eq!(error.message, message);
        }
    }
}
