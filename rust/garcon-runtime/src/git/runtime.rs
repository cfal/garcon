//! Ports the Git service boundary in server/runtime/git/runtime.ts.

use std::cell::{Cell, RefCell};
use std::io::{self, ErrorKind};
use std::rc::Rc;

use async_trait::async_trait;
use garcon_base::errors::ErrorInput;
use garcon_base::executor_path::{to_executor_path, to_native_path};
use garcon_base::log::{Logger, create_logger};
use garcon_base::path_boundary::{
    ProjectPathError, assert_real_within_base, resolve_real_within_base,
};
use garcon_base::unhandled_rejection_policy::{
    UnhandledRejectionPolicy, install_unhandled_rejection_policy,
};
use garcon_contract::git::GitMethod;
use garcon_contract::git_diagnostics::{
    GitCommandDiagnostics, GitOperationDiagnostics, GitReviewRouteMetrics,
};
use garcon_contract::git_error::{GitServiceError, GitServiceErrorCode as Code};
use garcon_contract::git_execution::{
    ExecutionGitResult, GIT_MAX_CONCURRENT_QUERIES, GitExecutorScope, is_git_mutation,
};
use garcon_contract::git_request_validation::validate_git_request;
use garcon_contract::git_result_validation::validate_git_result;
use garcon_interface::errors::{AgentCallError, AgentDeliveryOutcome};
use garcon_interface::resources::{ExecutorCallOptions, ExecutorResult};
use garcon_js::{Number, path::native};
use indexmap::{IndexMap, IndexSet};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::{fs, sync::oneshot, task::spawn_local, time::Instant};
use tokio_util::sync::CancellationToken;

use crate::ChildEnvironment;
use crate::cancellation::check_cancelled;

use super::git_error_classifier::classify_git_error;
use super::git_service::GitOperations;
use super::operation_context::{
    git_output_truncated, restrict_git_working_root, with_git_operation_with_environment,
};
use super::repository_coordination::with_repository_mutation;
use super::review_diff_batch::GitReviewDiffBatchContext;
use super::review_document_registry::GitReviewDocumentRegistry;
use super::run::{read_only_git_options, resolve_path_within_project, run_git};
use super::service_errors::git_service_error;
use super::types::{GitCommandOptions, GitCommandTrace};
use super::worktrees::ProjectPathAllowed;

pub type GitAvailabilityCheck = Rc<dyn Fn(Option<&ExecutorCallOptions>) -> ExecutorResult<()>>;

pub struct GitRuntimeOptions {
    pub scope: GitExecutorScope,
    pub project_base_path: String,
    pub child_environment: Option<ChildEnvironment>,
    pub review_registry: Option<Rc<GitReviewDocumentRegistry>>,
    pub assert_available: Option<GitAvailabilityCheck>,
}

struct GitPathBoundary {
    base: String,
}

fn path_error(error: ProjectPathError) -> Box<dyn std::error::Error> {
    match error {
        ProjectPathError::Io(error) => error.into(),
        boundary => boundary.into(),
    }
}

#[async_trait(?Send)]
impl ProjectPathAllowed for GitPathBoundary {
    async fn assert_project_path_allowed(&self, input: &str) -> ExecutorResult<String> {
        let mut candidate = to_native_path(input, None).into_owned();
        let mut tail = Vec::<String>::new();
        loop {
            match assert_real_within_base(&self.base, &candidate).await {
                Ok(mut resolved) => {
                    for segment in tail.iter().rev() {
                        resolved = native::join(&[&resolved, segment]);
                    }
                    return Ok(resolved);
                }
                Err(ProjectPathError::Io(error)) if error.kind() == ErrorKind::NotADirectory => {
                    let parent = native::dirname(&candidate);
                    if parent == candidate {
                        return Err(error.into());
                    }
                    tail.push(native::basename(&candidate));
                    candidate = parent;
                }
                Err(error) => return Err(path_error(error)),
            }
        }
    }
}

#[derive(Default)]
struct ProcessAdmission {
    reads: usize,
    mutations: usize,
    sequence: u64,
    holders: IndexMap<u64, AdmittedOperation>,
    last_refusal: IndexSet<u64>,
}

