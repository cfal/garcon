#![cfg(unix)]

use std::{
    cell::{Cell, RefCell},
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    rc::Rc,
    time::Duration,
};

use futures::FutureExt;
use garcon_agents_common::cli_update::{
    bounded_command::{BoundedCommandOptions, run_bounded_command},
    cli_probe::find_executable,
    cli_update_service::{
        CliUpdateService, CliUpdateServiceOptions, CliUpdateTarget, NativeReleaseSource,
    },
    install_resolution::{
        CliInstallContext, CliInstallDefinition, LatestVersionSource, NativeCliInstaller,
        resolve_cli_installation,
    },
    installer_environment::Environment,
};
use garcon_contract::agent_cli_update::{
    AgentCliInstallMethod as Method, AgentCliUpdateRunState as State, AgentCliUpdateStatus,
    AgentCliVersionAdvisory as Advisory, parse_agent_cli_update_status,
};
use garcon_interface::{
    cli_updates::{AgentCliUpdateStatusRequest, AgentCliUpdates},
    errors::{AgentIntegrationError, AgentIntegrationErrorCode},
    host::AgentLogger,
};
use garcon_js::{clock::ManualClock, json::Opaque};
use indexmap::IndexMap;
use tempfile::{TempDir, tempdir};
use tokio::{
    task::LocalSet,
    time::{sleep, timeout},
};

const PACKAGE: &str = "@anthropic-ai/claude-code";
const BEFORE: &str = "2.1.238";
const AFTER: &str = "2.1.300";
const TIMESTAMP: &str = "2026-11-20T00:00:00.000Z";

fn pathstr(path: &Path) -> &str {
    path.to_str().unwrap()
}
fn quoted(path: &Path) -> String {
    format!("'{}'", pathstr(path).replace('\'', "'\\''"))
}

fn script(path: &Path, body: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

fn link(real: &Path, launcher: &Path) {
    fs::create_dir_all(launcher.parent().unwrap()).unwrap();
    symlink(real, launcher).unwrap();
}

struct Fixture {
    root: TempDir,
    launcher: PathBuf,
    real: PathBuf,
    version: PathBuf,
    env: Environment,
    updated: Rc<Cell<u32>>,
}

impl Fixture {
    fn new() -> Self {
        let root = tempdir().unwrap();
        let tools = root.path().join("tools");
        fs::create_dir(&tools).unwrap();
        for command in ["cat", "seq", "sleep", "touch"] {
            symlink(Path::new("/usr/bin").join(command), tools.join(command)).unwrap();
        }
        let prefix = root.path().join("npm-prefix");
        let package = prefix.join("lib/node_modules").join(PACKAGE);
        let real = package.join("cli.sh");
        let version = package.join("VERSION");
        script(&real, &format!("cat {}", quoted(&version)));
        fs::write(&version, format!("{BEFORE} (Synthetic CLI)\n")).unwrap();
        let launcher = prefix.join("bin/claude");
        link(&real, &launcher);
        let env = Environment::from([
            ("PATH".into(), pathstr(&tools).into()),
            ("HOME".into(), pathstr(root.path()).into()),
        ]);
        Self {
            root,
            launcher,
            real,
            version,
            env,
            updated: Rc::new(Cell::new(0)),
        }
    }

    fn at(&self, relative: &str) -> PathBuf {
        self.root.path().join(relative)
    }

    fn npm(&self, latest: &str, install: &str) {
        script(
            &self.at("tools/npm"),
            &format!(
                "echo \"$@\" >> {}\ncase \"$1\" in\nview) echo '\"{latest}\"' ;;\ninstall) {install} ;;\nesac",
                quoted(&self.at("npm.log")),
            ),
        );
    }

    fn install(&self, after: &str) -> String {
        format!(
            "echo 'added 1 package'; printf '%s\\n' '{after} (Synthetic CLI)' > {}",
            quoted(&self.version)
        )
    }

    fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.at("npm.log"))
            .unwrap_or_default()
            .lines()
            .map(str::to_owned)
            .collect()
    }

    fn command(&self) -> String {
        format!(
            "npm install -g --prefix {} --allow-scripts={PACKAGE} {PACKAGE}@latest",
            self.at("npm-prefix").display()
        )
    }

    fn service(&self) -> CliUpdateService {
        self.service_for(pathstr(&self.launcher), false)
    }

    fn service_for(&self, command: &str, bundled: bool) -> CliUpdateService {
        let command = command.to_owned();
        let env = self.env.clone();
        let updated = self.updated.clone();
        CliUpdateService::new(CliUpdateServiceOptions {
            label: "Synthetic CLI".into(),
            definition: definition(),
            target: Rc::new(move || {
                let command = command.clone();
                async move { Ok(CliUpdateTarget { command, bundled }) }.boxed_local()
            }),
            environment: Rc::new(move || env.clone()),
            native_release: Rc::new(|| {
                async {
                    Ok(NativeReleaseSource {
                        key: "native".into(),
                        lookup: Box::new(|| async { Ok(None) }.boxed_local()),
                    })
                }
                .boxed_local()
            }),
            on_updated: Some(Rc::new(move || updated.set(updated.get() + 1))),
            logger: Rc::new(SilentLogger),
            clock: Some(Rc::new(ManualClock::new(
                garcon_js::date_parse::date_parse(TIMESTAMP).unwrap(),
            ))),
        })
    }
}

