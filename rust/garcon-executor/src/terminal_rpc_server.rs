//! Ports `server/remote/server/terminal-rpc-server.ts`.

use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};
use std::time::Duration;

use garcon_base::terminal_framing::expand_terminal_message_for_delivery;
use garcon_contract::terminal::{
    TerminalErrorCode as Code, TerminalStreamClientMessage, TerminalStreamClientPayload as Request,
    TerminalStreamServerMessage, TerminalStreamServerPayload as Message,
    parse_terminal_create_request, parse_terminal_rename_request,
    parse_terminal_stream_client_message, parse_terminal_terminate_request,
};
use garcon_contract::terminal_error::TerminalError;
use garcon_interface::terminals::{
    ExecutionTerminalService, TerminalAttachKind, TerminalAttachRequest, TerminalAuthority,
    TerminalPeer,
};
use garcon_js::{
    clock::{Clock, SystemClock},
    json::as_number,
};
use garcon_link::message_session::SessionError;
use garcon_link::rpc::{ExecutorRpc, RpcResult};
use garcon_link::terminal_protocol::{TerminalNotification, validate_terminal_rpc};
use indexmap::{IndexMap, IndexSet};
use serde_json::Value;
use tokio::task::JoinHandle;

use crate::executor_rpc_server::{reply, shared_error};

const MAX_ATTACHMENTS: usize = 256;

struct Attachment {
    id: String,
    authority: TerminalAuthority,
    terminal_id: String,
    owner: Weak<TerminalRpcServer>,
    terminals: RefCell<IndexSet<String>>,
    timer: RefCell<Option<JoinHandle<()>>>,
    active: Cell<bool>,
}

impl TerminalPeer for Attachment {
    fn connection_id(&self) -> &str {
        &self.id
    }

    fn owned_terminal_ids(&self) -> &RefCell<IndexSet<String>> {
        &self.terminals
    }

    fn send_terminal_message(&self, message: TerminalStreamServerMessage) {
        if !self.active.get() {
            return;
        }
        let Some(owner) = self.owner.upgrade() else {
            return;
        };
        let Some(rpc) = owner.rpc.upgrade() else {
            return;
        };
        let terminated = matches!(&message.payload, Message::TerminalTerminated { .. });
        let delivered = expand_terminal_message_for_delivery(&message).is_ok_and(|parts| {
            parts.into_iter().all(|message| {
                self.active.get()
                    && rpc.publish_terminal(&TerminalNotification {
                        attachment_id: self.id.clone(),
                        message,
                    })
            })
        });
        if !delivered && self.active.get() {
            owner.detach(&self.id);
            rpc.publish_terminal_control(&TerminalNotification {
                attachment_id: self.id.clone(),
                message: TerminalStreamServerMessage {
                    attachment_id: None,
                    payload: Message::TerminalError {
                        terminal_id: Some(self.terminal_id.clone()),
                        code: Code::TERMINAL_BACKPRESSURE,
                        message: "Terminal output detached; reattach to resume.".into(),
                    },
                },
            });
        } else if terminated {
            owner.detach(&self.id);
        }
    }
}

pub(crate) struct TerminalRpcServer {
    service: Rc<dyn ExecutionTerminalService>,
    rpc: Weak<ExecutorRpc>,
    attachments: RefCell<IndexMap<String, Rc<Attachment>>>,
}

impl TerminalRpcServer {
    pub(crate) fn new(
        service: Rc<dyn ExecutionTerminalService>,
        rpc: &Rc<ExecutorRpc>,
    ) -> Rc<Self> {
        Rc::new(Self {
            service,
            rpc: Rc::downgrade(rpc),
            attachments: RefCell::default(),
        })
    }