struct AdmittedOperation {
    method: String,
    started: Instant,
    signal: CancellationToken,
}

thread_local! {
    static PROCESS: RefCell<ProcessAdmission> = RefCell::default();
}

impl ProcessAdmission {
    fn report_refusal(&mut self, method: &str) {
        if self.holders.len() == self.last_refusal.len()
            && self
                .holders
                .keys()
                .all(|key| self.last_refusal.contains(key))
        {
            return;
        }
        self.last_refusal = self.holders.keys().copied().collect();
        let admitted: Vec<_> = self
            .holders
            .values()
            .map(|holder| {
                json!({
                    "method": holder.method,
                    "ageMs": (holder.started.elapsed().as_secs_f64() * 1000.0).round() as u64,
                    "aborted": holder.signal.is_cancelled(),
                })
            })
            .collect();
        create_logger("git:runtime").warn(&format!(
            "Git operation capacity is exhausted {}",
            json!({"method": method, "reads": self.reads, "mutations": self.mutations, "admitted": admitted}),
        ));
    }
}

struct Admission {
    id: u64,
    mutation: bool,
    runtime: Rc<GitRuntimeState>,
}

impl Drop for Admission {
    fn drop(&mut self) {
        let count = self.runtime.admitted_count(self.mutation);
        count.set(count.get() - 1);
        PROCESS.with_borrow_mut(|process| {
            if self.mutation {
                process.mutations -= 1;
            } else {
                process.reads -= 1;
            }
            process.holders.shift_remove(&self.id);
        });
    }
}

pub struct GitRuntime {
    state: Rc<GitRuntimeState>,
}

struct GitRuntimeState {
    configuration: GitRuntimeOptions,
    boundary: Rc<GitPathBoundary>,
    abort: CancellationToken,
    reads: Cell<usize>,
    mutations: Cell<usize>,
    operations: GitOperations,
    unhandled: UnhandledRejectionPolicy,
}

impl GitRuntime {
    pub fn new(configuration: GitRuntimeOptions) -> Self {
        let boundary = Rc::new(GitPathBoundary {
            base: to_native_path(&configuration.project_base_path, None).into_owned(),
        });
        let operations =
            GitOperations::new(configuration.review_registry.clone(), boundary.clone());
        Self {
            state: Rc::new(GitRuntimeState {
                configuration,
                boundary,
                abort: CancellationToken::new(),
                reads: Cell::new(0),
                mutations: Cell::new(0),
                operations,
                unhandled: install_unhandled_rejection_policy(Rc::new(create_logger(
                    "git:runtime",
                ))),
            }),
        }
    }

    pub fn dispose(&self) {
        self.state.abort.cancel();
    }

    pub(super) async fn invoke<Q, R>(
        &self,
        method: GitMethod,
        request: Q,
        options: Option<ExecutorCallOptions>,
        fallback: Option<fn(&str) -> R>,
        operation: impl for<'run> AsyncFnOnce(
            &'run GitOperations,
            Q,
            &'run GitReviewDiffBatchContext<'run>,
        ) -> ExecutorResult<R>
        + 'static,
    ) -> ExecutorResult<ExecutionGitResult<R>>
    where
        Q: Serialize + DeserializeOwned,
        R: Serialize + DeserializeOwned + 'static,
    {
        let input = wire_value(&request)?;
        validate_git_request(method, &input)?;
        // The validator requires a string projectPath before dispatch.
        let requested_path = input["projectPath"].as_str().unwrap_or_default().to_owned();
        let mutation = is_git_mutation(method);
        let state = self.state.clone();
        let signal = state.abort.child_token();
        let admission = match state
            .available(options.as_ref())
            .and_then(|()| state.take_admission(method.as_str(), mutation, signal.clone()))
        {
            Ok(admission) => admission,
            Err(error) => return state.finish(Err(error), &requested_path, fallback),
        };
        let (sender, receiver) = oneshot::channel();
        // The reply does not own the operation: a disconnected caller cannot unlock
        // a repository or free capacity while its Git subprocesses are still running.
        spawn_local(async move {
            let result = state
                .run(method, input, &requested_path, options, signal, operation)
                .await;
            drop(admission);
            if let Err(Err(error)) = sender.send(state.finish(result, &requested_path, fallback)) {
                state.unhandled.report(ErrorInput::Error(error.as_ref()));
            }
        });
        receiver.await?
    }
}

