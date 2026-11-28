use std::cell::{Cell, RefCell};
use std::ffi::OsStr;
use std::future::Future;
use std::rc::Rc;
use std::time::Duration;

use async_trait::async_trait;
use garcon_contract::terminal::{
    TERMINAL_MAX_INPUT_BYTES, TerminalAttachIntent, TerminalCreateRequest,
    TerminalErrorCode as Code, TerminalMetadata, TerminalProcessStatus as Process,
    TerminalServerAttachmentStatus as Attachment, TerminalStreamServerMessage,
    TerminalStreamServerPayload as Message,
};
use garcon_contract::terminal_error::TerminalError;
use garcon_interface::resources::{ExecutorCallOptions, ExecutorResult};
use garcon_interface::terminals::{
    ExecutionTerminalService, TerminalAttachKind, TerminalAttachRequest, TerminalAuthority,
    TerminalPeer,
};
use garcon_js::{Number, clock::ManualClock};
use indexmap::IndexSet;
use tokio::sync::{Notify, mpsc};
use tokio::task::LocalSet;
use tokio::time::{sleep, timeout};
use tokio_util::sync::CancellationToken;

use super::pty::{PtyCommand, PtyControl, PtyEvent, SpawnedPty};
use super::runtime::{TerminalRuntime, TerminalService};
use super::terminal_manager::{TerminalManager, TerminalManagerOptions};

const REMOTE: &str = "12345678-1234-4abc-8abd-1234567890ab";

#[derive(Default)]
struct Peer {
    ids: RefCell<IndexSet<String>>,
    events: RefCell<Vec<Message>>,
}

impl TerminalPeer for Peer {
    fn connection_id(&self) -> &str {
        "synthetic"
    }
    fn owned_terminal_ids(&self) -> &RefCell<IndexSet<String>> {
        &self.ids
    }
    fn send_terminal_message(&self, message: TerminalStreamServerMessage) {
        assert!(message.attachment_id.is_none());
        self.events.borrow_mut().push(message.payload);
    }
}

