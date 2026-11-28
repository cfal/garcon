//! Ports `server/runtime/git/review-diff-batch.ts`.

use std::cell::RefCell;

use garcon_base::concurrency::{ConcurrencyError, map_with_concurrency_result};
use garcon_base::errors::{ErrorInput, NamedError, diagnostic_error_code};
use garcon_contract::git::{
    GIT_REVIEW_DOCUMENT_LIMITS, GitReviewBodyState, GitReviewFilePatchBody, GitReviewLimitReason,
    GitReviewMode,
};
use garcon_contract::git_diagnostics::{GitReviewRouteMetrics, GitReviewRoutePhaseName as Phase};
use garcon_interface::resources::ExecutorResult;
use garcon_js::{Number, number_to_string, path::native};
use indexmap::IndexMap;
use serde::Serialize;
use tokio::fs;
use tokio_util::sync::CancellationToken;

use crate::cancellation::check_cancelled;

use super::operation_context::assert_git_working_path;
use super::pathspecs::exact_git_pathspecs;
use super::review_document_registry::{
    GitReviewDocumentSource as Source, RegisteredGitReviewChange as Change,
    RegisteredGitReviewDocument, RegisteredGitReviewFile,
};
use super::review_patch::{
    SplitRawDiffPatch, create_review_patch_body, error_patch_file_body, limited_patch_file_body,
    split_patches_from_raw_diff,
};
use super::review_performance::{measure_git_review_phase, measure_git_review_phase_sync};
use super::run::{
    GitOutputLimitError, read_only_git_options, resolve_path_within_project, run_git_traced_shared,
};
use super::temporary_index::TemporaryGitIndexEnvironment;
use super::types::{GitCommandOptions, GitCommandTrace};
use super::untracked_patch::load_untracked_patches;

const TARGET_BATCH_ESTIMATED_ROWS: f64 = 20_000.0;
const MAX_BATCH_STDOUT_BYTES: usize = GIT_REVIEW_DOCUMENT_LIMITS.max_loaded_patch_bytes + 2_000_000;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewDiffBatchMetrics {
    pub batch_count: usize,
    pub bisection_count: usize,
}

#[derive(Debug, Serialize)]
pub struct GitReviewDiffBatchResult {
    pub bodies: Vec<GitReviewFilePatchBody>,
    pub errors: IndexMap<String, String>,
    pub metrics: GitReviewDiffBatchMetrics,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitReviewLoadedBodyTotals {
    pub loaded_rows: Number,
    pub loaded_bytes: Number,
}

impl Default for GitReviewLoadedBodyTotals {
    fn default() -> Self {
        Self {
            loaded_rows: Number(0.0),
            loaded_bytes: Number(0.0),
        }
    }
}

struct ResponseBudget {
    totals: GitReviewLoadedBodyTotals,
    exhausted: bool,
}

pub fn plan_review_diff_batches<'a>(
    files: impl IntoIterator<Item = &'a RegisteredGitReviewFile>,
) -> Vec<Vec<&'a RegisteredGitReviewFile>> {
    let mut batches = Vec::new();
    let mut current = Vec::new();
    let mut current_rows = 0.0;
    for file in files {
        let estimated = file.estimated_rows.0;
        let rows = if estimated < 1.0 { 1.0 } else { estimated };
        if !current.is_empty()
            && (current.len() >= GIT_REVIEW_DOCUMENT_LIMITS.max_body_batch_files
                || current_rows + rows > TARGET_BATCH_ESTIMATED_ROWS)
        {
            batches.push(std::mem::take(&mut current));
            current_rows = 0.0;
        }
        current.push(file);
        current_rows += rows;
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

fn is_untracked(document: &RegisteredGitReviewDocument, file: &RegisteredGitReviewFile) -> bool {
    match &file.change {
        Change::TreeDiff { raw_status, .. } => raw_status.starts_with('?'),
        Change::Workbench {
            index_status,
            work_tree_status,
        } => {
            matches!(
                document.source,
                Source::Workbench {
                    mode: GitReviewMode::Working,
                    ..
                }
            ) && (index_status == "?" || work_tree_status == "?")
        }
    }
}

fn first_status(status: &str) -> &str {
    let end = status.chars().next().map_or(0, char::len_utf8);
    &status[..end]
}

fn expected_status<'a>(
    document: &RegisteredGitReviewDocument,
    file: &'a RegisteredGitReviewFile,
) -> &'a str {
    match &file.change {
        Change::TreeDiff { raw_status, .. } => first_status(raw_status),
        Change::Workbench {
            index_status,
            work_tree_status,
        } => {
            if matches!(
                document.source,
                Source::Workbench {
                    mode: GitReviewMode::Staged,
                    ..
                }
            ) {
                index_status
            } else {
                work_tree_status
            }
        }
    }
}