impl GitRuntimeState {
    fn available(&self, options: Option<&ExecutorCallOptions>) -> ExecutorResult<()> {
        check_cancelled(options.and_then(|options| options.signal.as_ref()))?;
        if self.abort.is_cancelled() {
            return Err(AgentCallError::new(
                AgentDeliveryOutcome::NotDispatched,
                "Git serving instance retired",
            )
            .into());
        }
        if let Some(callback) = &self.configuration.assert_available {
            callback(options)?;
        }
        Ok(())
    }

    fn admitted_count(&self, mutation: bool) -> &Cell<usize> {
        if mutation {
            &self.mutations
        } else {
            &self.reads
        }
    }

    fn take_admission(
        self: &Rc<Self>,
        method: &str,
        mutation: bool,
        signal: CancellationToken,
    ) -> ExecutorResult<Admission> {
        PROCESS.with_borrow_mut(|process| {
            let instance = self.admitted_count(mutation);
            let full = if mutation {
                instance.get() >= 8 || process.mutations >= 16
            } else {
                instance.get() >= GIT_MAX_CONCURRENT_QUERIES
                    || process.reads >= GIT_MAX_CONCURRENT_QUERIES
            };
            if full {
                process.report_refusal(method);
                return Err(GitServiceError::new(
                    Code::GIT_SERVICE_BUSY,
                    "Git operation capacity is exhausted",
                )
                .into());
            }
            instance.set(instance.get() + 1);
            if mutation {
                process.mutations += 1;
            } else {
                process.reads += 1;
            }
            process.sequence += 1;
            let id = process.sequence;
            process.holders.insert(
                id,
                AdmittedOperation {
                    method: method.into(),
                    started: Instant::now(),
                    signal,
                },
            );
            Ok(Admission {
                id,
                mutation,
                runtime: self.clone(),
            })
        })
    }

    async fn run_scoped<R>(
        &self,
        mutation: bool,
        options: Option<ExecutorCallOptions>,
        signal: CancellationToken,
        execute: impl AsyncFnOnce(ExecutorCallOptions) -> ExecutorResult<R>,
    ) -> ExecutorResult<R> {
        let mut options = options.unwrap_or_default();
        let caller = options.signal.take();
        options.signal = Some(signal.clone());
        let pending = with_git_operation_with_environment(
            &self.boundary.base,
            Some(options.clone()),
            mutation,
            self.configuration.child_environment.clone(),
            |operation_signal| {
                execute(ExecutorCallOptions {
                    signal: Some(operation_signal),
                    ..options
                })
            },
        );
        tokio::pin!(pending);
        if let Some(caller) = caller {
            tokio::select! {
                biased;
                () = caller.cancelled() => {
                    signal.cancel();
                    pending.await
                }
                result = &mut pending => result,
            }
        } else {
            pending.await
        }
    }

