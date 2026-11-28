use std::{cell::RefCell, rc::Rc};

use garcon_interface::{host::AgentLogger, resources::ExecutorResult};

use crate::app_server::{
    client::{CodexAppServerClient, CodexAppServerEvent},
    protocol::{JsonRpcNotification, JsonRpcServerRequest},
};

use super::wire_client;

pub enum BufferedClientEvent {
    Notification(JsonRpcNotification),
    ServerRequest(JsonRpcServerRequest),
}

type Dispatch = dyn Fn(&CodexAppServerClient, BufferedClientEvent) -> ExecutorResult<()>;

enum Admission {
    Buffering(Vec<BufferedClientEvent>),
    Active,
}

#[derive(Clone)]
pub struct CodexClientEvents {
    client: CodexAppServerClient,
    admission: Rc<RefCell<Admission>>,
    dispatch: Rc<Dispatch>,
}

impl CodexClientEvents {
    pub fn buffer(
        client: &CodexAppServerClient,
        logger: Rc<dyn AgentLogger>,
        dispatch: impl Fn(&CodexAppServerClient, BufferedClientEvent) -> ExecutorResult<()> + 'static,
        on_exit: impl Fn(&CodexAppServerClient, i32) -> ExecutorResult<()> + 'static,
    ) -> Self {
        let events = Self {
            client: client.clone(),
            admission: Rc::new(RefCell::new(Admission::Buffering(Vec::new()))),
            dispatch: Rc::new(dispatch),
        };
        let admission = events.admission.clone();
        let dispatch = events.dispatch.clone();
        wire_client(client, logger, move |client, event| {
            let event = match event {
                CodexAppServerEvent::Notification(note) => {
                    BufferedClientEvent::Notification(note.clone())
                }
                CodexAppServerEvent::ServerRequest(request) => {
                    BufferedClientEvent::ServerRequest(request.clone())
                }
                CodexAppServerEvent::Exit(code) => return on_exit(client, *code),
                _ => return Ok(()),
            };
            {
                let mut admission = admission.borrow_mut();
                if let Admission::Buffering(events) = &mut *admission {
                    events.push(event);
                    return Ok(());
                }
            }
            dispatch(client, event)
        });
        events
    }

    pub fn release(&self) -> ExecutorResult<()> {
        let events = {
            let mut state = self.admission.borrow_mut();
            match &mut *state {
                Admission::Buffering(events) => {
                    let buffered = std::mem::take(events);
                    *state = Admission::Active;
                    buffered
                }
                Admission::Active => return Ok(()),
            }
        };
        for event in events {
            (self.dispatch)(&self.client, event)?;
        }
        Ok(())
    }

    pub fn discard(&self) {
        *self.admission.borrow_mut() = Admission::Active;
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{cell::Cell, os::unix::fs::PermissionsExt, time::Duration};

    use futures::FutureExt;
    use serde_json::Value;
    use tokio::task::LocalSet;

    use crate::app_server::{
        cli::{CodexCommandSource, ResolvedCodexCli},
        client::CodexAppServerClientOptions,
        runtime_support::NoopLogger,
    };

    use super::*;

    #[tokio::test]
    async fn buffers_early_notifications_and_requests_in_wire_order_until_activation() {
        LocalSet::new()
            .run_until(async {
                let directory = tempfile::tempdir().unwrap();
                let binary = directory.path().join("fake-codex");
                let script = concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/tests/oracles/app-server-fixture.ts"
                );
                tokio::fs::write(
                    &binary,
                    format!(
                        "#!/bin/sh\nexec bun '{}' \"$@\"\n",
                        script.replace('\'', "'\\''")
                    ),
                )
                .await
                .unwrap();
                tokio::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755))
                    .await
                    .unwrap();
                let client = CodexAppServerClient::new(CodexAppServerClientOptions::new(Rc::new(
                    move |_| {
                        let command = binary.to_str().unwrap().to_owned();
                        async move {
                            Ok(ResolvedCodexCli {
                                command,
                                source: CodexCommandSource::Path,
                            })
                        }
                        .boxed_local()
                    },
                )));
                let methods = Rc::new(RefCell::new(Vec::new()));
                let exit = Rc::new(Cell::new(None));
                let events = CodexClientEvents::buffer(
                    &client,
                    Rc::new(NoopLogger),
                    {
                        let methods = methods.clone();
                        move |_, event| {
                            let method = match event {
                                BufferedClientEvent::Notification(note) => note.method,
                                BufferedClientEvent::ServerRequest(request) => request.method,
                            };
                            methods.borrow_mut().push(method);
                            Ok(())
                        }
                    },
                    {
                        let exit = exit.clone();
                        move |_, code| {
                            exit.set(Some(code));
                            Ok(())
                        }
                    },
                );
                client
                    .request("send-events", None::<&Value>, Some(Duration::from_secs(3)))
                    .await
                    .unwrap();
                assert!(methods.borrow().is_empty());
                events.release().unwrap();
                events.release().unwrap();
                assert_eq!(methods.borrow().as_slice(), ["one", "two", "approve"]);
                client
                    .request("send-events", None::<&Value>, Some(Duration::from_secs(3)))
                    .await
                    .unwrap();
                assert_eq!(
                    methods.borrow().as_slice(),
                    ["one", "two", "approve", "one", "two", "approve"]
                );

                let dispatched = Rc::new(Cell::new(0));
                let rejected = CodexClientEvents::buffer(
                    &client,
                    Rc::new(NoopLogger),
                    {
                        let dispatched = dispatched.clone();
                        move |_, _| {
                            dispatched.set(dispatched.get() + 1);
                            Ok(())
                        }
                    },
                    |_, _| Ok(()),
                );
                client
                    .request("send-events", None::<&Value>, Some(Duration::from_secs(3)))
                    .await
                    .unwrap();
                rejected.discard();
                rejected.release().unwrap();
                assert_eq!(dispatched.get(), 0);
                client
                    .request("send-events", None::<&Value>, Some(Duration::from_secs(3)))
                    .await
                    .unwrap();
                assert_eq!(dispatched.get(), 3);

                client.shutdown().await.unwrap();
                assert_eq!(exit.get(), Some(0));
            })
            .await;
    }
}
