use std::{
    cell::Cell,
    path::{Path, PathBuf},
    process::Stdio,
    rc::Rc,
    time::Duration,
};

use garcon_base::{errors::NamedError, log::create_logger};
use garcon_contract::executors::ExecutorBulkAvailability;
use garcon_contract::file_contracts::{FileSaveConflictResolution, SaveTextRequest};
use garcon_contract::git::{GitQuickSummaryResponse, ProjectOptions};
use garcon_contract::terminal::TerminalCreateRequest;
use garcon_execution::{
    executor_manager_ports::{CreateRemoteExecutor, ManagedRemoteExecutor, RemoteExecutorFactory},
    remote_client::RemoteExecutorClientFactory,
};
use garcon_interface::{
    execution_runtime::{ExecutionProjectInspectRequest, ExecutorAvailability},
    files::{ExecutionDirectoryCreation, ExecutionFileSave, ExecutionFileTarget},
    resources::ExecutorCallOptions,
    terminals::TerminalAuthority,
};
use garcon_js::json::parse;
use garcon_link::{
    connection_url::{create_executor_secret, executor_connection_url, parse_connection_url},
    link_handshake::LinkRole,
    websocket_link::{WebSocketLink, WebSocketLinkOptions},
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    sync::Notify,
    task::LocalSet,
    time::timeout,
};
use tokio_util::sync::CancellationToken;
use url::Url;

const ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEADLINE: Duration = Duration::from_secs(20);

enum Worker {
    Bun,
    Rust(PathBuf),
}

struct Fixture {
    _root: tempfile::TempDir,
    config: PathBuf,
    project: PathBuf,
    home: PathBuf,
    temp: PathBuf,
}