fn expected_rename_source<'a>(
    document: &RegisteredGitReviewDocument,
    file: &'a RegisteredGitReviewFile,
) -> Option<&'a str> {
    // Only the reviewed facet's status can require a rename source.
    if matches!(document.source, Source::Workbench { .. })
        && matches!(file.change, Change::Workbench { .. })
        && !matches!(expected_status(document, file), "R" | "C")
    {
        return None;
    }
    file.original_path.as_deref()
}

fn split_matches(
    document: &RegisteredGitReviewDocument,
    file: &RegisteredGitReviewFile,
    split: &SplitRawDiffPatch,
) -> bool {
    let expected = expected_status(document, file);
    let actual = first_status(&split.entry.raw_status);
    if is_untracked(document, file) {
        return actual == "A"
            && split
                .entry
                .original_path
                .as_deref()
                .is_none_or(str::is_empty);
    }
    (matches!(expected, "" | " ") || expected == actual)
        && expected_rename_source(document, file) == split.entry.original_path.as_deref()
}

fn diff_args(
    document: &RegisteredGitReviewDocument,
    files: &[&RegisteredGitReviewFile],
    fallback: bool,
) -> Vec<String> {
    let paths: Vec<_> = files
        .iter()
        .flat_map(|file| {
            file.original_path
                .iter()
                .filter(|path| !path.is_empty())
                .chain(std::iter::once(&file.path))
                .cloned()
        })
        .collect();
    let mut args = [
        "diff",
        "--patch-with-raw",
        "-z",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
    ]
    .map(str::to_owned)
    .to_vec();
    args.extend([
        format!("-U{}", document.context),
        "--find-renames".into(),
        "--submodule=short".into(),
    ]);
    if matches!(
        document.source,
        Source::Workbench {
            mode: GitReviewMode::Staged,
            ..
        }
    ) {
        args.push("--cached".into());
    }
    if fallback
        && files
            .first()
            .and_then(|file| expected_rename_source(document, file))
            .is_some_and(|path| !path.is_empty())
    {
        args.push("--diff-filter=RC".into());
    }
    match &document.source {
        Source::Workbench {
            mode: GitReviewMode::Staged,
            staged_base_hash,
            ..
        } => args.push(staged_base_hash.clone()),
        Source::Workbench { .. } => (),
        Source::Commit {
            base_hash,
            target_hash,
        } => args.extend([base_hash.clone(), target_hash.clone()]),
        Source::ComparisonRevisions {
            effective_from_hash,
            to_hash,
        } => args.extend([effective_from_hash.clone(), to_hash.clone()]),
        Source::ComparisonWorkingTree {
            effective_from_hash,
            ..
        } => args.push(effective_from_hash.clone()),
    }
    args.push("--".into());
    args.extend(exact_git_pathspecs(&paths));
    args
}

