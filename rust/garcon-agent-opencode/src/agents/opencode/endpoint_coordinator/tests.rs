use garcon_js::json::Opaque;
use tokio::task::LocalSet;

use super::*;
use crate::{agents::opencode::sdk_client::OpenCodeSdkClient, js::shared_error};

#[derive(Default)]
struct Logger(RefCell<Vec<String>>);

impl AgentLogger for Logger {
    fn debug(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn info(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
    fn warn(&self, message: &str, _: Option<&IndexMap<String, Opaque>>) {
        self.0.borrow_mut().push(message.to_owned());
    }
    fn error(&self, _: &str, _: Option<&IndexMap<String, Opaque>>) {}
}

fn instance() -> Rc<OpenCodeInstance> {
    Rc::new(OpenCodeInstance {
        client: Rc::new(OpenCodeSdkClient::new("http://127.0.0.1:9911")),
        base_url: None,
        server: None,
        close: None,
    })
}

fn coordinator(
    ensure_unlocked: EnsureUnlocked,
    logger: Rc<Logger>,
) -> Rc<OpenCodeEndpointCoordinator> {
    OpenCodeEndpointCoordinator::new(OpenCodeEndpointCoordinatorOptions {
        assert_available: Rc::new(|| Ok(())),
        ensure_unlocked,
        logger,
        on_activity: Rc::new(|| {}),
    })
}

fn immediately_ready(instance: Rc<OpenCodeInstance>) -> EnsureUnlocked {
    Rc::new(move || {
        let instance = instance.clone();
        async { Ok(instance) }.boxed_local()
    })
}

#[tokio::test]
async fn transitions_enter_in_invocation_order_even_when_awaited_out_of_order() {
    LocalSet::new()
        .run_until(async {
            let coordinator = coordinator(immediately_ready(instance()), Rc::default());
            let (unblock, blocked) = oneshot::channel::<()>();
            let (entering, entered) = oneshot::channel::<()>();
            let first = coordinator.run_transition(|| async move {
                entering.send(()).expect("first transition observed");
                blocked.await?;
                Ok(1)
            });
            let mut second = coordinator.run_transition(|| async { Ok(2) });
            entered.await.expect("first transition entered");
            assert!(futures::poll!(&mut second).is_pending());
            unblock.send(()).expect("release first transition");
            assert_eq!(second.await.expect("second transition"), 2);
            assert_eq!(first.await.expect("first transition"), 1);
        })
        .await;
}

#[tokio::test]
async fn cancellation_while_a_client_is_being_acquired_does_not_leak_a_lease() {
    LocalSet::new()
        .run_until(async {
            let (acquiring, acquired) = oneshot::channel::<()>();
            let (release, released) = oneshot::channel::<()>();
            let startup = RefCell::new(Some(
                async move {
                    acquiring.send(()).expect("acquisition started");
                    released.await?;
                    Ok(instance())
                }
                .boxed_local(),
            ));
            let coordinator = coordinator(
                Rc::new(move || startup.take().expect("one acquisition")),
                Rc::default(),
            );
            let signal = AbortSignal::new();
            let pending = spawn_local({
                let coordinator = coordinator.clone();
                let signal = signal.clone();
                async move {
                    coordinator
                        .with_client_lease(|_| async { panic!("aborted operation") }, Some(signal))
                        .await
                }
            });
            acquired.await.expect("provider startup active");
            signal.abort(shared_error("Error", "lease cancelled"));
            let result: ExecutorResult<()> =
                pending.await.expect("operation settles on cancellation");
            assert_eq!(
                result.expect_err("lease refused").to_string(),
                "lease cancelled"
            );
            release.send(()).expect("startup can still settle");
            coordinator
                .run_transition(|| async { Ok(()) })
                .await
                .expect("transition barrier");
            assert!(coordinator.idle());
        })
        .await;
}

#[tokio::test]
async fn a_cancelled_fork_uses_the_original_client_to_remove_the_late_created_session() {
    LocalSet::new()
        .run_until(async {
            let origin = instance();
            let current = Rc::new(RefCell::new(origin.clone()));
            let coordinator = coordinator(
                Rc::new({
                    let current = current.clone();
                    move || immediately_ready(current.borrow().clone())()
                }),
                Rc::default(),
            );
            let (dispatched, sending) = oneshot::channel::<()>();
            let (response, responded) = oneshot::channel::<()>();
            let (discarded, discarded_fork) = oneshot::channel::<()>();
            let signal = AbortSignal::new();
            let caller = signal.clone();
            let origin_client = origin.client.clone();
            let fork = spawn_local({
                let coordinator = coordinator.clone();
                async move {
                    coordinator
                        .fork_session(
                            " source ",
                            OpenCodeForkOptions {
                                project_path: Some(" /fixture ".to_owned()),
                                message_id: Some("anchor".to_owned()),
                                signal: Some(caller),
                            },
                            |request| async move {
                                assert_eq!(request.operation, OpenCodeRequest::SessionFork);
                                assert!(request.control.signal.is_none());
                                assert!(matches!(
                                    request.control.timeout,
                                    OpenCodeRequestTimeout::Unbounded
                                ));
                                assert_eq!(request.parameters["sessionID"], "source");
                                assert_eq!(request.parameters["messageID"], "anchor");
                                assert_eq!(request.parameters["directory"], "/fixture");
                                dispatched.send(()).expect("fork dispatched");
                                responded.await?;
                                Ok(OpenCodeSdkResult::success(json!({"id":" late-id "}), 200))
                            },
                            |client, id, scope| async move {
                                assert!(Rc::ptr_eq(&client, &origin_client));
                                assert_eq!(scope.directory.as_deref(), Some("/fixture"));
                                assert_eq!(id, "late-id");
                                discarded.send(()).expect("observed provider cleanup");
                                Ok(())
                            },
                        )
                        .await
                }
            });
            sending.await.expect("fork is in flight");
            assert!(!coordinator.idle());
            signal.abort(shared_error("Error", "caller disconnected"));
            current.replace(instance());
            response
                .send(())
                .expect("native request is still protected");
            assert_eq!(
                fork.await
                    .expect("fork task")
                    .expect_err("cancelled fork")
                    .to_string(),
                "caller disconnected"
            );
            discarded_fork
                .await
                .expect("late-created session was removed");
            assert!(coordinator.idle());
        })
        .await;
}

#[tokio::test(start_paused = true)]
async fn shutdown_grace_does_not_cancel_protected_native_cleanup() {
    LocalSet::new()
        .run_until(async {
            let logger = Rc::<Logger>::default();
            let coordinator = coordinator(immediately_ready(instance()), logger.clone());
            let (release, released) = oneshot::channel::<()>();
            let (cleaned, cleanup) = oneshot::channel::<()>();
            let operation = coordinator.run_protected_native_cleanup(|| async move {
                released.await?;
                cleaned.send(()).expect("cleanup observed");
                Ok(())
            });
            drop(operation);
            coordinator.wait_for_protected_native_work(50.0, || 0).await;
            assert_eq!(
                *logger.0.borrow(),
                ["OpenCode shutdown abandoned native session cleanup"]
            );
            release
                .send(())
                .expect("protected operation is still running");
            cleanup.await.expect("native cleanup completed");
            coordinator.wait_for_protected_native_work(50.0, || 0).await;
            assert_eq!(logger.0.borrow().len(), 1);
        })
        .await;
}