fn definition() -> CliInstallDefinition {
    CliInstallDefinition {
        package_name: PACKAGE.into(),
        native: NativeCliInstaller {
            owns_command_path: Rc::new(|path| path.contains("/.local/share/claude/")),
            args: vec!["update".into()],
            env: Some(Rc::new(|paths| {
                Environment::from([("SYNTHETIC_NATIVE_REAL".into(), paths.real.clone())])
            })),
        },
    }
}

#[test]
fn executable_lookup_uses_bun_path_precedence_and_absolute_spelling() {
    let fixture = Fixture::new();
    let executable = fixture.at("tools/synthetic-cli");
    script(&executable, "exit 0");
    let env = Environment::from([("Path".into(), pathstr(&fixture.at("tools")).into())]);
    assert_eq!(
        find_executable("synthetic-cli", &env).as_deref(),
        Some(pathstr(&executable))
    );
    let mut empty_path = env.clone();
    empty_path.insert("PATH".into(), String::new());
    assert_eq!(find_executable("synthetic-cli", &empty_path), None);
    let double_slash = format!("/{}", executable.display());
    assert_eq!(
        find_executable(&double_slash, &Environment::new()).as_deref(),
        Some(pathstr(&executable))
    );
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o010)).unwrap();
    assert_eq!(find_executable("synthetic-cli", &env), None);
}

struct SilentLogger;
impl AgentLogger for SilentLogger {
    fn debug(&self, _message: &str, _fields: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _message: &str, _fields: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, _message: &str, _fields: Option<&IndexMap<String, Opaque>>) {}
    fn error(&self, _message: &str, _fields: Option<&IndexMap<String, Opaque>>) {}
}

async fn status(service: &CliUpdateService, refresh: bool) -> AgentCliUpdateStatus {
    service
        .status(AgentCliUpdateStatusRequest {
            refresh,
            signal: None,
        })
        .await
        .unwrap()
}

