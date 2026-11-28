//! Ports `server/runtime/git/status.ts`.

use std::io::{self, ErrorKind};
use std::sync::LazyLock;

use garcon_base::log::{Logger, create_logger};
use garcon_contract::git::{
    BranchOptions, CheckoutOptions, CommitIndexOptions, CommitMessageContextOptions, CommitOptions,
    FileOptions, GIT_REF_RESULT_LIMITS, GitBranchesResult, GitCommitMessageContextResult,
    GitCommitResult, GitCommitScope, GitMutationResult, GitRefKind, GitRefOption, GitRefSort,
    GitRefsOptions, GitRefsResponse, GitRemoteStatus, GitRemotesResult, GitStageMode, GitStatus,
    PushOptions, RemoteInfo, RevertCommitOptions, StagePathsOptions,
};
use garcon_contract::git_refs::{DEFAULT_GIT_REF_SORT, GitRefSortDirection, GitRefSortKey};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, is_safe_integer, path::native, to_iso_string, trim, trim_end, utf16};
use indexmap::{IndexMap, IndexSet};
use regress::Regex;
use tokio::fs;
use tokio_util::sync::CancellationToken;

use super::comparison_errors::is_expected_missing_git_result;
use super::git_domain_error::GitDomainError;
use super::operation_context::{
    assert_git_working_path, is_git_cancellation, mark_git_mutation_dispatched,
};
use super::pathspecs::{chunk_git_pathspecs, literal_git_pathspec};
use super::porcelain_status::parse_porcelain_v1_z;
use super::push_branch::push_branch_ref;
use super::ref_validation::{
    assert_existing_commit_ref, assert_safe_branch_name, assert_safe_remote_name,
};
use super::repository_coordination::with_repository_mutation;
use super::run::{
    assert_git_repository, read_only_git_options, resolve_path_within_project, run_git,
    run_git_with_stdin,
};
use super::selected_file_commit::commit_selected_files;
use super::temporary_index::TemporaryGitIndexEnvironment;
use super::types::{GitCommandOptions, GitCommandResult};

const LOCAL_BRANCH_REF_PATTERN: &str = "refs/heads";
const WHOLE_INDEX_COMMIT_STATE_REFS: [&str; 3] = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];
const NETWORK_GIT_DEFAULT_TIMEOUT_MS: f64 = 30_000.0;
const COMMIT_MESSAGE_DIFF_CONTEXT_LINES: usize = 10;
const COMMIT_MESSAGE_MAX_CODE_UNITS: usize = 80_000;

fn args<const N: usize>(args: [&str; N]) -> Vec<String> {
    args.map(str::to_owned).into()
}

fn readonly(signal: Option<&CancellationToken>) -> GitCommandOptions {
    read_only_git_options(GitCommandOptions {
        signal: signal.cloned(),
        ..Default::default()
    })
}

fn network_git_options() -> GitCommandOptions {
    GitCommandOptions {
        timeout_ms: Some(NETWORK_GIT_DEFAULT_TIMEOUT_MS),
        env: Some([("GIT_TERMINAL_PROMPT".into(), Some("0".into()))].into()),
        ..Default::default()
    }
}

fn invalid(message: &str) -> GitDomainError {
    GitDomainError::new("INVALID_INPUT", message)
}

fn success(output: Option<String>) -> GitMutationResult {
    GitMutationResult {
        success: true,
        output,
        output_truncated: None,
        message: None,
        remote_name: None,
        remote_branch: None,
        worktree_path: None,
    }
}

fn success_or(stdout: String, fallback: &str) -> GitMutationResult {
    success(Some(if stdout.is_empty() {
        fallback.into()
    } else {
        stdout
    }))
}

async fn has_commit_state_ref(project: &str, reference: &str) -> ExecutorResult<bool> {
    match run_git(
        project,
        args(["rev-parse", "--verify", "--quiet", reference]),
        readonly(None),
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(error) if is_expected_missing_git_result(error.as_ref()) => Ok(false),
        Err(error) => Err(error),
    }
}

