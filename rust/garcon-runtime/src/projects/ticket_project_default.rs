//! Ports `server/runtime/projects/ticket-project-default.ts`.

use std::ffi::OsString;
use std::ops::AsyncFn;
use std::time::Duration;

use garcon_base::ticket_error::{TicketDomainError, validate_ticket_input};
use garcon_contract::error_codes::ErrorCode;
use garcon_contract::project_resolution::ProjectResolution;
use garcon_contract::ticket_validation::{TicketValidationError, ticket_project, ticket_string};
use garcon_contract::tickets::{TicketErrorCode, TicketProjectDefault, TicketProjectKind};
use garcon_interface::resources::ExecutorResult;
use garcon_js::path::native;
use serde_json::Value;
use tokio::time::{Instant, sleep_until};
use tokio_util::sync::CancellationToken;

use crate::files::errors::check_cancelled;
use crate::git::run::{read_only_git_options, run_git};
use crate::git::types::{GitCommandOptions, GitCommandResult, GitProcessError};

const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_LIMIT: usize = 1024 * 1024;

fn unavailable() -> TicketDomainError {
    // INFALLIBLE: the shared registry defines TICKET_PROJECT_UNAVAILABLE.
    let code = TicketErrorCode::try_from(ErrorCode::TICKET_PROJECT_UNAVAILABLE)
        .expect("registered ticket code");
    TicketDomainError::new(
        code,
        "Cannot resolve the project default. Check the context directory, or enter an explicit project.",
        None,
        None,
    )
}

fn validated_project(path: &str) -> Result<String, TicketValidationError> {
    ticket_project(&Value::String(path.to_owned())).map(str::to_owned)
}

fn absolute_project(path: &str) -> ExecutorResult<&str> {
    if !native::is_absolute(path) {
        return Err(unavailable().into());
    }
    validated_project(path)?;
    Ok(path)
}

fn single_path(output: &str) -> ExecutorResult<&str> {
    absolute_project(output.strip_suffix('\n').ok_or_else(unavailable)?)
}

fn primary_checkout(output: &str) -> ExecutorResult<&str> {
    if !output.ends_with("\0\0") {
        return Err(unavailable().into());
    }
    let (first, _) = output.split_once("\0\0").ok_or_else(unavailable)?;
    let mut fields = first.split('\0');
    let path = fields
        .next()
        .and_then(|field| field.strip_prefix("worktree "))
        .ok_or_else(unavailable)?;
    if !fields.any(|field| field.starts_with("HEAD ")) {
        return Err(unavailable().into());
    }
    absolute_project(path)
}

async fn canonical(
    path: &str,
    signal: &CancellationToken,
    inspect: &impl AsyncFn(&str) -> ExecutorResult<ProjectResolution>,
) -> ExecutorResult<String> {
    check_cancelled(Some(signal))?;
    validated_project(path)?;
    let result = inspect(path).await?;
    check_cancelled(Some(signal))?;
    let ProjectResolution::Available {
        effective_project_key,
    } = result
    else {
        return Err(unavailable().into());
    };
    if validated_project(&effective_project_key)? != effective_project_key {
        return Err(unavailable().into());
    }
    Ok(effective_project_key)
}

struct Probe<'a, G> {
    signal: &'a CancellationToken,
    deadline: Instant,
    git: G,
}

impl<G: AsyncFn(&str, Vec<String>, GitCommandOptions) -> ExecutorResult<GitCommandResult>>
    Probe<'_, G>
{
    async fn run(&self, cwd: &str, args: &[&str]) -> ExecutorResult<String> {
        check_cancelled(Some(self.signal))?;
        let remaining = self
            .deadline
            .saturating_duration_since(Instant::now())
            .as_secs_f64()
            * 1000.0;
        let options = read_only_git_options(GitCommandOptions {
            signal: Some(self.signal.clone()),
            timeout_ms: Some(remaining.max(1.0)),
            max_stdout_bytes: Some(PROBE_LIMIT),
            max_stderr_bytes: Some(PROBE_LIMIT),
            env: Some(
                [
                    ("LC_ALL", Some("C")),
                    ("GIT_DIR", None),
                    ("GIT_COMMON_DIR", None),
                    ("GIT_WORK_TREE", None),
                    ("GIT_INDEX_FILE", None),
                    ("GIT_CEILING_DIRECTORIES", None),
                ]
                .into_iter()
                .map(|(key, value)| (OsString::from(key), value.map(OsString::from)))
                .collect(),
            ),
            ..Default::default()
        });
        let output = (self.git)(
            cwd,
            args.iter().map(|arg| (*arg).to_owned()).collect(),
            options,
        )
        .await?;
        check_cancelled(Some(self.signal))?;
        Ok(output.stdout)
    }
}