    async fn repository(
        &self,
        path: &str,
        options: &ExecutorCallOptions,
    ) -> ExecutorResult<String> {
        self.available(Some(options))?;
        let project = match self.boundary.assert_project_path_allowed(path).await {
            Err(error)
                if error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|error| error.kind() == ErrorKind::NotFound) =>
            {
                return Err(not_repo("Git project directory is unavailable"));
            }
            result => result?,
        };
        match fs::metadata(&project).await {
            Ok(meta) if meta.is_dir() => (),
            Ok(_) => return Err(not_repo("Git project must be a directory")),
            Err(error)
                if matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) =>
            {
                return Err(not_repo("Git project directory is unavailable"));
            }
            Err(_) => {
                return Err(GitServiceError::new(
                    Code::GIT_INVALID_INPUT,
                    "Git project directory is inaccessible",
                )
                .into());
            }
        }
        restrict_git_working_root(project.clone());
        match run_git(
            &project,
            vec!["rev-parse".into(), "--show-toplevel".into()],
            read_only_git_options(GitCommandOptions {
                signal: options.signal.clone(),
                ..Default::default()
            }),
        )
        .await
        {
            Ok(result) => {
                let stdout = result
                    .stdout
                    .strip_suffix('\n')
                    .map_or(result.stdout.as_str(), |line| {
                        line.strip_suffix('\r').unwrap_or(line)
                    });
                let root = self.boundary.assert_project_path_allowed(stdout).await?;
                restrict_git_working_root(root);
            }
            Err(error)
                if classify_git_error(ErrorInput::Error(error.as_ref())).code == "NOT_REPO" => {}
            Err(error) => return Err(error),
        }
        Ok(project)
    }

    async fn run<Q, R>(
        &self,
        method: GitMethod,
        mut input: Value,
        requested_path: &str,
        options: Option<ExecutorCallOptions>,
        signal: CancellationToken,
        operation: impl for<'run> AsyncFnOnce(
            &'run GitOperations,
            Q,
            &'run GitReviewDiffBatchContext<'run>,
        ) -> ExecutorResult<R>,
    ) -> ExecutorResult<ExecutionGitResult<R>>
    where
        Q: DeserializeOwned,
        R: Serialize + DeserializeOwned,
    {
        let mutation = is_git_mutation(method);
        let scoped = async |options: ExecutorCallOptions| {
            let project = self.repository(requested_path, &options).await?;
            let execute = || async {
                self.available(Some(&options))?;
                if mutation && self.repository(requested_path, &options).await? != project {
                    return Err(GitServiceError::new(
                        Code::GIT_INVALID_INPUT,
                        "Repository path changed",
                    )
                    .into());
                }
                if let Some(document) = input.get("document") {
                    let scope = &self.configuration.scope;
                    if document["executorId"].as_str() != Some(&scope.executor_id)
                        || document["instanceId"].as_str() != Some(&scope.instance_id)
                    {
                        return Err(GitServiceError::new(
                            Code::GIT_STALE_DOCUMENT,
                            "Git review belongs to a different executor or serving instance",
                        )
                        .into());
                    }
                }
                if let Some(path) = input.get("worktreePath").and_then(Value::as_str) {
                    let resolved = native::resolve(&project, &[&to_native_path(path, None)]);
                    input["worktreePath"] =
                        Value::String(self.boundary.assert_project_path_allowed(&resolved).await?);
                }
                validate_files(method, &input, &project).await?;
                input["projectPath"] = Value::String(project.clone());
                let typed = serde_json::from_value(input)?;
                let trace = RefCell::new(Vec::<GitCommandTrace>::new());
                let metrics = RefCell::new(GitReviewRouteMetrics {
                    phases: Vec::new(),
                    file_count: None,
                    row_count: None,
                    cache_hits: None,
                    batch_count: None,
                    bisection_count: None,
                });
                let called = operation(
                    &self.operations,
                    typed,
                    &GitReviewDiffBatchContext {
                        trace: Some(&trace),
                        metrics: Some(&metrics),
                        signal: options.signal.as_ref(),
                        temporary_index: &self.operations.temporary_index,
                    },
                )
                .await?;
                let result = if cfg!(windows) {
                    let mut value = wire_value(&called)?;
                    portable_result(&mut value);
                    serde_json::from_value(value)?
                } else {
                    called
                };
                let response = ExecutionGitResult {
                    result,
                    scope: self.configuration.scope.clone(),
                    diagnostics: Some(diagnostics(metrics.into_inner(), trace.into_inner())),
                    output_truncated: (mutation && git_output_truncated()).then_some(true),
                };
                if let Err(error) =
                    validate_git_result(method, &wire_value(&response)?, &self.configuration.scope)
                {
                    if mutation {
                        return Err(GitServiceError::new(
                            Code::GIT_MUTATION_OUTCOME_UNKNOWN,
                            "Git mutation could not be confirmed. Inspect the repository before trying again.",
                        ).into());
                    }
                    return Err(error.into());
                }
                Ok(response)
            };
            if mutation {
                with_repository_mutation(&project, execute).await
            } else {
                execute().await
            }
        };
        self.run_scoped(mutation, options, signal, scoped).await
    }

    fn finish<R>(
        &self,
        result: ExecutorResult<ExecutionGitResult<R>>,
        requested_path: &str,
        fallback: Option<fn(&str) -> R>,
    ) -> ExecutorResult<ExecutionGitResult<R>> {
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                let error = git_service_error(error);
                if let Some(fallback) = fallback
                    && error
                        .downcast_ref::<GitServiceError>()
                        .is_some_and(|error| error.code == Code::GIT_NOT_REPO)
                {
                    return Ok(ExecutionGitResult {
                        result: fallback(requested_path),
                        scope: self.configuration.scope.clone(),
                        diagnostics: None,
                        output_truncated: None,
                    });
                }
                Err(error)
            }
        }
    }
}