async fn validate_untracked_file(
    document: &RegisteredGitReviewDocument,
    file: &RegisteredGitReviewFile,
    signal: Option<&CancellationToken>,
) -> ExecutorResult<Option<GitReviewFilePatchBody>> {
    let result: ExecutorResult<_> = async {
        check_cancelled(signal)?;
        let file_path = resolve_path_within_project(&document.repo_root, &file.path)?;
        assert_git_working_path(&native::dirname(&file_path)).await?;
        let stats = fs::symlink_metadata(&file_path).await.map_err(|error| {
            let code = diagnostic_error_code(ErrorInput::Error(&error));
            let message = error.to_string();
            let description = match code {
                "ENOENT" => "no such file or directory",
                "ENOTDIR" => "not a directory",
                "EACCES" => "permission denied",
                "EPERM" => "operation not permitted",
                "ELOOP" => "too many symbolic links encountered",
                _ => &message,
            };
            NamedError {
                name: "Error".into(),
                message: format!("{code}: {description}, lstat '{file_path}'"),
                code: Some(code.into()),
            }
        })?;
        check_cancelled(signal)?;
        if !stats.is_file() {
            return Ok(Some(limited_patch_file_body(
                &file.path,
                &file.body_fingerprint,
                GitReviewLimitReason::UnsupportedFileKind,
                "Only regular untracked files can be reviewed.",
            )));
        }
        let max_bytes = GIT_REVIEW_DOCUMENT_LIMITS.max_file_patch_bytes;
        if stats.len() > max_bytes as u64 {
            return Ok(Some(limited_patch_file_body(
                &file.path,
                &file.body_fingerprint,
                GitReviewLimitReason::FileTooManyBytes,
                format!("File exceeds {max_bytes} byte display limit."),
            )));
        }
        assert_git_working_path(&file_path).await?;
        Ok(None)
    }
    .await;
    match result {
        Err(error) if !signal.is_some_and(CancellationToken::is_cancelled) => Ok(Some(
            error_patch_file_body(&file.path, &file.body_fingerprint, &error.to_string()),
        )),
        result => result,
    }
}

pub struct GitReviewDiffBatchContext<'a> {
    pub trace: Option<&'a RefCell<Vec<GitCommandTrace>>>,
    pub signal: Option<&'a CancellationToken>,
    pub metrics: Option<&'a RefCell<GitReviewRouteMetrics>>,
    pub temporary_index: &'a TemporaryGitIndexEnvironment,
}