fn config_not_set(error: &(dyn std::error::Error + 'static)) -> bool {
    error
        .downcast_ref::<GitProcessError>()
        .is_some_and(|error| {
            error.code == Some(1)
                && error.stdout.is_empty()
                && error.stderr.is_empty()
                && error.aborted != Some(true)
                && error.timed_out != Some(true)
        })
}

async fn repository_default(
    cwd: &str,
    inspect: &impl AsyncFn(&str) -> ExecutorResult<ProjectResolution>,
    probe: &Probe<
        '_,
        impl AsyncFn(&str, Vec<String>, GitCommandOptions) -> ExecutorResult<GitCommandResult>,
    >,
) -> ExecutorResult<String> {
    let output = probe
        .run(
            cwd,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        )
        .await?;
    let common_directory = canonical(single_path(&output)?, probe.signal, inspect).await?;
    let main_git_dir = format!("--git-dir={common_directory}");
    match probe
        .run(cwd, &[&main_git_dir, "rev-parse", "--is-bare-repository"])
        .await?
        .as_str()
    {
        "true\n" => return Ok(validated_project(&native::basename(&common_directory))?),
        "false\n" => {}
        _ => return Err(unavailable().into()),
    }

    let checkout = match probe
        .run(
            cwd,
            &[
                &main_git_dir,
                "config",
                "--null",
                "--path",
                "--get",
                "core.worktree",
            ],
        )
        .await
    {
        Ok(config) => {
            let path = config
                .strip_suffix('\0')
                .filter(|path| !path.contains('\0'))
                .ok_or_else(unavailable)?;
            native::resolve(cwd, &[&common_directory, path])
        }
        Err(error) if config_not_set(error.as_ref()) => {
            let output = probe
                .run(cwd, &["worktree", "list", "--porcelain", "-z"])
                .await?;
            let checkout = primary_checkout(&output)?;
            if checkout == common_directory {
                return Err(unavailable().into());
            }
            checkout.to_owned()
        }
        Err(error) => return Err(error),
    };
    let checkout = canonical(&checkout, probe.signal, inspect).await?;
    Ok(validated_project(&native::basename(&checkout))?)
}

pub async fn resolve_ticket_project_default(
    directory: &str,
    signal: Option<&CancellationToken>,
    inspect: impl AsyncFn(&str) -> ExecutorResult<ProjectResolution>,
) -> ExecutorResult<TicketProjectDefault> {
    resolve_with_git(
        directory,
        signal,
        inspect,
        async |cwd: &str, args, options| run_git(cwd, args, options).await,
    )
    .await
}

async fn resolve_with_git(
    directory: &str,
    signal: Option<&CancellationToken>,
    inspect: impl AsyncFn(&str) -> ExecutorResult<ProjectResolution>,
    git: impl AsyncFn(&str, Vec<String>, GitCommandOptions) -> ExecutorResult<GitCommandResult>,
) -> ExecutorResult<TicketProjectDefault> {
    validate_ticket_input(|| {
        ticket_string(&Value::String(directory.to_owned()), "directory").map(|_| ())
    })?;
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let probe_signal = signal.map_or_else(CancellationToken::new, CancellationToken::child_token);
    let resolving = async {
        let cwd = match canonical(directory, &probe_signal, &inspect).await {
            Ok(cwd) => cwd,
            Err(_) => {
                check_cancelled(signal)?;
                return Err(unavailable().into());
            }
        };
        let probe = Probe {
            signal: &probe_signal,
            deadline,
            git,
        };
        match repository_default(&cwd, &inspect, &probe).await {
            Ok(project) => Ok(TicketProjectDefault {
                project,
                kind: TicketProjectKind::Repository,
            }),
            Err(_) => {
                check_cancelled(signal)?;
                let name = native::basename(&cwd);
                if name.is_empty() {
                    return Err(unavailable().into());
                }
                Ok(TicketProjectDefault {
                    project: validated_project(&name)?,
                    kind: TicketProjectKind::Folder,
                })
            }
        }
    };
    tokio::pin!(resolving);
    tokio::select! {
        result = &mut resolving => result,
        () = sleep_until(deadline) => {
            probe_signal.cancel();
            resolving.await
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;

    fn root() -> &'static str {
        if cfg!(windows) {
            r"C:\context"
        } else {
            "/context"
        }
    }

    async fn inspect(path: &str) -> ExecutorResult<ProjectResolution> {
        Ok(ProjectResolution::Available {
            effective_project_key: path.to_owned(),
        })
    }

    #[tokio::test]
    async fn ticket_default_falls_back_on_malformed_checkout_after_bounded_read_only_probes() {
        let calls = RefCell::new(Vec::new());
        let resolved = resolve_with_git(
            root(),
            None,
            inspect,
            async |cwd: &str, args: Vec<String>, options: GitCommandOptions| {
                assert_eq!(cwd, root());
                assert!(options.disable_optional_locks);
                assert_eq!(options.max_stdout_bytes, Some(PROBE_LIMIT));
                assert_eq!(options.max_stderr_bytes, Some(PROBE_LIMIT));
                let env = options.env.unwrap();
                assert_eq!(env[&OsString::from("LC_ALL")], Some("C".into()));
                for key in [
                    "GIT_DIR",
                    "GIT_COMMON_DIR",
                    "GIT_WORK_TREE",
                    "GIT_INDEX_FILE",
                    "GIT_CEILING_DIRECTORIES",
                ] {
                    assert_eq!(env[&OsString::from(key)], None);
                }
                let timeout = options.timeout_ms.unwrap();
                assert!((1.0..=5000.0).contains(&timeout));
                calls.borrow_mut().push(timeout);
                let stdout = if args.iter().any(|arg| arg == "--git-common-dir") {
                    format!("{}\n", root())
                } else if args.iter().any(|arg| arg == "--is-bare-repository") {
                    "false\n".to_owned()
                } else if args.iter().any(|arg| arg == "config") {
                    return Err(GitProcessError {
                        message: "git --git-dir failed (exit 1): exit 1".to_owned(),
                        code: Some(1),
                        stdout: String::new(),
                        stderr: String::new(),
                        aborted: Some(false),
                        timed_out: Some(false),
                    }
                    .into());
                } else {
                    assert_eq!(args, ["worktree", "list", "--porcelain", "-z"]);
                    format!("worktree {}\nHEAD abc\n", root())
                };
                Ok(GitCommandResult {
                    stdout,
                    stderr: String::new(),
                })
            },
        )
        .await
        .unwrap();
        let calls = calls.into_inner();
        assert_eq!(calls.len(), 4);
        assert!(calls.windows(2).all(|pair| pair[0] >= pair[1]));
        assert_eq!(
            resolved,
            TicketProjectDefault {
                project: "context".to_owned(),
                kind: TicketProjectKind::Folder
            }
        );
    }

    #[tokio::test]
    async fn ticket_default_does_not_trim_canonical_names_and_honors_caller_cancellation() {
        let called = Cell::new(false);
        let spaced = format!("{}\u{a0}", root());
        let failed = resolve_with_git(&spaced, None, inspect, async |_: &str, _, _| {
            called.set(true);
            Err("Unexpected Git probe".into())
        })
        .await
        .unwrap_err();
        assert!(!called.get());
        let failed = failed.downcast_ref::<TicketDomainError>().unwrap();
        assert_eq!(
            ErrorCode::from(failed.code),
            ErrorCode::TICKET_PROJECT_UNAVAILABLE
        );
        assert!(!failed.message.contains(&spaced));

        let signal = CancellationToken::new();
        let aborted = resolve_with_git(root(), Some(&signal), inspect, async |_: &str, _, _| {
            signal.cancel();
            Ok(GitCommandResult {
                stdout: format!("{}\n", root()),
                stderr: String::new(),
            })
        })
        .await
        .unwrap_err();
        assert!(aborted.is::<crate::files::errors::AbortError>());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn typescript_and_rust_resolve_ticket_defaults_on_the_same_repositories() {
        use std::os::unix::fs::symlink;
        use std::path::Path;
        use std::rc::Rc;

        use garcon_interface::execution_runtime::{
            ExecutionProjectService, TicketProjectDefaultRequest,
        };
        use serde_json::json;
        use tokio::fs;
        use tokio::process::Command;
        use tokio::task::LocalSet;

        use crate::projects::project_service::ProjectService;

        async fn git(cwd: &Path, args: &[&str]) {
            let result = Command::new("git")
                .args([
                    "-c",
                    "user.name=Synthetic Author",
                    "-c",
                    "user.email=author@example.invalid",
                ])
                .args(args)
                .current_dir(cwd)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .kill_on_drop(true)
                .output()
                .await
                .unwrap();
            assert!(
                result.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }

        LocalSet::new()
            .run_until(async {
                let scratch = std::env::home_dir().unwrap().join("tmp/link");
                fs::create_dir_all(&scratch).await.unwrap();
                let temp = tempfile::tempdir_in(scratch).unwrap();
                let root = fs::canonicalize(temp.path()).await.unwrap();
                let linked = root.join("linked");
                let primary = root.join("primary");
                fs::create_dir(&primary).await.unwrap();
                git(&primary, &["init", "--quiet", "--template="]).await;
                git(
                    &primary,
                    &["commit", "--quiet", "--allow-empty", "-m", "Synthetic seed"],
                )
                .await;
                git(
                    &primary,
                    &[
                        "worktree",
                        "add",
                        "--quiet",
                        "-b",
                        "linked-branch",
                        linked.to_str().unwrap(),
                    ],
                )
                .await;
                fs::create_dir(linked.join("nested")).await.unwrap();
                symlink("linked/nested", root.join("linked-alias")).unwrap();

                let separate = root.join("separate");
                let gitdir = format!("--separate-git-dir={}", root.join("metadata").display());
                fs::create_dir(&separate).await.unwrap();
                git(&separate, &["init", "--quiet", "--template=", &gitdir]).await;
                git(&separate, &["config", "core.worktree", "../separate"]).await;
                git(
                    &separate,
                    &["commit", "--quiet", "--allow-empty", "-m", "Synthetic seed"],
                )
                .await;
                git(&root, &["init", "--quiet", "--template=", "--bare", "bare"]).await;
                let plain = root.join("plain");
                fs::create_dir(&plain).await.unwrap();
                fs::write(plain.join(".git"), "gitdir: absent\n")
                    .await
                    .unwrap();
                fs::create_dir(root.join("primary ")).await.unwrap();

                let paths = [
                    "primary",
                    "linked",
                    "linked-alias",
                    "separate",
                    "bare",
                    "plain",
                    "missing",
                    "primary ",
                ];
                let input = root.join("ticket-requests.json");
                fs::write(&input, serde_json::to_vec(&paths).unwrap())
                    .await
                    .unwrap();
                let mut peer = Command::new("bun");
                peer.arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/oracles/files-peer.ts"
                ))
                .arg(&root)
                .arg("ticket-defaults")
                .arg(input)
                .kill_on_drop(true);
                let output = tokio::time::timeout(Duration::from_secs(20), peer.output())
                    .await
                    .unwrap()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let original: Vec<Value> = garcon_js::json::from_slice(&output.stdout).unwrap();
                assert_eq!(original.len(), paths.len());
                let service =
                    ProjectService::new(root.to_str().unwrap(), Rc::new(|_| Ok(()))).unwrap();
                for (project_path, expected) in paths.into_iter().zip(&original) {
                    let outcome = service
                        .ticket_project_default(
                            TicketProjectDefaultRequest {
                                project_path: project_path.to_owned(),
                            },
                            None,
                        )
                        .await;
                    let actual = match outcome {
                        Ok(result) => json!({ "ok": result }),
                        Err(error) => {
                            let error = error.downcast_ref::<TicketDomainError>().unwrap();
                            json!({"error": {
                                "code": ErrorCode::from(error.code).as_str(),
                                "message": error.message,
                                "status": error.status,
                                "retryable": error.retryable,
                            }})
                        }
                    };
                    assert_eq!(&actual, expected, "ticket default for {project_path:?}");
                }
                assert_eq!(
                    original[2]["ok"],
                    json!({"project":"primary", "kind":"repository"})
                );
                assert_eq!(
                    original[3]["ok"],
                    json!({"project":"separate", "kind":"repository"})
                );
                assert_eq!(
                    original[4]["ok"],
                    json!({"project":"bare", "kind":"repository"})
                );
                assert_eq!(
                    original[5]["ok"],
                    json!({"project":"plain", "kind":"folder"})
                );
                assert_eq!(original[7]["error"]["code"], "TICKET_PROJECT_UNAVAILABLE");
            })
            .await;
    }
}