impl Fixture {
    async fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let fixture = Self {
            config: root.path().join("config"),
            project: root.path().join("project"),
            home: root.path().join("home"),
            temp: root.path().join("scratch"),
            _root: root,
        };
        for dir in [
            &fixture.config,
            &fixture.project,
            &fixture.home,
            &fixture.temp,
        ] {
            tokio::fs::create_dir(dir).await.unwrap();
        }
        tokio::fs::write(fixture.project.join("sample.txt"), "synthetic\n")
            .await
            .unwrap();
        fixture
    }

    fn command(&self, worker: &Worker) -> Command {
        let mut command = match worker {
            Worker::Bun => {
                let mut command = Command::new("bun");
                command.args(["server/main.ts", "executor"]);
                command
            }
            Worker::Rust(path) => Command::new(path),
        };
        command
            .current_dir(Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .env("TMPDIR", &self.temp)
            .env("GARCON_TERMINAL_SHELL", "/bin/sh")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .kill_on_drop(true);
        command
    }

    fn spawn(&self, worker: &Worker, controller_address: Option<&str>) -> Child {
        let mut command = self.command(worker);
        command
            .args(["--no-tls", "--config-dir"])
            .arg(&self.config)
            .arg("--project-base-dir")
            .arg(&self.project);
        if let Some(address) = controller_address {
            command.env("GARCON_CONTROLLER_URL", address);
        } else {
            command.args(["--listen", "0", "--bind-address", "0.0.0.0"]);
        }
        command.spawn().unwrap()
    }

    async fn advertised_url(&self, worker: &Worker, address: &str) -> String {
        let mut address = Url::parse(address).unwrap();
        if address.host_str() == Some("0.0.0.0") {
            address.set_host(Some("127.0.0.1")).unwrap();
        }
        let output = self
            .command(worker)
            .args([
                "connection-url",
                "--no-tls",
                "--advertise-url",
                address.as_str(),
                "--config-dir",
            ])
            .arg(&self.config)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "worker failed to reveal its synthetic connection URL: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }
}

fn controller(secret: String) -> (Rc<dyn ManagedRemoteExecutor>, Rc<WebSocketLink>) {
    let mut options = WebSocketLinkOptions::new(LinkRole::Controller, secret);
    options.executor_id = Some(ID.into());
    options.no_tls = true;
    options.redial_delays_ms = Some(vec![25]);
    let link = WebSocketLink::new(options).unwrap();
    let client = RemoteExecutorClientFactory
        .create(CreateRemoteExecutor {
            executor_id: ID.into(),
            link: link.clone(),
            previous_inventory: None,
            report_setup_error: Rc::new(|_| {}),
            bind_reverse_requests: Rc::new(|_| {}),
            logger: Rc::new(create_logger("remote-client-test")),
        })
        .unwrap();
    (client, link)
}

async fn wait_ready(client: &dyn ManagedRemoteExecutor) {
    let changed = Rc::new(Notify::new());
    let _off_available = client.on_availability_changed(Rc::new({
        let changed = changed.clone();
        move |_| changed.notify_one()
    }));
    let _off_bulk = client.on_bulk_changed(Rc::new({
        let changed = changed.clone();
        move |_| changed.notify_one()
    }));
    timeout(DEADLINE, async {
        while client.availability() != ExecutorAvailability::Ready
            || client.bulk_status().availability != ExecutorBulkAvailability::Ready
        {
            changed.notified().await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!(
            "remote executor did not install: {:?}, {:?}",
            client.availability(),
            client.bulk_status()
        )
    });
    _off_available();
    _off_bulk();
}

async fn real_worker(worker: &Worker, controller_dials: bool) {
    let fixture = Fixture::new().await;
    let (client, link, mut child) = if controller_dials {
        let mut child = fixture.spawn(worker, None);
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let address = timeout(DEADLINE, async {
            while let Some(line) = lines.next_line().await.unwrap() {
                if let Ok(value) = parse(&line)
                    && value["type"] == "executor-listening"
                {
                    return value["url"].as_str().unwrap().to_owned();
                }
            }
            panic!("worker exited before its readiness frame");
        })
        .await
        .unwrap();
        let address =
            parse_connection_url(&fixture.advertised_url(worker, &address).await).unwrap();
        let (client, link) = controller(address.secret);
        link.dial(&address.socket_url).unwrap();
        tokio::task::spawn_local(async move {
            while lines.next_line().await.is_ok_and(|line| line.is_some()) {}
        });
        (client, link, child)
    } else {
        let secret = create_executor_secret();
        let (client, link) = controller(secret.clone());
        let address = link.listen(0, "0.0.0.0", None).await.unwrap();
        let address = executor_connection_url(&address, &secret).unwrap();
        let mut child = fixture.spawn(worker, Some(&address));
        let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
        tokio::task::spawn_local(async move {
            while lines.next_line().await.is_ok_and(|line| line.is_some()) {}
        });
        (client, link, child)
    };
    wait_ready(client.as_ref()).await;
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = client
        .get_info(Some(ExecutorCallOptions {
            signal: Some(cancel),
            ..Default::default()
        }))
        .await
        .unwrap_err();
    assert_eq!(
        error.downcast_ref::<NamedError>().unwrap().name,
        "AbortError"
    );
    let info = client.get_info(None).await.unwrap();
    assert_eq!(info.executor_id, ID);
    let project = fixture.project.to_string_lossy().into_owned();
    assert_eq!(info.project_base_path, project);
    let expected_id = "direct-openai-compatible";
    let inventory = client.inventory().unwrap();
    assert!(
        inventory
            .integrations
            .iter()
            .any(|manifest| manifest.descriptor.id == expected_id
                && manifest.scope.instance_id == info.instance_id)
    );
    let agent = client
        .get_agent_integration(expected_id, None)
        .await
        .unwrap();
    assert_eq!(agent.settings.defaults().unwrap().owner_id, expected_id);
    assert!(agent.native_history_import.is_some());
    let inspection = client
        .get_project_service(None)
        .await
        .unwrap()
        .inspect(
            ExecutionProjectInspectRequest {
                project_path: project.clone(),
                include_git_repository: Some(true),
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(inspection.is_git_repository, Some(false));
    let summary = client
        .get_git_service(None)
        .await
        .unwrap()
        .get_quick_summary(
            ProjectOptions {
                project_path: project.clone(),
            },
            None,
        )
        .await
        .unwrap();
    assert!(matches!(
        summary.result,
        GitQuickSummaryResponse::NotGitRepository { .. }
    ));
    assert_eq!(summary.scope.instance_id, info.instance_id);

    let files = client.get_files_service(None).await.unwrap();
    let target = ExecutionFileTarget {
        project_path: project.clone(),
        file_path: "sample.txt".into(),
    };
    let read = files.read(target.clone(), None).await.unwrap();
    assert_eq!(read.bytes, b"synthetic\n");
    let content = "fixture\0\u{1f600}\n";
    let saved = files
        .save(
            ExecutionFileSave {
                target: target.clone(),
                request: SaveTextRequest {
                    content: content.into(),
                    expected_revision: read.revision.clone(),
                    conflict_resolution: FileSaveConflictResolution::Reject,
                },
            },
            None,
        )
        .await
        .unwrap();
    assert_ne!(saved.revision, read.revision);
    assert_eq!(
        tokio::fs::read(fixture.project.join("sample.txt"))
            .await
            .unwrap(),
        content.as_bytes()
    );
    let dir = files
        .create_directory(
            ExecutionDirectoryCreation {
                parent_path: project,
                name: "child".into(),
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(dir.name, "child");
    assert!(fixture.project.join("child").is_dir());

    let authority = TerminalAuthority {
        key: "synthetic".into(),
        expires_at_ms: None,
    };
    let terminal_service = client.get_terminal_service(None).await.unwrap();
    let terminals = terminal_service
        .list(authority.clone(), None)
        .await
        .unwrap();
    assert!(terminals.terminals.is_empty());
    assert!(terminals.attachment_epoch.is_some());
    if cfg!(unix) {
        let created = terminal_service
            .create(
                authority.clone(),
                TerminalCreateRequest {
                    request_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
                    executor_id: Some(ID.into()),
                    expected_terminal_runtime_id: terminals.terminal_runtime_id,
                    requested_initial_working_directory: None,
                },
                None,
            )
            .await
            .unwrap();
        let terminated = terminal_service
            .terminate(
                authority,
                created.terminal.terminal_id.clone(),
                "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb".into(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(terminated.terminal_id, created.terminal.terminal_id);
    }

    let first_session = link.current().unwrap().id.clone();
    let first_bulk = link.bulk().unwrap();
    let changed = Rc::new(Notify::new());
    let recovering = Rc::new(Cell::new(false));
    let off_bulk = client.on_bulk_changed(Rc::new({
        let changed = changed.clone();
        let recovering = recovering.clone();
        move |status| {
            if status.availability == ExecutorBulkAvailability::Reconnecting {
                recovering.set(true);
            }
            changed.notify_one();
        }
    }));
    first_bulk.close(None);
    assert_eq!(
        client.get_info(None).await.unwrap().instance_id,
        info.instance_id
    );
    timeout(DEADLINE, async {
        while client.bulk_status().availability != ExecutorBulkAvailability::Ready
            || !link.bulk().is_some_and(|bulk| bulk.id != first_bulk.id)
        {
            changed.notified().await;
        }
    })
    .await
    .unwrap();
    off_bulk();
    assert!(recovering.get());
    assert_eq!(link.current().unwrap().id, first_session);
    assert_eq!(client.availability(), ExecutorAvailability::Ready);

    let changed = Rc::new(Notify::new());
    let off = client.on_availability_changed(Rc::new({
        let changed = changed.clone();
        move |_| changed.notify_one()
    }));
    link.disconnect();
    timeout(DEADLINE, async {
        loop {
            if client.availability() == ExecutorAvailability::Ready
                && link
                    .current()
                    .is_some_and(|transport| transport.id != first_session)
            {
                break;
            }
            changed.notified().await;
        }
    })
    .await
    .unwrap();
    off();
    assert_eq!(
        client.get_info(None).await.unwrap().instance_id,
        info.instance_id
    );
    assert!(Rc::ptr_eq(
        &client
            .get_agent_integration(expected_id, None)
            .await
            .unwrap(),
        &agent
    ));
    assert_eq!(
        files.read(target, None).await.unwrap().bytes,
        content.as_bytes()
    );
    assert!(child.try_wait().unwrap().is_none());
    client.dispose().await.unwrap();
    child.kill().await.unwrap();
}

#[tokio::test]
async fn original_worker_supports_both_dial_directions() {
    LocalSet::new()
        .run_until(async {
            real_worker(&Worker::Bun, true).await;
            real_worker(&Worker::Bun, false).await;
        })
        .await;
}

#[tokio::test]
#[ignore = "the remote-client unit gate supplies the separately built worker binary"]
async fn native_worker_supports_both_dial_directions() {
    let binary = std::env::var_os("GARCON_TEST_RUST_EXECUTOR_BINARY")
        .expect("the unit gate supplies a worker binary");
    LocalSet::new()
        .run_until(async {
            let worker = Worker::Rust(binary.into());
            real_worker(&worker, true).await;
            real_worker(&worker, false).await;
        })
        .await;
}