impl GitReviewDiffBatchContext<'_> {
    fn command_options(&self, max_stdout_bytes: usize) -> GitCommandOptions {
        read_only_git_options(GitCommandOptions {
            signal: self.signal.cloned(),
            max_stdout_bytes: Some(max_stdout_bytes),
            ..Default::default()
        })
    }

    async fn read_batch(
        &self,
        document: &RegisteredGitReviewDocument,
        files: &[&RegisteredGitReviewFile],
        untracked: bool,
    ) -> ExecutorResult<Vec<GitReviewFilePatchBody>> {
        let stdout = measure_git_review_phase(self.metrics, Phase::BodyGit, || async {
            let options = self.command_options(MAX_BATCH_STDOUT_BYTES);
            if untracked {
                let paths: Vec<_> = files.iter().map(|file| file.path.clone()).collect();
                load_untracked_patches(
                    &document.repo_root,
                    &paths,
                    document.context,
                    options,
                    self.trace,
                    self.temporary_index,
                )
                .await
            } else {
                Ok(run_git_traced_shared(
                    &document.repo_root,
                    diff_args(document, files, false),
                    self.trace,
                    options,
                )
                .await?
                .stdout)
            }
        })
        .await?;
        let split = measure_git_review_phase_sync(self.metrics, Phase::BodySplit, || {
            split_patches_from_raw_diff(&stdout)
        })?;
        let mut bodies = Vec::with_capacity(files.len());
        for file in files {
            let entry = split.get(&file.path);
            let fallback;
            let entry = if !untracked
                && entry.is_none_or(|entry| !split_matches(document, file, entry))
            {
                let output = measure_git_review_phase(self.metrics, Phase::BodyGit, || {
                    run_git_traced_shared(
                        &document.repo_root,
                        diff_args(document, &[*file], true),
                        self.trace,
                        self.command_options(
                            GIT_REVIEW_DOCUMENT_LIMITS.max_file_patch_bytes + 1_000_000,
                        ),
                    )
                })
                .await?;
                fallback = measure_git_review_phase_sync(self.metrics, Phase::BodySplit, || {
                    Ok::<_, garcon_base::errors::NamedError>(
                        split_patches_from_raw_diff(&output.stdout)?.shift_remove(&file.path),
                    )
                })?;
                fallback.as_ref()
            } else {
                entry
            };
            let body =
                if let Some(entry) = entry.filter(|entry| split_matches(document, file, entry)) {
                    measure_git_review_phase_sync(self.metrics, Phase::PatchScan, || {
                        create_review_patch_body(
                            &file.path,
                            &file.body_fingerprint,
                            entry.patch.clone(),
                            entry.entry.patch_section_count > 1,
                        )
                    })
                } else {
                    error_patch_file_body(
                        &file.path,
                        &file.body_fingerprint,
                        &format!(
                            "Git diff output did not match the registered change for {}.",
                            file.path
                        ),
                    )
                };
            bodies.push(body);
        }
        Ok(bodies)
    }

    async fn run_batch(
        &self,
        document: &RegisteredGitReviewDocument,
        files: &[&RegisteredGitReviewFile],
        metrics: &mut GitReviewDiffBatchMetrics,
    ) -> ExecutorResult<Vec<GitReviewFilePatchBody>> {
        let mut pending = vec![files];
        let mut bodies = Vec::with_capacity(files.len());
        while let Some(batch) = pending.pop() {
            let Some(first) = batch.first() else { continue };
            metrics.batch_count += 1;
            match self
                .read_batch(document, batch, is_untracked(document, first))
                .await
            {
                Ok(loaded) => bodies.extend(loaded),
                Err(error) if self.signal.is_some_and(CancellationToken::is_cancelled) => {
                    return Err(error);
                }
                Err(_) if batch.len() > 1 => {
                    metrics.bisection_count += 1;
                    let (left, right) = batch.split_at(batch.len().div_ceil(2));
                    pending.extend([right, left]);
                }
                Err(error)
                    if error
                        .downcast_ref::<GitOutputLimitError>()
                        .is_some_and(|error| error.stream == "stdout") =>
                {
                    bodies.push(limited_patch_file_body(
                        &first.path,
                        &first.body_fingerprint,
                        GitReviewLimitReason::FileTooManyBytes,
                        format!(
                            "Diff exceeds {} byte display limit.",
                            GIT_REVIEW_DOCUMENT_LIMITS.max_file_patch_bytes
                        ),
                    ));
                }
                Err(error) => bodies.push(error_patch_file_body(
                    &first.path,
                    &first.body_fingerprint,
                    &error.to_string(),
                )),
            }
        }
        Ok(bodies)
    }
}