impl Peer {
    fn take(&self) -> Vec<Message> {
        self.events.take()
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Op {
    Write(String),
    Resize(u16, u16),
}

#[derive(Default)]
struct FakePty {
    operations: RefCell<Vec<Op>>,
    kills: Cell<usize>,
    fail_next_write: Cell<bool>,
}

#[async_trait(?Send)]
impl PtyControl for FakePty {
    async fn write(&self, data: String) -> ExecutorResult<()> {
        if self.fail_next_write.replace(false) {
            return Err("synthetic PTY write failure".into());
        }
        self.operations.borrow_mut().push(Op::Write(data));
        Ok(())
    }

    async fn resize(&self, cols: u16, rows: u16) -> ExecutorResult<()> {
        self.operations.borrow_mut().push(Op::Resize(cols, rows));
        Ok(())
    }

    fn kill(&self) {
        self.kills.set(self.kills.get() + 1);
    }
}

struct FakeSpawn {
    command: PtyCommand,
    pty: Rc<FakePty>,
    output: mpsc::Sender<PtyEvent>,
}

impl FakeSpawn {
    fn output(&self, data: &str) {
        assert!(
            self.output
                .try_send(PtyEvent::Output(data.to_owned()))
                .is_ok()
        );
    }
}

type Spawns = Rc<RefCell<Vec<FakeSpawn>>>;

fn options() -> (tempfile::TempDir, TerminalManagerOptions, Spawns) {
    let temp = tempfile::tempdir().unwrap();
    let mut options = TerminalManagerOptions::new(temp.path().to_str().unwrap().to_owned());
    let spawns = Spawns::default();
    options.spawn_pty = Some(Rc::new({
        let spawns = spawns.clone();
        move |command| {
            let pty = Rc::new(FakePty::default());
            let (output, events) = mpsc::channel(128);
            spawns.borrow_mut().push(FakeSpawn {
                command,
                pty: pty.clone(),
                output,
            });
            Box::pin(async move {
                Ok(SpawnedPty {
                    control: pty,
                    events,
                })
            })
        }
    }));
    (temp, options, spawns)
}

fn principal(key: &str) -> TerminalAuthority {
    TerminalAuthority {
        key: key.to_owned(),
        expires_at_ms: None,
    }
}

fn alice() -> TerminalAuthority {
    principal("alice")
}

fn create_request(request_id: &str, runtime: Option<&str>) -> TerminalCreateRequest {
    TerminalCreateRequest {
        request_id: request_id.to_owned(),
        executor_id: None,
        expected_terminal_runtime_id: runtime.map(str::to_owned),
        requested_initial_working_directory: None,
    }
}

fn attach_request(id: &str, client: &str, epoch: Option<&str>) -> TerminalAttachRequest {
    TerminalAttachRequest {
        r#type: TerminalAttachKind::TerminalAttach,
        terminal_id: id.to_owned(),
        client_id: client.to_owned(),
        after_sequence: Number(0.0),
        intent: TerminalAttachIntent::Restore,
        attachment_epoch: epoch.map(str::to_owned),
        attachment_id: None,
    }
}

fn error_code<T: std::fmt::Debug>(outcome: ExecutorResult<T>) -> Code {
    outcome
        .unwrap_err()
        .downcast_ref::<TerminalError>()
        .unwrap()
        .code
}

async fn run<T>(future: impl Future<Output = T>) -> T {
    LocalSet::new().run_until(future).await
}

async fn until(mut condition: impl FnMut() -> bool) {
    timeout(Duration::from_secs(5), async {
        while !condition() {
            sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap();
}

async fn create(manager: &TerminalManager, key: &str) -> TerminalMetadata {
    manager
        .create(alice(), create_request(key, None))
        .await
        .unwrap()
        .terminal
}

#[tokio::test]
async fn uses_the_injected_runtime_base_and_shell_without_controller_configuration() {
    run(async {
        let (temp, mut options, spawns) = options();
        options.user_shell = Some("synthetic-shell".into());
        let manager = TerminalManager::new(options);
        let terminal = create(&manager, "one").await;
        let root = garcon_base::path_boundary::realpath(temp.path())
            .await
            .unwrap();
        assert_eq!(
            terminal.initial_working_directory,
            garcon_base::executor_path::to_executor_path(root.to_str().unwrap(), None)
        );
        let spawns = spawns.borrow();
        let command = &spawns[0].command;
        assert_eq!(command.file, "synthetic-shell");
        assert!(command.args.is_empty());
        assert_eq!(command.cwd, root.to_str().unwrap());
        assert_eq!((command.cols, command.rows), (80, 24));
        assert_eq!(command.name, "xterm-256color");
        for (key, expected) in [
            ("TERM", "xterm-256color"),
            ("COLORTERM", "truecolor"),
            ("FORCE_COLOR", "3"),
            ("GARCON_CONTROLLER_URL", ""),
        ] {
            let effective = command
                .env
                .iter()
                .rev()
                .find(|(name, _)| name.eq_ignore_ascii_case(OsStr::new(key)))
                .map(|(_, value)| value.as_os_str());
            assert_eq!(effective, Some(OsStr::new(expected)));
        }
    })
    .await;
}

#[tokio::test]
async fn pty_uses_the_worker_environment_with_a_blanked_controller_url() {
    run(async {
        let (_temp, mut options, spawns) = options();
        options.child_environment = Some(
            vec![
                ("GARCON_CONFIG_DIR".into(), "/synthetic-config".into()),
                ("GARCON_RUNTIME".into(), "executor".into()),
            ]
            .into(),
        );
        let manager = TerminalManager::new(options);
        create(&manager, "one").await;
        let spawns = spawns.borrow();
        let env = &spawns[0].command.env;
        assert_eq!(env.len(), 6);
        for (key, expected) in [
            ("GARCON_CONFIG_DIR", "/synthetic-config"),
            ("GARCON_RUNTIME", "executor"),
            ("GARCON_CONTROLLER_URL", ""),
        ] {
            assert_eq!(
                env.iter()
                    .rev()
                    .find(|(name, _)| name == OsStr::new(key))
                    .map(|(_, value)| value.as_os_str()),
                Some(OsStr::new(expected)),
            );
        }
    })
    .await;
}

#[tokio::test]
async fn creates_idempotently_isolates_principals_and_retains_exited_sessions() {
    run(async {
        let (_temp, options, spawns) = options();
        let manager = TerminalManager::new(options);
        let initial = create(&manager, "one").await;
        assert_eq!(create(&manager, "one").await, initial);
        assert_eq!(spawns.borrow().len(), 1);
        assert!(manager.list(&principal("bob")).is_empty());
        assert_eq!(manager.rename(&principal("bob"), &initial.terminal_id, None).unwrap_err().code, Code::TERMINAL_NOT_FOUND);
        let peer = Rc::new(Peer::default());
        manager.attach(&alice(), peer.clone(), attach_request(&initial.terminal_id, "client", None)).unwrap();
        manager.rename(&alice(), &initial.terminal_id, Some("renamed".into())).unwrap();
        assert!(matches!(&peer.take()[1], Message::TerminalStatus { terminal } if terminal.title.as_deref() == Some("renamed")));
        assert!(spawns.borrow()[0].output.try_send(PtyEvent::Exited(7)).is_ok());
        until(|| manager.list(&alice())[0].process_status == Process::Exited).await;
        assert_eq!(manager.list(&alice())[0].exit_code, Some(Number(7.0)));
        manager.rename(&alice(), &initial.terminal_id, None).unwrap();
        assert!(matches!(&peer.take()[1], Message::TerminalStatus { terminal } if terminal.title.is_none() && terminal.process_status == Process::Exited));
        assert_eq!(create(&manager, "one").await, initial);
    }).await;
}

#[tokio::test]
async fn enforces_the_principal_cap_under_concurrent_creation() {
    run(async {
        let (_temp, options, spawns) = options();
        let manager = TerminalManager::new(options);
        let creates = (0..12).map(|n| {
            let manager = manager.clone();
            async move {
                manager
                    .create(alice(), create_request(&format!("request-{n}"), None))
                    .await
            }
        });
        let results = futures::future::join_all(creates).await;
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 8);
        for failure in results.into_iter().filter(|result| result.is_err()) {
            assert_eq!(error_code(failure), Code::TERMINAL_LIMIT);
        }
        let bob = manager
            .create(principal("bob"), create_request("request-0", None))
            .await
            .unwrap();
        assert_eq!(bob.terminal.display_sequence, Number(1.0));
        assert_eq!(spawns.borrow().len(), 9);
    })
    .await;
}

#[tokio::test]
async fn replays_retained_output_reports_truncation_and_transfers_attachment_ownership() {
    run(async {
        let (_temp, mut options, spawns) = options();
        options.replay_bytes = Some(4.0);
        let manager = TerminalManager::new(options);
        let id = create(&manager, "one").await.terminal_id;
        let old = Rc::new(Peer::default());
        manager.attach(&alice(), old.clone(), attach_request(&id, "one", None)).unwrap();
        for text in ["ab", "\u{e9}", "cd"] { spawns.borrow()[0].output(text); }
        until(|| manager.list(&alice())[0].latest_output_sequence == Number(3.0)).await;
        assert_eq!(old.take().len(), 4);
        let new = Rc::new(Peer::default());
        let mut attach = attach_request(&id, "two", None);
        attach.after_sequence = Number(4.0);
        assert_eq!(manager.attach(&alice(), new.clone(), attach.clone()).unwrap_err().code, Code::TERMINAL_REPLAY_SEQUENCE);
        attach.after_sequence = Number(0.0);
        assert_eq!(manager.attach(&alice(), new.clone(), attach.clone()).unwrap_err().code, Code::TERMINAL_TAKEOVER_REQUIRED);
        attach.intent = TerminalAttachIntent::Takeover;
        manager.attach(&alice(), new.clone(), attach).unwrap();
        assert!(old.ids.borrow().is_empty());
        assert!(new.ids.borrow().contains(&id));
        assert!(matches!(&old.take()[0], Message::TerminalTakenOver { replacement_client_id, .. } if replacement_client_id == "two"));
        let messages = new.take();
        assert!(matches!(&messages[0], Message::TerminalReplayTruncated { first_sequence: Number(2.0), .. }));
        assert!(matches!(&messages[1], Message::TerminalAttached { replay, .. } if replay.len() == 2 && replay[0].sequence == Number(2.0)));
        assert_eq!(manager.input(alice(), old.clone(), &id, "stale".into()).unwrap_err().code, Code::TERMINAL_NOT_ATTACHED);
        manager.detach_terminal(&alice(), &(new as Rc<dyn TerminalPeer>), &id);
        assert!(spawns.borrow()[0].output.try_send(PtyEvent::Exited(0)).is_ok());
        until(|| !old.events.borrow().is_empty()).await;
        assert!(matches!(&old.take()[0], Message::TerminalStatus { terminal } if terminal.attachment_status == Attachment::Detached));
    }).await;
}

#[tokio::test]
async fn restoring_to_a_new_peer_with_the_same_client_fences_old_detach() {
    run(async {
        let (_temp, options, spawns) = options();
        let manager = TerminalManager::new(options);
        let id = create(&manager, "one").await.terminal_id;
        let old = Rc::new(Peer::default());
        let new = Rc::new(Peer::default());
        let request = attach_request(&id, "stable-client", None);
        manager.attach(&alice(), old.clone(), request.clone()).unwrap();
        old.take();
        manager.attach(&alice(), new.clone(), request).unwrap();
        assert!(old.take().is_empty());
        manager.detach_peer(&alice(), &(old as Rc<dyn TerminalPeer>));
        assert!(new.ids.borrow().contains(&id));
        spawns.borrow()[0].output("still attached");
        until(|| new.events.borrow().len() == 2).await;
        assert!(matches!(&new.take()[1], Message::TerminalOutput { data, .. } if data == "still attached"));
    }).await;
}

#[tokio::test]
async fn broadcasts_exit_and_termination_to_attached_and_displaced_peers() {
    run(async {
        let (_temp, options, spawns) = options();
        let manager = TerminalManager::new(options);
        for detached in [false, true] {
            let request = if detached { "detached" } else { "attached" };
            let id = create(&manager, request).await.terminal_id;
            let old = Rc::new(Peer::default());
            let current = Rc::new(Peer::default());
            manager.attach(&alice(), old.clone(), attach_request(&id, "old", None)).unwrap();
            let mut takeover = attach_request(&id, "current", None);
            takeover.intent = TerminalAttachIntent::Takeover;
            manager.attach(&alice(), current.clone(), takeover).unwrap();
            old.take();
            current.take();
            if detached {
                manager.detach_peer(&alice(), &(current.clone() as Rc<dyn TerminalPeer>));
            }
            assert!(spawns.borrow().last().unwrap().output.try_send(PtyEvent::Exited(11)).is_ok());
            until(|| !old.events.borrow().is_empty()).await;
            let status = if detached { Attachment::Detached } else { Attachment::Attached };
            assert!(matches!(
                old.take().as_slice(),
                [Message::TerminalStatus { terminal }]
                    if terminal.process_status == Process::Exited
                        && terminal.exit_code == Some(Number(11.0))
                        && terminal.attachment_status == status
            ));
            if detached {
                assert!(current.take().is_empty());
            } else {
                assert!(matches!(
                    current.take().as_slice(),
                    [Message::TerminalStatus { terminal }] if terminal.exit_code == Some(Number(11.0))
                ));
            }
            let removed = manager.terminate(alice(), id.clone(), "remove".into()).await.unwrap();
            assert_eq!(removed.terminal.unwrap().process_status, Process::Exited);
            assert!(matches!(
                old.take().as_slice(),
                [Message::TerminalTerminated { terminal_id }] if terminal_id == &id
            ));
            if detached {
                assert!(current.take().is_empty());
            } else {
                assert!(matches!(
                    current.take().as_slice(),
                    [Message::TerminalTerminated { terminal_id }] if terminal_id == &id
                ));
            }
            assert!(current.ids.borrow().is_empty());
        }
    }).await;
}

#[tokio::test]
async fn detaches_one_terminal_without_affecting_another_on_the_same_peer() {
    run(async {
        let (_temp, options, spawns) = options();
        let manager = TerminalManager::new(options);
        let first = create(&manager, "a").await.terminal_id;
        let second = create(&manager, "b").await.terminal_id;
        let peer = Rc::new(Peer::default());
        for id in [&first, &second] {
            manager.attach(&alice(), peer.clone(), attach_request(id, "same", None)).unwrap();
        }
        peer.take();
        manager.detach_terminal(&alice(), &(peer.clone() as Rc<dyn TerminalPeer>), &first);
        assert!(!peer.ids.borrow().contains(&first));
        assert!(peer.ids.borrow().contains(&second));
        assert_eq!(
            manager.input(alice(), peer.clone(), &first, "stale".into()).unwrap_err().code,
            Code::TERMINAL_NOT_ATTACHED
        );
        manager.input(alice(), peer.clone(), &second, "current".into()).unwrap();
        spawns.borrow()[0].output("not delivered");
        spawns.borrow()[1].output("delivered");
        until(|| manager.list(&alice()).iter().all(|terminal| terminal.latest_output_sequence == Number(1.0))).await;
        until(|| !spawns.borrow()[1].pty.operations.borrow().is_empty()).await;
        assert!(matches!(
            peer.take().as_slice(),
            [Message::TerminalOutput { terminal_id, data, .. }] if terminal_id == &second && data == "delivered"
        ));
        assert!(spawns.borrow().iter().all(|spawn| spawn.pty.kills.get() == 0));
    }).await;
}

#[tokio::test]
async fn orders_input_and_coalesces_only_adjacent_resizes_even_after_an_operation_error() {
    run(async {
        let (_temp, options, spawns) = options();
        let manager = TerminalManager::new(options);
        let id = create(&manager, "one").await.terminal_id;
        let peer = Rc::new(Peer::default());
        manager.attach(&alice(), peer.clone(), attach_request(&id, "one", None)).unwrap();
        peer.take();
        let pty = spawns.borrow()[0].pty.clone();
        pty.fail_next_write.set(true);
        manager.input(alice(), peer.clone(), &id, "fails".into()).unwrap();
        for (cols, rows) in [(70.0, 20.0), (90.0, 25.0)] {
            manager.resize(alice(), peer.clone(), &id, Number(cols), Number(rows)).unwrap();
        }
        manager.input(alice(), peer.clone(), &id, "between".into()).unwrap();
        for (cols, rows) in [(100.0, 30.0), (110.0, 35.0)] {
            manager.resize(alice(), peer.clone(), &id, Number(cols), Number(rows)).unwrap();
        }
        until(|| pty.operations.borrow().len() == 3).await;
        assert_eq!(&*pty.operations.borrow(), &[Op::Resize(90, 25), Op::Write("between".into()), Op::Resize(110, 35)]);
        assert!(matches!(&peer.take()[0], Message::TerminalError { code, .. } if *code == Code::TERMINAL_INTERNAL));
        manager.detach_peer(&alice(), &(peer as Rc<dyn TerminalPeer>));
        assert_eq!(pty.kills.get(), 0);
        let first = manager.terminate(alice(), id.clone(), "stop".into()).await.unwrap();
        assert_eq!(manager.terminate(alice(), id, "stop".into()).await.unwrap(), first);
        assert_eq!(pty.kills.get(), 1);
    }).await;
}

#[tokio::test]
async fn drops_queued_operations_when_the_same_peer_reattaches_before_dispatch() {
    run(async {
        let (_temp, options, spawns) = options();
        let manager = TerminalManager::new(options);
        let id = create(&manager, "one").await.terminal_id;
        let peer = Rc::new(Peer::default());
        let request = attach_request(&id, "same", None);
        manager
            .attach(&alice(), peer.clone(), request.clone())
            .unwrap();
        manager
            .input(alice(), peer.clone(), &id, "stale".into())
            .unwrap();
        manager
            .resize(alice(), peer.clone(), &id, Number(70.0), Number(20.0))
            .unwrap();
        manager.attach(&alice(), peer.clone(), request).unwrap();
        manager
            .resize(alice(), peer.clone(), &id, Number(95.0), Number(24.0))
            .unwrap();
        manager.input(alice(), peer, &id, "current".into()).unwrap();
        let pty = spawns.borrow()[0].pty.clone();
        until(|| pty.operations.borrow().last() == Some(&Op::Write("current".into()))).await;
        assert_eq!(
            &*pty.operations.borrow(),
            &[Op::Resize(95, 24), Op::Write("current".into())]
        );
    })
    .await;
}

#[tokio::test]
async fn bounds_input_and_drops_queued_work_at_authorization_expiry() {
    run(async {
        let (_temp, mut options, spawns) = options();
        let clock = Rc::new(ManualClock::new(1));
        options.clock = clock.clone();
        let manager = TerminalManager::new(options);
        let id = create(&manager, "one").await.terminal_id;
        let peer = Rc::new(Peer::default());
        let authority = TerminalAuthority {
            expires_at_ms: Some(2),
            ..alice()
        };
        manager
            .attach(&authority, peer.clone(), attach_request(&id, "one", None))
            .unwrap();
        assert_eq!(
            manager
                .input(
                    authority.clone(),
                    peer.clone(),
                    &id,
                    "x".repeat(TERMINAL_MAX_INPUT_BYTES + 1)
                )
                .unwrap_err()
                .code,
            Code::TERMINAL_VALIDATION
        );
        for _ in 0..16 {
            manager
                .input(
                    authority.clone(),
                    peer.clone(),
                    &id,
                    "x".repeat(TERMINAL_MAX_INPUT_BYTES),
                )
                .unwrap();
        }
        assert_eq!(
            manager
                .input(authority.clone(), peer.clone(), &id, "x".into())
                .unwrap_err()
                .code,
            Code::TERMINAL_BACKPRESSURE
        );
        clock.set(2);
        let pty = spawns.borrow()[0].pty.clone();
        until(|| {
            manager
                .input(alice(), peer.clone(), &id, "accepted".into())
                .is_ok()
        })
        .await;
        until(|| !pty.operations.borrow().is_empty()).await;
        assert_eq!(&*pty.operations.borrow(), &[Op::Write("accepted".into())]);
    })
    .await;
}

#[tokio::test]
async fn bounds_request_results_until_expiry_and_scopes_terminate_keys_per_terminal() {
    run(async {
        let (_temp, mut options, spawns) = options();
        let clock = Rc::new(ManualClock::new(100));
        options.clock = clock.clone();
        options.create_result_ttl = Duration::from_millis(10);
        options.request_results_per_principal = 4;
        let manager = TerminalManager::new(options);
        let first = create(&manager, "a").await;
        let second = create(&manager, "b").await;
        let a = manager
            .terminate(alice(), first.terminal_id.clone(), "stop".into())
            .await
            .unwrap();
        let b = manager
            .terminate(alice(), second.terminal_id.clone(), "stop".into())
            .await
            .unwrap();
        assert_eq!(a.terminal, Some(first.clone()));
        assert_eq!(b.terminal, Some(second));
        assert_eq!(
            manager
                .terminate(alice(), first.terminal_id.clone(), "stop".into())
                .await
                .unwrap(),
            a
        );
        assert_eq!(
            error_code(manager.create(alice(), create_request("c", None)).await),
            Code::TERMINAL_BACKPRESSURE
        );
        clock.advance(10);
        let third = create(&manager, "a").await;
        assert_ne!(third.terminal_id, first.terminal_id);
        assert_eq!(spawns.borrow().len(), 3);
        manager.shutdown();
        manager.shutdown();
        assert!(
            spawns
                .borrow()
                .iter()
                .all(|entry| entry.pty.kills.get() == 1)
        );
    })
    .await;
}

async fn epoch(service: &TerminalService) -> String {
    service
        .list(alice(), None)
        .await
        .unwrap()
        .attachment_epoch
        .unwrap()
}

#[tokio::test]
async fn keeps_the_pty_replay_and_cached_creation_across_facade_retirement() {
    run(async {
        let (_temp, options, spawns) = options();
        let runtime = TerminalRuntime::new(options);
        let first = runtime.service("local").unwrap();
        let request = create_request("one", Some(runtime.id()));
        let created = first.create(alice(), request.clone(), None).await.unwrap();
        let id = &created.terminal.terminal_id;
        let peer = Rc::new(Peer::default());
        let old_epoch = epoch(&first).await;
        first.attach(alice(), peer.clone(), attach_request(id, "client", Some(&old_epoch))).await.unwrap();
        spawns.borrow()[0].output("before");
        until(|| peer.events.borrow().len() == 2).await;
        first.dispose();
        assert!(peer.ids.borrow().is_empty());
        spawns.borrow()[0].output("during");
        let replacement = runtime.service("local").unwrap();
        until(|| replacement.manager().list(&alice())[0].latest_output_sequence == Number(2.0)).await;
        assert_eq!(replacement.create(alice(), request, None).await.unwrap(), created);
        assert_eq!(spawns.borrow()[0].pty.kills.get(), 0);
        assert_eq!(error_code(first.list(alice(), None).await), Code::TERMINAL_UNAVAILABLE);
        assert_eq!(error_code(replacement.attach(alice(), peer.clone(), attach_request(id, "client", Some(&old_epoch))).await), Code::TERMINAL_NOT_ATTACHED);
        let current = epoch(&replacement).await;
        assert_ne!(current, old_epoch);
        peer.take();
        replacement.attach(alice(), peer.clone(), attach_request(id, "client", Some(&current))).await.unwrap();
        assert!(matches!(&peer.take()[0], Message::TerminalAttached { replay, .. } if replay[0].data == "before" && replay[1].data == "during"));
        let other = runtime.service(REMOTE).unwrap();
        assert!(other.list(alice(), None).await.unwrap().terminals.is_empty());
        assert_eq!(error_code(other.rename(alice(), id.clone(), None, None).await), Code::TERMINAL_VALIDATION);
        runtime.shutdown();
        assert_eq!(spawns.borrow()[0].pty.kills.get(), 1);
    }).await;
}

#[cfg(unix)]
#[tokio::test]
async fn real_shell_keeps_its_state_across_disconnect_and_drains_output_before_exit() {
    fn text(peer: &Peer) -> String {
        peer.events
            .borrow()
            .iter()
            .filter_map(|message| match message {
                Message::TerminalOutput { data, .. } => Some(data.as_str()),
                _ => None,
            })
            .collect()
    }

    run(async {
        let temp = tempfile::tempdir().unwrap();
        let mut options = TerminalManagerOptions::new(temp.path().to_str().unwrap().to_owned());
        options.user_shell = Some("/bin/sh".into());
        let runtime = TerminalRuntime::new(options);
        let initial = runtime.service("local").unwrap();
        let created = initial.create(alice(), create_request("shell", Some(runtime.id())), None)
            .await.unwrap().terminal;
        let id = &created.terminal_id;
        let first = Rc::new(Peer::default());
        initial.attach(alice(), first.clone(), attach_request(id, "client", Some(&epoch(&initial).await)))
            .await.unwrap();
        let command = concat!(
            "stty -echo; state=sticky; printf 'ready-%s\\n' \"$state\"; ",
            "while [ ! -e release ]; do sleep 0.01; done; printf 'offline-%s\\n' \"$state\"; ",
            "IFS= read -r line; printf 'final-%s-%s\\n' \"$state\" \"$line\"; exit 7\n",
        );
        initial.input(alice(), first.clone(), id.clone(), command.into()).await.unwrap();
        until(|| text(&first).contains("ready-sticky\r\n")).await;
        let sequence = initial.list(alice(), None).await.unwrap().terminals[0].latest_output_sequence;
        initial.disconnect();
        first.take();
        assert!(first.ids.borrow().is_empty());
        tokio::fs::write(temp.path().join("release"), b"").await.unwrap();
        until(|| initial.manager().list(&alice())[0].latest_output_sequence.0 > sequence.0).await;
        assert!(first.take().is_empty());

        let replacement = runtime.service("local").unwrap();
        let second = Rc::new(Peer::default());
        let mut request = attach_request(id, "client", Some(&epoch(&replacement).await));
        request.after_sequence = sequence;
        replacement.attach(alice(), second.clone(), request).await.unwrap();
        assert!(matches!(
            second.take().as_slice(),
            [Message::TerminalAttached { terminal, replay }]
                if &terminal.terminal_id == id && terminal.process_status == Process::Running
                    && replay.iter().map(|chunk| chunk.data.as_str()).collect::<String>().contains("offline-sticky\r\n")
        ));
        replacement.input(alice(), second.clone(), id.clone(), "resumed\n".into()).await.unwrap();
        until(|| second.events.borrow().iter().any(|event| matches!(
            event, Message::TerminalStatus { terminal } if terminal.process_status == Process::Exited
        ))).await;
        assert!(text(&second).contains("final-sticky-resumed\r\n"));
        assert!(matches!(
            second.take().last(),
            Some(Message::TerminalStatus { terminal }) if terminal.exit_code == Some(Number(7.0))
        ));
        runtime.shutdown();
    }).await;
}

#[tokio::test]
async fn expires_the_facade_subscription_without_killing_the_shell() {
    run(async {
        let (_temp, mut options, spawns) = options();
        let clock = Rc::new(ManualClock::new(1));
        options.clock = clock.clone();
        let runtime = TerminalRuntime::new(options);
        let service = runtime.service("local").unwrap();
        let terminal = service
            .create(alice(), create_request("one", Some(runtime.id())), None)
            .await
            .unwrap()
            .terminal;
        let peer = Rc::new(Peer::default());
        let deadline = TerminalAuthority {
            expires_at_ms: Some(3),
            ..alice()
        };
        let epoch = epoch(&service).await;
        let id = terminal.terminal_id;
        service
            .attach(
                deadline.clone(),
                peer.clone(),
                attach_request(&id, "client", Some(&epoch)),
            )
            .await
            .unwrap();
        clock.set(3);
        until(|| peer.ids.borrow().is_empty()).await;
        assert_eq!(
            service.list(alice(), None).await.unwrap().terminals[0].attachment_status,
            Attachment::Detached
        );
        assert_eq!(
            error_code(service.input(deadline, peer, id, "stale".into()).await),
            Code::TERMINAL_AUTH_EXPIRED
        );
        assert_eq!(spawns.borrow()[0].pty.kills.get(), 0);
    })
    .await;
}

#[tokio::test]
async fn a_lost_create_reply_keeps_the_shell_but_a_late_spawn_on_shutdown_is_killed() {
    run(async {
        for shutdown in [false, true] {
            let (_temp, mut options, _) = options();
            let entered = Rc::new(Notify::new());
            let release = Rc::new(Notify::new());
            let pty = Rc::new(FakePty::default());
            let (output, events) = mpsc::channel(1);
            let events = Rc::new(RefCell::new(Some(events)));
            options.spawn_pty = Some(Rc::new({
                let (entered, release, pty) = (entered.clone(), release.clone(), pty.clone());
                move |_| {
                    let (entered, release, pty) = (entered.clone(), release.clone(), pty.clone());
                    let events = events.borrow_mut().take().unwrap();
                    Box::pin(async move {
                        entered.notify_one();
                        release.notified().await;
                        Ok(SpawnedPty {
                            control: pty,
                            events,
                        })
                    })
                }
            }));
            let runtime = TerminalRuntime::new(options);
            let service = runtime.service("local").unwrap();
            let request = create_request("one", Some(runtime.id()));
            let reply = tokio::task::spawn_local({
                let service = service.clone();
                let request = request.clone();
                async move { service.create(alice(), request, None).await }
            });
            timeout(Duration::from_secs(5), entered.notified())
                .await
                .unwrap();
            reply.abort();
            assert!(reply.await.unwrap_err().is_cancelled());
            if shutdown {
                runtime.shutdown();
            } else {
                service.dispose();
            }
            release.notify_one();
            if shutdown {
                until(|| pty.kills.get() == 1).await;
                assert!(service.manager().list(&alice()).is_empty());
                assert!(runtime.service("local").is_err());
            } else {
                let retry = runtime
                    .service("local")
                    .unwrap()
                    .create(alice(), request, None)
                    .await
                    .unwrap();
                assert_eq!(retry.terminal.process_status, Process::Running);
                assert_eq!(pty.kills.get(), 0);
            }
            drop(output);
        }
    })
    .await;
}

#[tokio::test]
async fn failed_creates_bind_the_original_path_and_reject_stale_targets() {
    run(async {
        let (_temp, options, spawns) = options();
        let runtime = TerminalRuntime::new(options);
        let service = runtime.service("local").unwrap();
        let mut request = create_request("one", Some("stale"));
        assert_eq!(
            error_code(service.create(alice(), request.clone(), None).await),
            Code::TERMINAL_RUNTIME_CHANGED
        );
        request.expected_terminal_runtime_id = Some(runtime.id().into());
        request.requested_initial_working_directory = Some("missing".into());
        let failure = service
            .create(alice(), request.clone(), None)
            .await
            .unwrap_err();
        assert_eq!(failure.downcast_ref::<TerminalError>().unwrap().status, 422);
        request.requested_initial_working_directory = None;
        let retarget = service.create(alice(), request, None).await.unwrap_err();
        assert_eq!(
            retarget.downcast_ref::<TerminalError>().unwrap().status,
            409
        );
        assert!(spawns.borrow().is_empty());
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let options = ExecutorCallOptions {
            signal: Some(cancelled),
            ..Default::default()
        };
        assert!(service.list(alice(), Some(options)).await.is_err());
    })
    .await;
}