async fn settled(service: &CliUpdateService) -> AgentCliUpdateStatus {
    timeout(Duration::from_secs(10), async {
        loop {
            let status = status(service, false).await;
            if status.run.state != State::Running {
                return status;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

async fn resolve(
    fixture: &Fixture,
    command: &str,
    platform: &str,
) -> garcon_agents_common::cli_update::install_resolution::CliInstallation {
    resolve_cli_installation(
        &definition(),
        CliInstallContext {
            command,
            env: &fixture.env,
            platform,
        },
    )
    .await
}

#[tokio::test]
async fn classifies_real_launchers_by_ownership() {
    let fixture = Fixture::new();
    let missing = resolve(&fixture, "synthetic-missing-cli", "linux").await;
    assert_eq!(missing.method, Method::Missing);
    assert!(missing.paths.is_none() && missing.update.is_none());

    let manual = resolve(&fixture, pathstr(&fixture.launcher), "linux").await;
    assert_eq!(manual.method, Method::Npm);
    assert!(manual.update.is_none());
    assert_eq!(manual.manual_command, Some(fixture.command()));

    fixture.npm(AFTER, "exit 0");
    let launcher = fixture.at(".local/share/claude/npm-looking-native");
    link(&fixture.real, &launcher);
    let npm = resolve(&fixture, pathstr(&launcher), "linux").await;
    assert_eq!(npm.method, Method::Npm);
    let action = npm.update.unwrap();
    assert_eq!(action.command, fixture.command());
    assert_eq!(action.executable, pathstr(&fixture.at("tools/npm")));
    assert_eq!(
        action.args,
        [
            "install",
            "-g",
            "--prefix",
            pathstr(&fixture.at("npm-prefix")),
            &format!("--allow-scripts={PACKAGE}"),
            &format!("{PACKAGE}@latest")
        ]
    );
    assert_eq!(
        action.lock_key,
        format!(
            "npm-global:{}",
            fixture
                .at("npm-prefix")
                .display()
                .to_string()
                .to_lowercase()
        )
    );

    let native = fixture.at(".local/share/claude/versions/2.1.238");
    script(&native, "echo 2.1.238");
    let launcher = fixture.at(".local/bin/claude");
    link(&native, &launcher);
    let owned = resolve(&fixture, pathstr(&launcher), "linux").await;
    assert_eq!(owned.latest_version, LatestVersionSource::Native);
    let action = owned.update.unwrap();
    assert_eq!(action.executable, pathstr(&launcher));
    assert_eq!(action.env["SYNTHETIC_NATIVE_REAL"], pathstr(&native));
    assert_eq!(action.args, ["update"]);

    let spaced = fixture.at(".local/share/claude/it's here/claude");
    script(&spaced, "exit 0");
    assert_eq!(
        resolve(&fixture, pathstr(&spaced), "linux")
            .await
            .update
            .unwrap()
            .command,
        format!("{} update", quoted(&spaced))
    );
    assert_eq!(
        resolve(&fixture, pathstr(&spaced), "win32")
            .await
            .update
            .unwrap()
            .command,
        format!("& '{}' update", pathstr(&spaced).replace('\'', "''"))
    );

    for path in [
        ".local/share/mise/installs/claude/2.1.238/bin/claude",
        "opt/claude",
    ] {
        let program = fixture.at(path);
        script(&program, "echo 2.1.238");
        let installation = resolve(&fixture, pathstr(&program), "linux").await;
        assert_eq!(installation.method, Method::Unmanaged);
        assert!(installation.update.is_none() && installation.manual_command.is_none());
    }
}

#[tokio::test]
async fn resolves_bun_pnpm_yarn_and_homebrew_installers() {
    let fixture = Fixture::new();
    for (executable, path, method, expected) in [
        ("bun", ".bun/bin/claude", Method::Bun, vec!["i", "-g"]),
        (
            "pnpm",
            ".local/share/pnpm/claude",
            Method::Pnpm,
            vec!["add", "-g", "--allow-build=@anthropic-ai/claude-code"],
        ),
        (
            "yarn",
            ".config/yarn/global/node_modules/claude",
            Method::Yarn,
            vec!["global", "add"],
        ),
    ] {
        script(&fixture.at(&format!("tools/{executable}")), "echo 10.4.1");
        let program = fixture.at(path);
        script(&program, "echo 2.1.238");
        let installation = resolve(&fixture, pathstr(&program), "linux").await;
        assert_eq!(installation.method, method);
        let action = installation.update.unwrap();
        assert_eq!(action.args[..action.args.len() - 1], expected);
        assert_eq!(action.args.last().unwrap(), &format!("{PACKAGE}@latest"));
    }
    let brew = fixture.at("homebrew/bin/brew");
    script(&brew, "exit 0");
    let keg = fixture.at("homebrew/Caskroom/claude-code/2.1.238/claude");
    script(&keg, "echo 2.1.238");
    let installation = resolve(&fixture, pathstr(&keg), "linux").await;
    assert_eq!(
        installation.latest_version,
        LatestVersionSource::Homebrew {
            brew: pathstr(&brew).into(),
            name: "claude-code".into(),
            cask: true
        }
    );
    let action = installation.update.unwrap();
    assert_eq!(action.args, ["upgrade", "--cask", "claude-code"]);
    assert_eq!(action.command, "brew upgrade --cask claude-code");
}

#[tokio::test]
async fn keeps_output_tail_and_reports_redrawn_progress() {
    let env = Environment::from([("PATH".into(), "/usr/bin:/bin".into())]);
    let result = run_bounded_command(
        "/bin/sh",
        &["-c".into(), "seq 1 5000; echo tail-line".into()],
        BoundedCommandOptions {
            env: &env,
            timeout: Duration::from_secs(10),
            max_output_bytes: 64,
            on_line: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(result.exit_code, Some(0));
    assert!(
        result.truncated && result.stdout.len() <= 64 && result.stdout.ends_with("tail-line\n")
    );
    let lines = RefCell::new(Vec::new());
    let on_line = |line: &str| lines.borrow_mut().push(line.to_owned());
    run_bounded_command(
        "/bin/sh",
        &[
            "-c".into(),
            r"printf 'one\r\033[32mtwo\033[0m\nthree'".into(),
        ],
        BoundedCommandOptions {
            env: &env,
            timeout: Duration::from_secs(10),
            max_output_bytes: 1024,
            on_line: Some(&on_line),
        },
    )
    .await
    .unwrap();
    assert_eq!(lines.into_inner(), ["one", "two", "three"]);
}

#[tokio::test]
async fn stops_the_whole_process_group_at_the_deadline() {
    let env = Environment::from([("PATH".into(), "/usr/bin:/bin".into())]);
    let result = timeout(
        Duration::from_secs(3),
        run_bounded_command(
            "/bin/sh",
            &["-c".into(), "trap '' TERM; sleep 10 & wait".into()],
            BoundedCommandOptions {
                env: &env,
                timeout: Duration::from_millis(100),
                max_output_bytes: 1024,
                on_line: None,
            },
        ),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(result.exit_code, None);
    assert!(result.timed_out);
}

#[tokio::test]
async fn reports_outdated_npm_and_caches_the_latest_version_until_refresh() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            fixture.npm(AFTER, "exit 0");
            let service = fixture.service();
            let first = status(&service, false).await;
            assert_eq!(first.cli_label, "Synthetic CLI");
            assert_eq!(first.install_method, Method::Npm);
            assert_eq!(first.install_path.as_deref(), Some(pathstr(&fixture.real)));
            assert_eq!(first.current_version.as_deref(), Some(BEFORE));
            assert_eq!(first.latest_version.as_deref(), Some(AFTER));
            assert_eq!(first.advisory, Advisory::BehindLatest);
            assert_eq!(first.update_command, Some(fixture.command()));
            assert!(first.can_update && first.message.is_none());
            assert_eq!(first.checked_at, TIMESTAMP);
            assert_eq!(first.run.state, State::Idle);
            status(&service, false).await;
            assert_eq!(
                fixture.calls(),
                [format!("view --global --json {PACKAGE}@latest version")]
            );
            status(&service, true).await;
            assert_eq!(fixture.calls().len(), 2);
        })
        .await;
}

#[tokio::test]
async fn starts_one_run_for_concurrent_requests_and_verifies_the_version() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new();
        fixture.npm(AFTER, &fixture.install(AFTER));
        let service = fixture.service();
        let (first, second) = tokio::join!(service.start_update(), service.start_update());
        for result in [first.unwrap(), second.unwrap()] {
            assert_eq!(result.run.state, State::Running);
            assert_eq!(result.run.started_at.as_deref(), Some(TIMESTAMP));
        }
        let terminal = settled(&service).await;
        assert_eq!(terminal.run.state, State::Succeeded);
        assert_eq!(terminal.run.message.as_deref(), Some("Updated Synthetic CLI to 2.1.300. Running chats keep the previous version; new sessions use the update."));
        assert!(terminal.run.output.unwrap().contains("added 1 package"));
        assert_eq!(terminal.current_version.as_deref(), Some(AFTER));
        assert_eq!(terminal.advisory, Advisory::Current);
        assert_eq!(fixture.updated.get(), 1);
        assert_eq!(fixture.calls().iter().filter(|line| line.starts_with("install")).count(), 1);
        assert!(fixture.calls().contains(&fixture.command()[4..].to_owned()));
    }).await;
}

#[tokio::test]
async fn reports_failed_unchanged_and_already_current_runs() {
    LocalSet::new()
        .run_until(async {
            for (latest, installer, state, message) in [
                (
                    AFTER,
                    "echo 'npm error synthetic install failure' >&2; echo 'try again' >&2; exit 3"
                        .to_owned(),
                    State::Failed,
                    "The update command exited with code 3: npm error synthetic install failure",
                ),
                (
                    AFTER,
                    "exit 0".into(),
                    State::Unchanged,
                    "The update command finished, but Synthetic CLI still reports 2.1.238.",
                ),
                (
                    BEFORE,
                    "exit 42".into(),
                    State::Succeeded,
                    "Synthetic CLI 2.1.238 is already the latest version.",
                ),
            ] {
                let fixture = Fixture::new();
                fixture.npm(latest, &installer);
                let service = fixture.service();
                service.start_update().await.unwrap();
                let terminal = settled(&service).await;
                assert_eq!(terminal.current_version.as_deref(), Some(BEFORE));
                assert_eq!(terminal.run.state, state);
                assert_eq!(terminal.run.message.as_deref(), Some(message));
                assert_eq!(
                    fixture
                        .calls()
                        .iter()
                        .any(|line| line.starts_with("install")),
                    latest != BEFORE
                );
            }
        })
        .await;
}

#[tokio::test]
async fn rejects_unsupported_updates_and_reports_a_missing_cli() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            let bundled = fixture.service_for(pathstr(&fixture.launcher), true);
            let first = status(&bundled, false).await;
            assert_eq!(first.install_method, Method::Bundled);
            assert!(!first.can_update);
            assert_eq!(first.current_version.as_deref(), Some(BEFORE));
            for (service, expected) in [
                (bundled, "Garcon runs its bundled Synthetic CLI".to_owned()),
                (fixture.service(), fixture.command()),
            ] {
                let error = service.start_update().await.unwrap_err();
                let error = error.downcast_ref::<AgentIntegrationError>().unwrap();
                assert_eq!(error.code, AgentIntegrationErrorCode::OPERATION_UNSUPPORTED);
                assert!(error.message.contains(&expected));
            }
            let missing = status(&fixture.service_for("synthetic-missing-cli", false), false).await;
            assert_eq!(missing.install_method, Method::Missing);
            assert_eq!(missing.advisory, Advisory::Unknown);
            assert!(!missing.can_update && missing.current_version.is_none());
            assert_eq!(
                missing.message.as_deref(),
                Some("Synthetic CLI (synthetic-missing-cli) was not found on PATH.")
            );
        })
        .await;
}