pub async fn load_review_diff_batches(
    document: &RegisteredGitReviewDocument,
    requested_files: &[&RegisteredGitReviewFile],
    context: &GitReviewDiffBatchContext<'_>,
    initial_totals: GitReviewLoadedBodyTotals,
) -> ExecutorResult<GitReviewDiffBatchResult> {
    let mut metrics = GitReviewDiffBatchMetrics::default();
    let mut bodies = Vec::new();
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    let mut budget = ResponseBudget::new(initial_totals);

    for &file in requested_files {
        if file.body_state != GitReviewBodyState::Unloaded {
            budget.append(
                &mut bodies,
                limited_patch_file_body(
                    &file.path,
                    &file.body_fingerprint,
                    file.limit_reason
                        .unwrap_or(GitReviewLimitReason::UnsupportedFileKind),
                    file.limit_message
                        .as_deref()
                        .unwrap_or("This file cannot be rendered."),
                ),
            );
        } else if is_untracked(document, file) {
            untracked.push(file);
        } else {
            tracked.push(file);
        }
    }

    if budget.exhausted
        && let Some(file) = untracked.first().or_else(|| tracked.first())
    {
        bodies.push(budget.limit_body(&file.path, &file.body_fingerprint, None));
    }
    for group in plan_review_diff_batches(untracked) {
        if budget.exhausted {
            break;
        }
        let validation = map_with_concurrency_result(
            &group,
            GIT_REVIEW_DOCUMENT_LIMITS.body_concurrency as f64,
            |&file, _| validate_untracked_file(document, file, context.signal),
        )
        .await
        .map_err(|error| match error {
            ConcurrencyError::Work(error) => error,
            ConcurrencyError::InvalidLimit => "Concurrency limit must be a positive integer".into(),
        })?;
        let eligible: Vec<_> = group
            .into_iter()
            .zip(&validation)
            .filter_map(|(file, body)| body.is_none().then_some(file))
            .collect();
        let mut loaded = context
            .run_batch(document, &eligible, &mut metrics)
            .await?
            .into_iter();
        for body in validation {
            // INFALLIBLE: a successful batch emits one body for each eligible input, in order.
            let body = body.unwrap_or_else(|| loaded.next().expect("validated batch body"));
            budget.append(&mut bodies, body);
            if budget.exhausted {
                break;
            }
        }
    }
    for batch in plan_review_diff_batches(tracked) {
        if budget.exhausted {
            break;
        }
        for body in context.run_batch(document, &batch, &mut metrics).await? {
            budget.append(&mut bodies, body);
            if budget.exhausted {
                break;
            }
        }
    }
    let mut errors: IndexMap<_, _> = bodies
        .iter()
        .filter_map(|body| {
            body.error
                .as_ref()
                .map(|error| (body.path.clone(), error.clone()))
        })
        .collect();
    errors.sort_by(|left, _, right, _| compare_object_keys(left, right));
    if let Some(route_metrics) = context.metrics {
        let mut route_metrics = route_metrics.borrow_mut();
        route_metrics.batch_count.get_or_insert(Number(0.0)).0 += metrics.batch_count as f64;
        route_metrics.bisection_count.get_or_insert(Number(0.0)).0 +=
            metrics.bisection_count as f64;
    }
    Ok(GitReviewDiffBatchResult {
        bodies,
        errors,
        metrics,
    })
}

pub(super) fn compare_object_keys(left: &str, right: &str) -> std::cmp::Ordering {
    garcon_js::js::array_index(left)
        .unwrap_or(u64::MAX)
        .cmp(&garcon_js::js::array_index(right).unwrap_or(u64::MAX))
}

pub fn loaded_git_review_body_totals<'a>(
    bodies: impl IntoIterator<Item = &'a GitReviewFilePatchBody>,
) -> GitReviewLoadedBodyTotals {
    let mut totals = GitReviewLoadedBodyTotals::default();
    for body in bodies
        .into_iter()
        .filter(|body| body.body_state == GitReviewBodyState::Loaded)
    {
        totals.loaded_rows.0 += body.rendered_row_count.0;
        totals.loaded_bytes.0 += body.patch_bytes.0;
    }
    totals
}

pub fn is_git_review_collection_limit_body(body: &GitReviewFilePatchBody) -> bool {
    matches!(
        body.limit_reason,
        Some(
            GitReviewLimitReason::CollectionTooManyRows
                | GitReviewLimitReason::CollectionTooManyBytes
        )
    )
}

pub fn limit_git_review_response_bodies(
    candidates: impl IntoIterator<Item = GitReviewFilePatchBody>,
) -> Vec<GitReviewFilePatchBody> {
    let mut bodies = Vec::new();
    let mut budget = ResponseBudget::new(GitReviewLoadedBodyTotals::default());
    for body in candidates {
        budget.append(&mut bodies, body);
        if budget.exhausted {
            break;
        }
    }
    bodies
}