    pub(crate) async fn handle(self: &Rc<Self>, method: &str, request: &Value) -> RpcResult {
        validate_terminal_rpc(method, request).map_err(shared_error)?;
        let authority = &request["authority"];
        let authority = TerminalAuthority {
            key: authority["key"]
                .as_str()
                .ok_or_else(invalid_request)?
                .to_owned(),
            expires_at_ms: as_number(&authority["expiresAtMs"]).map(|value| value as u64),
        };
        match method {
            "terminals.list" => reply(self.service.list(authority, None).await),
            "terminals.create" => {
                let request = parse_terminal_create_request(request).ok_or_else(invalid_request)?;
                reply(self.service.create(authority, request, None).await)
            }
            "terminals.rename" => {
                let request = parse_terminal_rename_request(request).ok_or_else(invalid_request)?;
                reply(
                    self.service
                        .rename(authority, request.terminal_id, request.title, None)
                        .await,
                )
            }
            "terminals.terminate" => {
                let request =
                    parse_terminal_terminate_request(request).ok_or_else(invalid_request)?;
                reply(
                    self.service
                        .terminate(authority, request.terminal_id, request.request_id, None)
                        .await,
                )
            }
            _ => {
                let TerminalStreamClientMessage {
                    payload,
                    attachment_id,
                } = parse_terminal_stream_client_message(request).ok_or_else(invalid_request)?;
                let id = attachment_id.ok_or_else(invalid_request)?;
                match payload {
                    Request::TerminalAttach {
                        terminal_id,
                        client_id,
                        after_sequence,
                        intent,
                        attachment_epoch,
                    } => {
                        self.attach(
                            authority,
                            id.clone(),
                            TerminalAttachRequest {
                                r#type: TerminalAttachKind::TerminalAttach,
                                terminal_id,
                                client_id,
                                after_sequence,
                                intent,
                                attachment_epoch,
                                attachment_id: Some(id),
                            },
                        )
                        .await?;
                    }
                    Request::TerminalInput { terminal_id, data } => {
                        let peer = self.require_attachment(&id, &authority, &terminal_id)?;
                        self.service
                            .input(authority, peer, terminal_id, data)
                            .await
                            .map_err(Rc::from)?;
                    }
                    Request::TerminalResize {
                        terminal_id,
                        cols,
                        rows,
                    } => {
                        let peer = self.require_attachment(&id, &authority, &terminal_id)?;
                        self.service
                            .resize(authority, peer, terminal_id, cols, rows)
                            .await
                            .map_err(Rc::from)?;
                    }
                    Request::TerminalDetach { terminal_id } => {
                        self.require_attachment(&id, &authority, &terminal_id)?;
                        self.detach(&id);
                    }
                }
                Ok(None)
            }
        }
    }

    async fn attach(
        self: &Rc<Self>,
        authority: TerminalAuthority,
        id: String,
        request: TerminalAttachRequest,
    ) -> Result<(), SessionError> {
        let peer = {
            let mut attachments = self.attachments.borrow_mut();
            if attachments.contains_key(&id) || attachments.len() >= MAX_ATTACHMENTS {
                return Err(shared_error(TerminalError::with_status(
                    Code::TERMINAL_BACKPRESSURE,
                    "Terminal attachment budget exhausted.",
                    429,
                )));
            }
            let peer = Rc::new(Attachment {
                id: id.clone(),
                authority: authority.clone(),
                terminal_id: request.terminal_id.clone(),
                owner: Rc::downgrade(self),
                terminals: RefCell::default(),
                timer: RefCell::default(),
                active: Cell::new(true),
            });
            attachments.insert(id.clone(), Rc::clone(&peer));
            peer
        };
        if let Some(deadline) = authority.expires_at_ms {
            if i128::from(deadline) <= i128::from(SystemClock.now_ms()) {
                self.detach(&id);
            } else {
                let owner = Rc::downgrade(self);
                let id = id.clone();
                *peer.timer.borrow_mut() = Some(tokio::task::spawn_local(async move {
                    loop {
                        let delay = i128::from(deadline) - i128::from(SystemClock.now_ms());
                        if delay <= 0 {
                            if let Some(owner) = owner.upgrade() {
                                owner.detach(&id);
                            }
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(delay.min(2_147_000_000) as u64))
                            .await;
                    }
                }));
            }
        }
        let result = self.service.attach(authority, peer, request).await;
        if let Err(error) = &result
            && !error
                .downcast_ref::<TerminalError>()
                .is_some_and(|error| error.code == Code::TERMINAL_TAKEOVER_REQUIRED)
        {
            self.detach(&id);
        }
        result.map_err(Rc::from)
    }

    fn require_attachment(
        &self,
        id: &str,
        authority: &TerminalAuthority,
        terminal_id: &str,
    ) -> Result<Rc<dyn TerminalPeer>, SessionError> {
        self.attachments
            .borrow()
            .get(id)
            .filter(|peer| &peer.authority == authority && peer.terminal_id == terminal_id)
            .map(|peer| Rc::clone(peer) as Rc<dyn TerminalPeer>)
            .ok_or_else(|| {
                shared_error(TerminalError::with_status(
                    Code::TERMINAL_NOT_ATTACHED,
                    "Terminal attachment expired.",
                    409,
                ))
            })
    }

    fn detach(&self, id: &str) {
        let peer = self.attachments.borrow_mut().shift_remove(id);
        if let Some(peer) = peer {
            self.detach_peer(peer);
        }
    }

    fn detach_peer(&self, peer: Rc<Attachment>) {
        peer.active.set(false);
        if let Some(timer) = peer.timer.borrow_mut().take() {
            timer.abort();
        }
        let authority = peer.authority.clone();
        self.service.detach_peer(authority, peer);
    }

    pub(crate) fn disconnect(&self) {
        for (_, peer) in self.attachments.take() {
            self.detach_peer(peer);
        }
    }
}

fn invalid_request() -> SessionError {
    shared_error(TerminalError::new(
        Code::TERMINAL_VALIDATION,
        "Invalid terminal RPC request.",
    ))
}