#[tokio::test]
async fn bounds_messages_and_preserves_the_stderr_tail() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new();
        fixture.npm(AFTER, r#"printf 'warn %.0s' $(seq 1 3000) >&2; printf '\nnpm error code EACCES\n' >&2; printf 'progress %.0s' $(seq 1 2000); exit 243"#);
        let service = fixture.service();
        service.start_update().await.unwrap();
        let terminal = settled(&service).await;
        assert_eq!(terminal.run.state, State::Failed);
        assert_eq!(terminal.run.message.as_deref(), Some("The update command exited with code 243: npm error code EACCES"));
        let output = terminal.run.output.unwrap();
        assert!(output.len() <= 10_000 && output.ends_with("npm error code EACCES"));
        fixture.npm(AFTER, r#"printf 'error: %s\n' "$(printf 'x%.0s' $(seq 1 6000))" >&2; exit 1"#);
        service.start_update().await.unwrap();
        let terminal = settled(&service).await;
        assert_eq!(terminal.run.state, State::Failed);
        assert_eq!(terminal.run.message.as_ref().unwrap().encode_utf16().count(), 500);
        assert!(parse_agent_cli_update_status(&serde_json::to_value(terminal).unwrap()).is_some());
    }).await;
}

#[tokio::test]
async fn reads_the_binary_again_when_a_run_finishes_during_a_slow_status_read() {
    LocalSet::new().run_until(async {
        let fixture = Fixture::new();
        let initial = fixture.at("first-probe-started");
        let release = fixture.at("first-probe-release");
        script(&fixture.real, &format!(
            "v=$(cat {version}); if [ ! -f {initial} ]; then touch {initial}; for i in $(seq 1 400); do [ -f {release} ] && break; sleep 0.01; done; fi; echo \"$v\"",
            version = quoted(&fixture.version), initial = quoted(&initial), release = quoted(&release)
        ));
        fixture.npm(AFTER, &fixture.install(AFTER));
        let service = fixture.service();
        let service_for_read = service.clone();
        let read = tokio::task::spawn_local(async move { status(&service_for_read, false).await });
        timeout(Duration::from_secs(3), async {
            while !initial.exists() { sleep(Duration::from_millis(5)).await; }
        }).await.unwrap();
        service.start_update().await.unwrap();
        assert_eq!(settled(&service).await.run.state, State::Succeeded);
        fs::write(release, "release").unwrap();
        let read = read.await.unwrap();
        assert_eq!(read.run.state, State::Succeeded);
        assert_eq!(read.current_version.as_deref(), Some(AFTER));
    }).await;
}