fn english_grouped_number(number: f64) -> String {
    let text = match number {
        number if number.is_infinite() => {
            return if number.is_sign_negative() {
                "-\u{221e}"
            } else {
                "\u{221e}"
            }
            .into();
        }
        number if number.abs() >= 1e21 => format!("{number:.0}"),
        number => {
            let printed = number_to_string(number);
            if printed.contains('e')
                || printed
                    .split_once('.')
                    .is_some_and(|(_, tail)| tail.len() > 3)
            {
                let rounded = (number.abs() * 1000.0).round() / 1000.0;
                format!(
                    "{}{}",
                    if number.is_sign_negative() { "-" } else { "" },
                    number_to_string(rounded)
                )
            } else {
                printed
            }
        }
    };
    let (integer, decimal) = text
        .split_once('.')
        .map_or((text.as_str(), ""), |(integer, _)| {
            (integer, &text[integer.len()..])
        });
    let (sign, digits) = integer
        .strip_prefix('-')
        .map_or(("", integer), |digits| ("-", digits));
    if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return text;
    }
    let mut grouped = sign.to_owned();
    for (index, digit) in digits.bytes().enumerate() {
        if index != 0 && (digits.len() - index).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(char::from(digit));
    }
    grouped.push_str(decimal);
    grouped
}

impl ResponseBudget {
    fn new(totals: GitReviewLoadedBodyTotals) -> Self {
        Self {
            exhausted: totals.loaded_rows.0 >= GIT_REVIEW_DOCUMENT_LIMITS.max_loaded_rows as f64
                || totals.loaded_bytes.0
                    >= GIT_REVIEW_DOCUMENT_LIMITS.max_loaded_patch_bytes as f64,
            totals,
        }
    }

    fn append(&mut self, bodies: &mut Vec<GitReviewFilePatchBody>, body: GitReviewFilePatchBody) {
        use GitReviewLimitReason::{CollectionTooManyBytes, CollectionTooManyRows};
        if self.exhausted {
            return;
        }
        if is_git_review_collection_limit_body(&body) {
            self.exhausted = true;
            bodies.push(body);
        } else if body.body_state != GitReviewBodyState::Loaded {
            bodies.push(body);
        } else {
            let rows = self.totals.loaded_rows.0 + body.rendered_row_count.0;
            let bytes = self.totals.loaded_bytes.0 + body.patch_bytes.0;
            let reason = if rows > GIT_REVIEW_DOCUMENT_LIMITS.max_loaded_rows as f64 {
                Some(CollectionTooManyRows)
            } else if bytes > GIT_REVIEW_DOCUMENT_LIMITS.max_loaded_patch_bytes as f64 {
                Some(CollectionTooManyBytes)
            } else {
                None
            };
            if let Some(reason) = reason {
                bodies.push(self.limit_body(&body.path, &body.body_fingerprint, Some(reason)));
                self.exhausted = true;
            } else {
                bodies.push(body);
                self.totals = GitReviewLoadedBodyTotals {
                    loaded_rows: Number(rows),
                    loaded_bytes: Number(bytes),
                };
            }
        }
    }

    fn limit_body(
        &self,
        path: &str,
        fingerprint: &str,
        reason: Option<GitReviewLimitReason>,
    ) -> GitReviewFilePatchBody {
        use GitReviewLimitReason::{CollectionTooManyBytes, CollectionTooManyRows};
        let reason = reason.unwrap_or(
            if self.totals.loaded_rows.0 >= GIT_REVIEW_DOCUMENT_LIMITS.max_loaded_rows as f64 {
                CollectionTooManyRows
            } else {
                CollectionTooManyBytes
            },
        );
        let (amount, unit) = if reason == CollectionTooManyRows {
            (self.totals.loaded_rows.0, "rendered rows")
        } else {
            (self.totals.loaded_bytes.0, "patch bytes")
        };
        limited_patch_file_body(
            path,
            fingerprint,
            reason,
            format!(
                "Stopped loading after {} {unit}.",
                english_grouped_number(amount)
            ),
        )
    }
}