async fn file_exists(path: &str) -> ExecutorResult<bool> {
    #[cfg(unix)]
    let result: io::Result<()> = {
        let path = path.to_owned();
        tokio::task::spawn_blocking(move || rustix::fs::access(path, rustix::fs::Access::EXISTS))
            .await?
            .map_err(io::Error::from)
    };
    #[cfg(windows)]
    let result: io::Result<()> = fs::metadata(path).await.map(drop);
    match result {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

async fn has_rebase_or_am_conflict_state(project: &str) -> ExecutorResult<bool> {
    let output = run_git(
        project,
        args([
            "rev-parse",
            "--git-path",
            "rebase-merge/stopped-sha",
            "--git-path",
            "rebase-merge/amend",
            "--git-path",
            "rebase-apply",
        ]),
        readonly(None),
    )
    .await?;
    let cwd = std::env::current_dir()?;
    let mut paths = trim_end(&output.stdout)
        .split('\n')
        .map(|state| native::resolve(&cwd.to_string_lossy(), &[project, state]));
    let (Some(stopped), Some(amend), Some(apply)) = (paths.next(), paths.next(), paths.next())
    else {
        return Err("Git returned incomplete rebase state paths.".into());
    };
    if file_exists(&apply).await? {
        return Ok(true);
    }
    Ok(file_exists(&stopped).await? && !file_exists(&amend).await?)
}

async fn requires_whole_index_commit(project: &str) -> ExecutorResult<bool> {
    for reference in WHOLE_INDEX_COMMIT_STATE_REFS {
        if has_commit_state_ref(project, reference).await? {
            return Ok(true);
        }
    }
    has_rebase_or_am_conflict_state(project).await
}

fn normalize_ref_search_query(query: Option<&str>) -> Option<&str> {
    let query = query.map_or("", trim);
    query
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || b"._/@{}~^+-".contains(&c))
        .then_some(query)
}

fn ref_patterns_for_query(query: &str) -> Vec<String> {
    if query.is_empty() {
        return vec![LOCAL_BRANCH_REF_PATTERN.into()];
    }
    if query.starts_with("refs/") {
        return vec![format!("{query}*")];
    }
    let mut patterns = vec![
        format!("refs/heads/{query}*"),
        format!("refs/remotes/{query}*"),
    ];
    if !query.contains('/') {
        patterns.push(format!("refs/remotes/*/{query}*"));
    }
    patterns.push(format!("refs/tags/{query}*"));
    patterns
}

fn git_ref_display_name(reference: &str) -> (&str, GitRefKind) {
    for (prefix, kind) in [
        ("refs/heads/", GitRefKind::LocalBranch),
        ("refs/remotes/", GitRefKind::RemoteBranch),
        ("refs/tags/", GitRefKind::Tag),
    ] {
        if let Some(name) = reference.strip_prefix(prefix) {
            return (name, kind);
        }
    }
    (reference, GitRefKind::Other)
}

fn git_ref_sort_args(sort: GitRefSort, patterns: &[String]) -> Vec<String> {
    if sort == DEFAULT_GIT_REF_SORT && patterns == [LOCAL_BRANCH_REF_PATTERN] {
        return Vec::new();
    }
    let direction = if sort.direction == GitRefSortDirection::Desc {
        "-"
    } else {
        ""
    };
    let primary = match sort.key {
        GitRefSortKey::Name => "refname:lstrip=2",
        GitRefSortKey::Updated => "creatordate",
    };
    vec![
        "--sort=refname".into(),
        format!("--sort={direction}{primary}"),
    ]
}

fn creator_date_iso(value: Option<&str>) -> Option<String> {
    let value = value?;
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let ms = value.parse::<f64>().ok()? * 1000.0;
    if !is_safe_integer(ms) {
        return None;
    }
    to_iso_string(ms as i64).ok()
}

fn parse_git_ref_line(line: &str, detached_oid: Option<&str>) -> Option<GitRefOption> {
    let mut parts = line.split('\0');
    let reference = parts.next().filter(|reference| !reference.is_empty())?;
    let object = parts.next();
    let creator_date = parts.next();
    let marker = parts.next();
    if reference.starts_with("refs/remotes/") && reference.ends_with("/HEAD") {
        return None;
    }
    let (name, kind) = git_ref_display_name(reference);
    let is_current = if kind == GitRefKind::LocalBranch {
        marker == Some("*")
    } else {
        detached_oid.is_some_and(|detached| !detached.is_empty() && Some(detached) == object)
    };
    Some(GitRefOption {
        name: name.into(),
        reference: reference.into(),
        kind,
        updated_at: creator_date_iso(creator_date),
        is_current: is_current.then_some(true),
    })
}

fn strip_git_line_ending(output: &str) -> &str {
    output
        .strip_suffix("\r\n")
        .or_else(|| output.strip_suffix('\n'))
        .unwrap_or(output)
}

struct AttachedBranch {
    branch: String,
    reference: String,
}

enum GitHeadIdentity {
    Attached(AttachedBranch),
    Detached(String),
}

async fn read_attached_branch(
    project: &str,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<Option<AttachedBranch>> {
    match run_git(
        project,
        args(["symbolic-ref", "--quiet", "HEAD"]),
        readonly(signal),
    )
    .await
    {
        Ok(output) => {
            let reference = strip_git_line_ending(&output.stdout);
            Ok(reference
                .strip_prefix("refs/heads/")
                .map(|branch| AttachedBranch {
                    branch: branch.into(),
                    reference: reference.into(),
                }))
        }
        Err(error) if is_expected_missing_git_result(error.as_ref()) => Ok(None),
        Err(error) => Err(error),
    }
}

async fn read_head_oid(
    project: &str,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<String> {
    let output = run_git(
        project,
        args(["show-ref", "--verify", "--hash", "HEAD"]),
        readonly(signal),
    )
    .await?;
    Ok(trim(&output.stdout).into())
}

async fn read_git_head_identity(
    project: &str,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitHeadIdentity> {
    match read_attached_branch(project, signal).await? {
        Some(branch) => Ok(GitHeadIdentity::Attached(branch)),
        None => Ok(GitHeadIdentity::Detached(
            read_head_oid(project, signal).await?,
        )),
    }
}

async fn has_head_commit(project: &str) -> ExecutorResult<bool> {
    match run_git(
        project,
        args(["show-ref", "--verify", "--quiet", "HEAD"]),
        readonly(None),
    )
    .await
    {
        Ok(_) => Ok(true),
        Err(error) if is_expected_missing_git_result(error.as_ref()) => Ok(false),
        Err(error) => Err(error),
    }
}

async fn verify_checked_out_ref(
    project: &str,
    reference: &str,
    fields: &[&str],
) -> ExecutorResult<Vec<String>> {
    let format = std::iter::once("%(HEAD)")
        .chain(fields.iter().copied())
        .collect::<Vec<_>>()
        .join("%00");
    let options = read_only_git_options(GitCommandOptions {
        env: Some([("LC_ALL".into(), Some("C".into()))].into()),
        ..Default::default()
    });
    let output = run_git(
        project,
        args([
            "for-each-ref",
            "--count=1",
            &format!("--format={format}"),
            reference,
        ]),
        options,
    )
    .await?;
    let mut fields = strip_git_line_ending(&output.stdout).split('\0');
    if fields.next() != Some("*") {
        return Err(invalid(
            "The checked-out branch has no commits or its exact name could not be verified.",
        )
        .into());
    }
    Ok(fields.map(str::to_owned).collect())
}

async fn status_without_upstream(project: &str, branch: String) -> ExecutorResult<GitRemoteStatus> {
    let output = run_git(project, args(["remote"]), readonly(None)).await?;
    let remotes: Vec<_> = output
        .stdout
        .lines()
        .filter(|remote| !remote.is_empty())
        .collect();
    Ok(GitRemoteStatus {
        has_remote: !remotes.is_empty(),
        has_upstream: false,
        branch,
        remote_name: if remotes.contains(&"origin") {
            Some("origin".into())
        } else {
            remotes.first().map(|name| (*name).to_owned())
        },
        remote_branch: None,
        ahead: None,
        behind: None,
        is_up_to_date: None,
        message: Some("No remote tracking branch configured".into()),
    })
}

async fn resolve_local_branch_checkout_name(
    project: &str,
    reference: &str,
    signal: Option<&CancellationToken>,
) -> Option<String> {
    let branch = reference.strip_prefix("refs/heads/").unwrap_or_else(|| {
        if reference.starts_with("refs/") {
            ""
        } else {
            reference
        }
    });
    if branch.is_empty() {
        return None;
    }
    run_git(
        project,
        args([
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{branch}"),
        ]),
        readonly(signal),
    )
    .await
    .ok()
    .map(|_| branch.into())
}

fn utf16_prefix(value: &str, max_units: usize) -> String {
    let mut output = utf16::truncate(value, max_units).to_owned();
    if utf16::char_code_at(value, max_units).is_some_and(|unit| (0xDC00..=0xDFFF).contains(&unit)) {
        output.push(char::REPLACEMENT_CHARACTER);
    }
    output
}

async fn resolve_detached_head_label(
    project: &str,
    head: &str,
    signal: Option<&CancellationToken>,
) -> String {
    if let Ok(output) = run_git(
        project,
        args([
            "for-each-ref",
            "--format=%(refname:short)",
            "--points-at",
            "HEAD",
            "refs/remotes",
            "refs/tags",
        ]),
        readonly(signal),
    )
    .await
        && let Some(label) = output
            .stdout
            .split('\n')
            .map(trim)
            .find(|label| !label.is_empty() && !label.ends_with("/HEAD"))
    {
        return label.into();
    }
    if let Ok(output) = run_git(
        project,
        args(["rev-parse", "--short", "HEAD"]),
        readonly(signal),
    )
    .await
    {
        let short = trim(&output.stdout);
        if !short.is_empty() {
            return short.into();
        }
    }
    if head.is_empty() {
        "HEAD".into()
    } else {
        utf16_prefix(head, 7)
    }
}

pub async fn collect_commit_message_diff_context(
    project: &str,
    files: &[String],
    signal: Option<&CancellationToken>,
    run: &impl AsyncFn(&str, Vec<String>, GitCommandOptions) -> ExecutorResult<GitCommandResult>,
) -> ExecutorResult<String> {
    let mut context = String::new();
    for chunk in chunk_git_pathspecs(files) {
        let mut argv = args([
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-color",
            &format!("-U{COMMIT_MESSAGE_DIFF_CONTEXT_LINES}"),
            "--",
        ]);
        argv.extend(chunk.iter().cloned());
        let mut opts = readonly(signal);
        opts.max_stdout_bytes = Some(320_000);
        opts.truncate_stdout = Some(true);
        match run(project, argv, opts).await {
            Ok(output) if !output.stdout.is_empty() => {
                if !context.is_empty() {
                    context.push('\n');
                }
                context.push_str(&output.stdout);
                if utf16::len(&context) >= COMMIT_MESSAGE_MAX_CODE_UNITS {
                    context = utf16_prefix(&context, COMMIT_MESSAGE_MAX_CODE_UNITS);
                    break;
                }
            }
            Ok(_) => {}
            Err(error) if signal.is_some_and(CancellationToken::is_cancelled) => return Err(error),
            Err(_) => create_logger("git:status").error(&format!(
                "Failed to collect staged diff ({} files)",
                chunk.len()
            )),
        }
    }
    Ok(context)
}

async fn resolve_status_branch(project: &str) -> ExecutorResult<(String, bool)> {
    let (symbolic, oid) =
        tokio::join!(biased; read_attached_branch(project, None), read_head_oid(project, None));
    let branch = symbolic?.map(|entry| entry.branch);
    match (branch, oid) {
        (Some(branch), Err(error)) if !is_git_cancellation(error.as_ref()) => {
            Ok((branch, has_head_commit(project).await?))
        }
        (_, Err(error)) => Err(error),
        (Some(branch), Ok(_)) => Ok((branch, true)),
        (None, Ok(oid)) => Ok((resolve_detached_head_label(project, &oid, None).await, true)),
    }
}

pub async fn get_status(project: &str) -> ExecutorResult<GitStatus> {
    assert_git_repository(project, None).await?;
    let ((branch, has_commits), output) = tokio::try_join!(biased;
        resolve_status_branch(project),
        run_git(project, args(["status", "--porcelain", "-z", "-uall"]), readonly(None)),
    )?;
    let mut status = GitStatus {
        branch,
        has_commits,
        modified: Vec::new(),
        added: Vec::new(),
        deleted: Vec::new(),
        untracked: Vec::new(),
    };
    for entry in parse_porcelain_v1_z(&output.stdout) {
        let (index, worktree) = (entry.index_status, entry.work_tree_status);
        if entry.path.is_empty()
            || [index, worktree]
                .iter()
                .any(|code| matches!(code, 'R' | 'C'))
        {
            continue;
        }
        if index == 'A' || worktree == 'A' {
            status.added.push(entry.path);
        } else if [index, worktree]
            .iter()
            .any(|code| matches!(code, 'U' | 'M' | 'T'))
        {
            status.modified.push(entry.path);
        } else if index == 'D' || worktree == 'D' {
            status.deleted.push(entry.path);
        } else if index == '?' && worktree == '?' {
            status.untracked.push(entry.path);
        }
    }
    Ok(status)
}

pub async fn initial_commit(project: &str) -> ExecutorResult<GitMutationResult> {
    assert_git_repository(project, None).await?;
    match run_git(project, args(["rev-parse", "HEAD"]), readonly(None)).await {
        Ok(_) => {
            return Err(invalid(
                "Initial commit is only available for repositories with no existing commits.",
            )
            .into());
        }
        Err(error) if error.is::<GitDomainError>() => return Err(error),
        Err(_) => {}
    }
    run_git(project, args(["add", "."]), GitCommandOptions::default()).await?;
    let output = run_git(
        project,
        args(["commit", "-m", "Initial commit"]),
        GitCommandOptions::default(),
    )
    .await?;
    Ok(GitMutationResult {
        message: Some("Initial commit created successfully".into()),
        ..success(Some(output.stdout))
    })
}

pub async fn commit(
    request: &CommitOptions,
    index_environment: &TemporaryGitIndexEnvironment,
) -> ExecutorResult<GitCommitResult> {
    let project = &request.project_path;
    assert_git_repository(project, None).await?;
    for file in &request.files {
        if file.is_empty() {
            return Err(invalid("Pathspecs cannot be empty.").into());
        }
        if file.contains('\0') {
            return Err(invalid("Pathspecs cannot contain NUL bytes.").into());
        }
        if resolve_path_within_project(project, file).is_err() {
            return Err(invalid("Pathspecs must resolve inside the project root.").into());
        }
    }
    with_repository_mutation(project, || async {
        if !requires_whole_index_commit(project).await? {
            let result =
                commit_selected_files(project, &request.message, &request.files, index_environment)
                    .await?;
            return Ok(GitCommitResult {
                success: true,
                output: result.output,
                commit_scope: GitCommitScope::SelectedFiles,
                index_synchronized: result.index_synchronized,
            });
        }
        for file in &request.files {
            run_git(
                project,
                args(["add", "--", &literal_git_pathspec(file)]),
                GitCommandOptions::default(),
            )
            .await?;
        }
        let output = run_git(
            project,
            args(["commit", "-m", &request.message]),
            GitCommandOptions::default(),
        )
        .await?;
        Ok(GitCommitResult {
            success: true,
            output: output.stdout,
            commit_scope: GitCommitScope::WholeIndex,
            index_synchronized: true,
        })
    })
    .await
}

pub async fn get_refs(
    request: &GitRefsOptions,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitRefsResponse> {
    let project = &request.project_path;
    let Some(query) = normalize_ref_search_query(request.query.as_deref()) else {
        assert_git_repository(project, signal.cloned()).await?;
        return Ok(GitRefsResponse { refs: Vec::new() });
    };
    let limit = request
        .limit
        .filter(|&limit| limit > 0)
        .map(|limit| limit as usize)
        .unwrap_or(GIT_REF_RESULT_LIMITS.default)
        .min(GIT_REF_RESULT_LIMITS.max);
    let patterns = ref_patterns_for_query(query);
    let mut argv = vec!["for-each-ref".into(), format!("--count={limit}")];
    argv.extend(git_ref_sort_args(
        request.sort.unwrap_or(DEFAULT_GIT_REF_SORT),
        &patterns,
    ));
    argv.push("--format=%(refname)%00%(objectname)%00%(creatordate:unix)%00%(HEAD)".into());
    argv.extend(patterns);
    let (repository, identity, refs) = tokio::join!(biased;
        assert_git_repository(project, signal.cloned()),
        read_git_head_identity(project, signal),
        async { run_git(project, argv, readonly(signal)).await },
    );
    repository?;
    let detached = match identity {
        Err(error) if signal.is_some_and(CancellationToken::is_cancelled) => return Err(error),
        Ok(GitHeadIdentity::Detached(oid)) => Some(oid),
        _ => None,
    };
    let output = refs?.stdout;
    Ok(GitRefsResponse {
        refs: output
            .split('\n')
            .filter_map(|line| parse_git_ref_line(line, detached.as_deref()))
            .collect(),
    })
}

pub async fn get_branches(
    project: &str,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitBranchesResult> {
    let result = get_refs(
        &GitRefsOptions {
            project_path: project.into(),
            query: None,
            limit: None,
            sort: None,
        },
        signal,
    )
    .await?;
    let branches = result
        .refs
        .into_iter()
        .filter(|reference| reference.kind == GitRefKind::LocalBranch)
        .map(|reference| reference.name)
        .collect::<IndexSet<_>>()
        .into_iter()
        .collect();
    Ok(GitBranchesResult { branches })
}

pub async fn checkout(
    request: &CheckoutOptions,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitMutationResult> {
    let project = &request.project_path;
    let reference = &request.reference;
    assert_git_repository(project, None).await?;
    assert_existing_commit_ref(project, reference, "checkout", signal.cloned()).await?;
    let local = if request
        .ref_kind
        .is_none_or(|kind| kind == GitRefKind::LocalBranch)
    {
        resolve_local_branch_checkout_name(project, reference, signal).await
    } else {
        None
    };
    if request.ref_kind == Some(GitRefKind::LocalBranch) && local.is_none() {
        return Err(invalid("Invalid local branch ref.").into());
    }
    let argv = match local {
        Some(branch) => vec!["checkout".into(), branch],
        None => args(["checkout", "--detach", reference]),
    };
    let output = run_git(project, argv, GitCommandOptions::default()).await?;
    Ok(success(Some(output.stdout)))
}

pub async fn create_branch(
    request: &BranchOptions,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitMutationResult> {
    let project = &request.project_path;
    assert_git_repository(project, None).await?;
    assert_safe_branch_name(
        project,
        &request.branch,
        Some("branch name"),
        signal.cloned(),
    )
    .await?;
    let mut argv = args(["checkout", "-b", &request.branch]);
    if let Some(base) = request.base_ref.as_deref().filter(|base| !base.is_empty()) {
        assert_existing_commit_ref(project, base, "base", signal.cloned()).await?;
        argv.push(base.into());
    }
    let output = run_git(project, argv, GitCommandOptions::default()).await?;
    Ok(success(Some(output.stdout)))
}

pub async fn collect_commit_message_context(
    request: &CommitMessageContextOptions,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<GitCommitMessageContextResult> {
    let run = async |cwd: &str, argv, options| run_git(cwd, argv, options).await;
    let diff =
        collect_commit_message_diff_context(&request.project_path, &request.files, signal, &run)
            .await?;
    Ok(GitCommitMessageContextResult { diff })
}

static TRACKING_COUNTS: LazyLock<Regex> = LazyLock::new(|| {
    // INFALLIBLE: the static pattern is a valid ECMAScript expression.
    Regex::new(r"^(?:ahead (\d+))?(?:, )?(?:behind (\d+))?$")
        .expect("valid Git tracking count expression")
});

pub async fn get_remote_status(project: &str) -> ExecutorResult<GitRemoteStatus> {
    assert_git_repository(project, None).await?;
    let GitHeadIdentity::Attached(head) = read_git_head_identity(project, None).await? else {
        return status_without_upstream(project, "HEAD".into()).await;
    };
    let fields = verify_checked_out_ref(
        project,
        &head.reference,
        &[
            "%(upstream:remotename)",
            "%(upstream:short)",
            "%(upstream:track,nobracket)",
        ],
    )
    .await?;
    let mut fields = fields.into_iter();
    let (remote, remote_branch, track) = (fields.next(), fields.next(), fields.next());
    let (Some(remote), Some(remote_branch)) = (
        remote.filter(|name| !name.is_empty()),
        remote_branch.filter(|name| !name.is_empty()),
    ) else {
        return status_without_upstream(project, head.branch).await;
    };
    if track.as_deref() == Some("gone") {
        return status_without_upstream(project, head.branch).await;
    }
    let track = track.as_deref().unwrap_or("undefined");
    let counts = TRACKING_COUNTS
        .find(track)
        .ok_or("Git returned unrecognized upstream tracking counts.")?;
    let count = |index| {
        counts
            .group(index)
            .and_then(|range| track[range].parse::<f64>().ok())
            .unwrap_or_default()
    };
    let (ahead, behind) = (count(1), count(2));
    Ok(GitRemoteStatus {
        has_remote: true,
        has_upstream: true,
        branch: head.branch,
        remote_name: Some(remote),
        remote_branch: Some(remote_branch),
        ahead: Some(Number(ahead)),
        behind: Some(Number(behind)),
        is_up_to_date: Some(ahead == 0.0 && behind == 0.0),
        message: None,
    })
}

async fn upstream(project: &str, branch: &str) -> ExecutorResult<String> {
    let output = run_git(
        project,
        args([
            "rev-parse",
            "--abbrev-ref",
            &format!("{branch}@{{upstream}}"),
        ]),
        readonly(None),
    )
    .await?;
    Ok(trim(&output.stdout).into())
}

async fn abbreviated_head(project: &str) -> ExecutorResult<String> {
    let output = run_git(
        project,
        args(["rev-parse", "--abbrev-ref", "HEAD"]),
        readonly(None),
    )
    .await?;
    Ok(trim(&output.stdout).into())
}

pub async fn fetch(project: &str) -> ExecutorResult<GitMutationResult> {
    assert_git_repository(project, None).await?;
    let branch = abbreviated_head(project).await?;
    let remote = match upstream(project, &branch).await {
        Ok(tracking) => tracking.split('/').next().unwrap_or_default().to_owned(),
        Err(_) => {
            create_logger("git:status").info("No upstream configured, using origin as fallback");
            "origin".into()
        }
    };
    let output = run_git(project, args(["fetch", &remote]), network_git_options()).await?;
    Ok(GitMutationResult {
        remote_name: Some(remote),
        ..success_or(output.stdout, "Fetch completed successfully")
    })
}

pub async fn pull(project: &str) -> ExecutorResult<GitMutationResult> {
    assert_git_repository(project, None).await?;
    let branch = abbreviated_head(project).await?;
    let (remote, remote_branch) = match upstream(project, &branch).await {
        Ok(tracking) => {
            let (remote, branch) = tracking.split_once('/').unwrap_or((&tracking, ""));
            (remote.to_owned(), branch.to_owned())
        }
        Err(_) => {
            create_logger("git:status")
                .info("No upstream configured, using origin/branch as fallback");
            ("origin".into(), branch)
        }
    };
    let output = run_git(
        project,
        args(["pull", &remote, &remote_branch]),
        network_git_options(),
    )
    .await?;
    Ok(GitMutationResult {
        remote_name: Some(remote),
        remote_branch: Some(remote_branch),
        ..success_or(output.stdout, "Pull completed successfully")
    })
}

fn js_whitespace(character: char) -> bool {
    trim(character.encode_utf8(&mut [0; 4])).is_empty()
}

pub async fn get_remotes(project: &str) -> ExecutorResult<GitRemotesResult> {
    assert_git_repository(project, None).await?;
    let output = run_git(project, args(["remote", "-v"]), readonly(None)).await?;
    let mut seen = IndexMap::new();
    for line in trim(&output.stdout)
        .split('\n')
        .filter(|line| !trim(line).is_empty())
    {
        let mut whitespace = false;
        let mut tokens = line.split(|character: char| {
            let next = js_whitespace(character);
            let separated = next && !whitespace;
            whitespace = next;
            separated
        });
        if let (Some(name), Some(url)) = (tokens.next(), tokens.next()) {
            let url = url.trim_start_matches(js_whitespace);
            seen.entry(name).or_insert_with(|| RemoteInfo {
                name: name.into(),
                url: url.into(),
            });
        }
    }
    Ok(GitRemotesResult {
        remotes: seen.into_values().collect(),
    })
}

pub async fn push(request: &PushOptions) -> ExecutorResult<GitMutationResult> {
    let project = &request.project_path;
    assert_git_repository(project, None).await?;
    let remote = request
        .remote
        .as_deref()
        .filter(|remote| !remote.is_empty())
        .unwrap_or("origin");
    assert_safe_remote_name(remote, None)?;
    let GitHeadIdentity::Attached(head) = read_git_head_identity(project, None).await? else {
        return Err(invalid("Check out a local branch before pushing.").into());
    };
    if request
        .remote_branch
        .as_ref()
        .is_some_and(|branch| branch != &head.branch)
    {
        return Err(invalid("Remote branch must match the current local branch.").into());
    }
    verify_checked_out_ref(project, &head.reference, &[]).await?;
    push_branch_ref(project, remote, &head.reference, network_git_options()).await?;
    Ok(GitMutationResult {
        remote_name: Some(remote.into()),
        remote_branch: Some(head.branch),
        ..success(Some("Push completed successfully".into()))
    })
}

pub async fn delete_untracked(request: &FileOptions) -> ExecutorResult<GitMutationResult> {
    let project = &request.project_path;
    let file = &request.file;
    assert_git_repository(project, None).await?;
    let path = resolve_path_within_project(project, file)?;
    if path == resolve_path_within_project(project, ".")? {
        return Err(
            invalid("The project directory cannot be deleted as an untracked file.").into(),
        );
    }
    let pathspec = literal_git_pathspec(file);
    let indexed = run_git(
        project,
        args(["ls-files", "-z", "--", &pathspec]),
        readonly(None),
    )
    .await?;
    if !indexed.stdout.is_empty() {
        return Err(invalid(
            "The path contains files tracked by Git. Use discard for tracked files.",
        )
        .into());
    }
    let status = run_git(
        project,
        args(["status", "--porcelain", "--", &pathspec]),
        readonly(None),
    )
    .await?;
    if trim(&status.stdout).is_empty() {
        return Err(
            invalid("The file is either tracked already or does not exist on disk.").into(),
        );
    }
    if !status.stdout.starts_with("??") {
        return Err(invalid("The file is tracked by Git. Use discard for tracked files.").into());
    }
    assert_git_working_path(&path).await?;
    let stat = fs::symlink_metadata(&path).await?;
    mark_git_mutation_dispatched();
    let kind = if stat.is_dir() {
        if let Err(error) = fs::remove_dir_all(&path).await
            && error.kind() != ErrorKind::NotFound
        {
            return Err(error.into());
        }
        "directory"
    } else {
        fs::remove_file(&path).await?;
        "file"
    };
    Ok(GitMutationResult {
        message: Some(format!("Untracked {kind} {file} deleted successfully")),
        ..success(None)
    })
}

pub async fn commit_index(request: &CommitIndexOptions) -> ExecutorResult<GitMutationResult> {
    let project = &request.project_path;
    assert_git_repository(project, None).await?;
    with_repository_mutation(project, || async {
        let output = run_git(
            project,
            args(["commit", "-m", &request.message]),
            GitCommandOptions::default(),
        )
        .await?;
        Ok(success(Some(output.stdout)))
    })
    .await
}

fn pathspec_stdin(paths: &[String]) -> String {
    let mut input = String::new();
    for path in paths {
        input.push_str(&literal_git_pathspec(path));
        input.push('\0');
    }
    input
}

pub async fn stage_paths(request: &StagePathsOptions) -> ExecutorResult<GitMutationResult> {
    let project = &request.project_path;
    assert_git_repository(project, None).await?;
    if request.paths.is_empty() {
        return Err(invalid("At least one path is required.").into());
    }
    for path in &request.paths {
        if path.is_empty() {
            return Err(invalid("Pathspecs cannot be empty.").into());
        }
        if path.contains('\0') {
            return Err(invalid("Pathspecs cannot contain NUL bytes.").into());
        }
        resolve_path_within_project(project, path)?;
    }
    let argv = match request.mode {
        GitStageMode::Stage => args(["add", "--pathspec-from-file=-", "--pathspec-file-nul"]),
        GitStageMode::Unstage => args([
            "reset",
            "-q",
            "HEAD",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
        ]),
    };
    run_git_with_stdin(
        project,
        argv,
        pathspec_stdin(&request.paths),
        GitCommandOptions::default(),
    )
    .await?;
    Ok(success(None))
}

pub async fn revert_commit(request: &RevertCommitOptions) -> ExecutorResult<GitMutationResult> {
    let project = &request.project_path;
    let commit = &request.commit;
    assert_git_repository(project, None).await?;
    assert_existing_commit_ref(project, commit, "commit", None).await?;
    let parents = run_git(
        project,
        args(["rev-list", "--parents", "-n", "1", commit]),
        readonly(None),
    )
    .await?;
    let count = parents
        .stdout
        .split(js_whitespace)
        .filter(|word| !word.is_empty())
        .count();
    let argv = if count > 2 {
        args(["revert", "--no-edit", "-m", "1", commit])
    } else {
        args(["revert", "--no-edit", commit])
    };
    let output = run_git(project, argv, GitCommandOptions::default()).await?;
    Ok(success_or(
        output.stdout,
        &format!("Commit {} reverted", utf16_prefix(commit, 7)),
    ))
}