#[tokio::test]
async fn shares_inspection_and_reports_an_unknown_latest_version_on_spawn_failure() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            let calls = fixture.at("versions.log");
            script(
                &fixture.real,
                &format!(
                    "echo probe >> {}; cat {}",
                    quoted(&calls),
                    quoted(&fixture.version)
                ),
            );
            let npm = fixture.at("tools/npm");
            fs::write(&npm, [0x7f, b'E', b'L', b'F', 0, 0, 0, 0]).unwrap();
            fs::set_permissions(npm, fs::Permissions::from_mode(0o755)).unwrap();
            let service = fixture.service();
            let (first, second) = tokio::join!(status(&service, false), status(&service, false));
            assert_eq!(fs::read_to_string(calls).unwrap(), "probe\n");
            assert_eq!(first, second);
            assert_eq!(first.current_version.as_deref(), Some(BEFORE));
            assert_eq!(first.latest_version, None);
            assert_eq!(first.advisory, Advisory::Unknown);
        })
        .await;
}

#[tokio::test]
async fn reports_snapshot_while_installer_runs_and_serializes_same_prefix() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            let gate = fixture.at("release-install");
            fixture.npm(
                AFTER,
                &format!(
                    "for i in $(seq 1 400); do [ -f {} ] && break; sleep 0.01; done; {}",
                    quoted(&gate),
                    fixture.install(AFTER)
                ),
            );
            let first = fixture.service();
            let second = fixture.service();
            let start = first.start_update().await.unwrap();
            assert_eq!(start.current_version.as_deref(), Some(BEFORE));
            assert_eq!(start.advisory, Advisory::BehindLatest);
            assert_eq!(start.run.state, State::Running);
            second.start_update().await.unwrap();
            timeout(Duration::from_secs(2), async {
                while status(&second, false).await.run.message.as_deref()
                    != Some("Waiting for another update to finish")
                {
                    sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            let snapshot = status(&first, true).await;
            assert_eq!(snapshot.current_version.as_deref(), Some(BEFORE));
            assert_eq!(snapshot.run.state, State::Running);
            fs::write(gate, "release").unwrap();
            assert_eq!(settled(&first).await.run.state, State::Succeeded);
            assert_eq!(settled(&second).await.run.state, State::Succeeded);
        })
        .await;
}

#[tokio::test]
async fn rust_and_bun_report_the_same_status_bytes_for_the_same_installation() {
    LocalSet::new()
        .run_until(async {
            let fixture = Fixture::new();
            fixture.npm(AFTER, &fixture.install(AFTER));
            let oracle = tokio::process::Command::new("bun")
                .arg(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/oracles/cli-update.ts"
                ))
                .arg(fixture.root.path())
                .output()
                .await
                .unwrap();
            assert!(
                oracle.status.success(),
                "{}",
                String::from_utf8_lossy(&oracle.stderr)
            );
            fs::write(&fixture.version, format!("{BEFORE} (Synthetic CLI)\n")).unwrap();
            let service = fixture.service();
            let before = status(&service, false).await;
            service.start_update().await.unwrap();
            let after = settled(&service).await;
            assert_eq!(after.run.state, State::Succeeded);
            #[derive(serde::Serialize)]
            struct Transition {
                before: AgentCliUpdateStatus,
                after: AgentCliUpdateStatus,
            }
            let actual = serde_json::to_string(&Transition { before, after }).unwrap();
            assert_eq!(actual, String::from_utf8(oracle.stdout).unwrap());
        })
        .await;
}