fn wire_value(value: &impl Serialize) -> serde_json::Result<Value> {
    garcon_js::json::from_slice(&serde_json::to_vec(value)?)
}

fn not_repo(message: &str) -> Box<dyn std::error::Error> {
    GitServiceError::new(Code::GIT_NOT_REPO, message).into()
}

fn diagnostics(
    mut metrics: GitReviewRouteMetrics,
    trace: Vec<GitCommandTrace>,
) -> GitOperationDiagnostics {
    metrics.phases.truncate(128);
    GitOperationDiagnostics {
        metrics,
        commands: trace
            .into_iter()
            .take(128)
            .map(|command| GitCommandDiagnostics {
                command: command.args.into_iter().next().unwrap_or_default(),
                duration_ms: Number(command.duration_ms as f64),
                stdout_bytes: Number(command.stdout_bytes as f64),
                stderr_bytes: Number(command.stderr_bytes as f64),
            })
            .collect(),
    }
}

async fn validate_files(method: GitMethod, request: &Value, project: &str) -> ExecutorResult<()> {
    use GitMethod::*;
    let files: Vec<_> = if let Some(file) = request["file"].as_str() {
        vec![file]
    } else if let Some(paths) = request["paths"]
        .as_array()
        .or_else(|| request["files"].as_array())
    {
        paths.iter().filter_map(Value::as_str).collect()
    } else {
        request["selectedFile"]
            .as_str()
            .filter(|file| !file.is_empty())
            .into_iter()
            .collect()
    };
    let lexical_only = matches!(
        method,
        GetFileHistory | GetBlame | GetReviewDocumentFileBodies | GetWorkbenchSnapshot
    ) || request["mode"] == "unstage";
    let contain_file = matches!(
        method,
        GetConflictDetails | MarkConflictResolved | AcceptConflictSide | DeleteUntracked
    );
    for file in files {
        let resolved = resolve_path_within_project(project, &to_native_path(file, None))?;
        if !lexical_only {
            let boundary = if contain_file || resolved == project {
                resolved
            } else {
                native::dirname(&resolved)
            };
            resolve_real_within_base(project, &boundary)
                .await
                .map_err(path_error)?;
        }
    }
    Ok(())
}

fn portable_result(result: &mut Value) {
    fn convert(value: &mut Value, keys: &[&str]) {
        if let Some(fields) = value.as_object_mut() {
            for key in keys {
                if let Some(value) = fields.get_mut(*key)
                    && let Some(path) = value.as_str()
                {
                    *value = Value::String(to_executor_path(path, None));
                }
            }
        }
    }
    convert(
        result,
        &["project", "repoRoot", "currentWorktreePath", "worktreePath"],
    );
    if let Some(target) = result.get_mut("target") {
        convert(target, &["projectPath", "repoRoot", "worktreePath"]);
    }
    if let Some(summary) = result.get_mut("reviewSummary") {
        convert(summary, &["project"]);
    }
    if let Some(worktrees) = result.get_mut("worktrees").and_then(Value::as_array_mut) {
        for worktree in worktrees {
            convert(worktree, &["path"]);
        }
    }
    if let Some(targets) = result.get_mut("targets").and_then(Value::as_array_mut) {
        for target in targets {
            convert(target, &["projectPath", "repoRoot", "worktreePath"]);
        }
    }
}
