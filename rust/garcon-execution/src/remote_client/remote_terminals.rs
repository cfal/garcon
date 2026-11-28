//! Ports `server/remote/client/remote-terminals.ts`.

use std::{cell::RefCell, rc::Rc};

use async_trait::async_trait;
use garcon_contract::{
    terminal::{
        TerminalCreateRequest, TerminalCreateResponse, TerminalErrorCode, TerminalListResponse,
        TerminalRenameResponse, TerminalStreamServerMessage, TerminalStreamServerPayload,
        TerminalTerminateResponse, parse_terminal_create_response, parse_terminal_list_response,
        parse_terminal_rename_response, parse_terminal_terminate_response, terminal_id_for_message,
    },
    terminal_error::TerminalError,
    terminal_identity::{TerminalReference, parse_terminal_reference},
};
use garcon_interface::{
    resources::{ExecutorCallOptions, ExecutorResult},
    terminals::{ExecutionTerminalService, TerminalAttachRequest, TerminalAuthority, TerminalPeer},
};
use garcon_js::{Number, json::Opaque};
use garcon_link::{
    rpc::{ExecutorRpc, RpcCallOptions},
    rpc_lane::RpcLane,
    terminal_protocol::TerminalNotification,
};
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use super::{
    sessions::{HeldCallOptions, RemoteSessions, not_dispatched},
    wire::{encode, own_rpc_error},
};

struct Attachment {
    authority: TerminalAuthority,
    peer: Rc<dyn TerminalPeer>,
    terminal_id: String,
    rpc: RefCell<Option<Rc<ExecutorRpc>>>,
}

pub(super) struct RemoteTerminalService {
    sessions: Rc<RemoteSessions>,
    attachments: RefCell<IndexMap<String, Rc<Attachment>>>,
}

impl RemoteTerminalService {
    pub fn new(sessions: Rc<RemoteSessions>) -> Self {
        Self {
            sessions,
            attachments: RefCell::default(),
        }
    }

    pub fn receive(
        &self,
        frame: TerminalNotification,
        rpc: &Rc<ExecutorRpc>,
    ) -> ExecutorResult<()> {
        let id = frame.attachment_id;
        let Some(attachment) = self.attachments.borrow().get(&id).cloned() else {
            return Ok(());
        };
        if !attachment
            .rpc
            .borrow()
            .as_ref()
            .is_some_and(|owner| Rc::ptr_eq(owner, rpc))
        {
            return Ok(());
        }
        let terminal_id = &attachment.terminal_id;
        if terminal_id_for_message(&frame.message).as_ref() != Some(terminal_id) {
            return Err("Terminal notification target mismatch".into());
        }
        let terminated = matches!(
            frame.message.payload,
            TerminalStreamServerPayload::TerminalTerminated { .. }
        );
        match &frame.message.payload {
            TerminalStreamServerPayload::TerminalAttached { .. } => {
                attachment
                    .peer
                    .owned_terminal_ids()
                    .borrow_mut()
                    .insert(terminal_id.clone());
            }
            TerminalStreamServerPayload::TerminalTakenOver { .. }
            | TerminalStreamServerPayload::TerminalTerminated { .. } => {
                release_ownership(&attachment);
            }
            _ => {}
        }
        attachment.peer.send_terminal_message(frame.message);
        if terminated {
            self.detach(&id);
        }
        Ok(())
    }

    fn find(
        &self,
        authority: &TerminalAuthority,
        peer: &Rc<dyn TerminalPeer>,
        terminal_id: &str,
    ) -> ExecutorResult<(String, Rc<ExecutorRpc>)> {
        for (id, attachment) in self.attachments.borrow().iter() {
            if attachment.terminal_id == terminal_id
                && attachment.authority.key == authority.key
                && Rc::ptr_eq(&attachment.peer, peer)
                && let Some(rpc) = attachment.rpc.borrow().as_ref()
            {
                return Ok((id.clone(), rpc.clone()));
            }
        }
        Err(not_dispatched("Terminal attachment is unavailable").into())
    }

    fn detach(&self, id: &str) {
        let Some(attachment) = self.attachments.borrow_mut().shift_remove(id) else {
            return;
        };
        release_ownership(&attachment);
        if let Some(rpc) = attachment.rpc.borrow().as_ref()
            && let Ok(request) = encode(AttachmentCall {
                authority: &attachment.authority,
                attachment_id: id,
                terminal_id: &attachment.terminal_id,
                action: AttachmentAction::Detach,
            })
        {
            // A retired transport already released its worker-side attachments.
            let _ = rpc.detach_terminal(request);
        }
    }
}

#[derive(Serialize)]
struct AuthorityCall<T> {
    #[serde(flatten)]
    request: T,
    authority: TerminalAuthority,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachCall {
    #[serde(flatten)]
    request: TerminalAttachRequest,
    authority: TerminalAuthority,
    attachment_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentCall<'a> {
    authority: &'a TerminalAuthority,
    attachment_id: &'a str,
    terminal_id: &'a str,
    #[serde(flatten)]
    action: AttachmentAction,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum AttachmentAction {
    #[serde(rename = "terminal-input")]
    Input { data: String },
    #[serde(rename = "terminal-resize")]
    Resize { cols: Number, rows: Number },
    #[serde(rename = "terminal-detach")]
    Detach,
}

#[async_trait(?Send)]
impl ExecutionTerminalService for RemoteTerminalService {
    async fn list(
        &self,
        authority: TerminalAuthority,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TerminalListResponse> {
        #[derive(Serialize)]
        struct List {
            authority: TerminalAuthority,
        }
        let options = HeldCallOptions::from(options);
        let held = self.sessions.acquire(RpcLane::Primary, &options).await?;
        let reply = held
            .backing
            .rpc
            .call(
                "",
                "terminals.list",
                encode(List { authority })?,
                held.rpc_options(&options),
            )
            .await
            .map_err(own_rpc_error)?;
        let parse = |reply: &Opaque| {
            let response = parse_terminal_list_response(reply)?;
            let runtime_id = response
                .terminal_runtime_id
                .as_deref()
                .filter(|id| !id.is_empty())?;
            response
                .attachment_epoch
                .as_deref()
                .filter(|id| !id.is_empty())?;
            response
                .terminals
                .iter()
                .all(|terminal| {
                    reference(&terminal.terminal_id).is_some_and(|reference| {
                        reference.executor_id == held.backing.info.executor_id
                            && reference.terminal_runtime_id == runtime_id
                    })
                })
                .then_some(response)
        };
        reply.as_ref().and_then(parse).ok_or_else(|| {
            TerminalError::with_status(
                TerminalErrorCode::TERMINAL_INTERNAL,
                "Invalid terminal inventory.",
                502,
            )
            .into()
        })
    }

    async fn create(
        &self,
        authority: TerminalAuthority,
        request: TerminalCreateRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TerminalCreateResponse> {
        let expected_runtime = request.expected_terminal_runtime_id.clone();
        let options = HeldCallOptions::from(options);
        let held = self.sessions.acquire(RpcLane::Primary, &options).await?;
        let reply = held
            .backing
            .rpc
            .call(
                "",
                "terminals.create",
                encode(AuthorityCall { request, authority })?,
                held.rpc_options(&options),
            )
            .await
            .map_err(own_rpc_error)?;
        reply
            .as_deref()
            .and_then(parse_terminal_create_response)
            .filter(|response| {
                reference(&response.terminal.terminal_id).is_some_and(|reference| {
                    reference.executor_id == held.backing.info.executor_id
                        && Some(reference.terminal_runtime_id.as_str())
                            == expected_runtime.as_deref()
                })
            })
            .ok_or_else(|| {
                invalid_mutation("Invalid terminal create response. Refresh the terminal list.")
                    .into()
            })
    }

    async fn rename(
        &self,
        authority: TerminalAuthority,
        terminal_id: String,
        title: Option<String>,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TerminalRenameResponse> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Rename<'a> {
            authority: TerminalAuthority,
            terminal_id: &'a str,
            title: Option<String>,
        }
        let request = encode(Rename {
            authority,
            terminal_id: &terminal_id,
            title,
        })?;
        let reply = self
            .sessions
            .call("", "terminals.rename", request, options.into())
            .await?;
        reply
            .as_deref()
            .and_then(parse_terminal_rename_response)
            .filter(|response| response.terminal_id == terminal_id)
            .ok_or_else(|| invalid_mutation("Invalid terminal rename response.").into())
    }

    async fn terminate(
        &self,
        authority: TerminalAuthority,
        terminal_id: String,
        request_id: String,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TerminalTerminateResponse> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Terminate<'a> {
            authority: TerminalAuthority,
            terminal_id: &'a str,
            request_id: String,
        }
        let request = encode(Terminate {
            authority,
            terminal_id: &terminal_id,
            request_id,
        })?;
        let reply = self
            .sessions
            .call("", "terminals.terminate", request, options.into())
            .await?;
        reply
            .as_deref()
            .and_then(parse_terminal_terminate_response)
            .filter(|response| response.terminal_id == terminal_id)
            .ok_or_else(|| invalid_mutation("Invalid terminal terminate response.").into())
    }

    async fn attach(
        &self,
        authority: TerminalAuthority,
        peer: Rc<dyn TerminalPeer>,
        mut request: TerminalAttachRequest,
    ) -> ExecutorResult<()> {
        self.sessions.latest()?;
        if self.attachments.borrow().len() >= 256 {
            return Err(TerminalError::with_status(
                TerminalErrorCode::TERMINAL_BACKPRESSURE,
                "Terminal attachment budget exhausted.",
                429,
            )
            .into());
        }
        let id = Uuid::new_v4().to_string();
        let attachment = Rc::new(Attachment {
            authority: authority.clone(),
            peer,
            terminal_id: request.terminal_id.clone(),
            rpc: RefCell::default(),
        });
        self.attachments
            .borrow_mut()
            .insert(id.clone(), attachment.clone());
        let options = HeldCallOptions::default();
        request.attachment_id = None;
        let result = async {
            let held = self.sessions.acquire(RpcLane::Primary, &options).await?;
            if !self
                .attachments
                .borrow()
                .get(&id)
                .is_some_and(|current| Rc::ptr_eq(current, &attachment))
            {
                return Ok(());
            }
            let rpc = &held.backing.rpc;
            attachment.rpc.replace(Some(rpc.clone()));
            let input = encode(AttachCall {
                request,
                authority,
                attachment_id: id.clone(),
            })?;
            rpc.call("", "terminals.attach", input, held.rpc_options(&options))
                .await
                .map_err(own_rpc_error)?;
            Ok::<(), Box<dyn std::error::Error>>(())
        }
        .await;
        if let Err(error) = &result
            && !error
                .downcast_ref::<TerminalError>()
                .is_some_and(|error| error.code == TerminalErrorCode::TERMINAL_TAKEOVER_REQUIRED)
        {
            self.detach(&id);
        }
        result
    }

    async fn input(
        &self,
        authority: TerminalAuthority,
        peer: Rc<dyn TerminalPeer>,
        terminal_id: String,
        data: String,
    ) -> ExecutorResult<()> {
        let (id, rpc) = self.find(&authority, &peer, &terminal_id)?;
        let request = encode(AttachmentCall {
            authority: &authority,
            attachment_id: &id,
            terminal_id: &terminal_id,
            action: AttachmentAction::Input { data },
        })?;
        rpc.call("", "terminals.input", request, RpcCallOptions::default())
            .await
            .map_err(own_rpc_error)?;
        Ok(())
    }

    async fn resize(
        &self,
        authority: TerminalAuthority,
        peer: Rc<dyn TerminalPeer>,
        terminal_id: String,
        cols: Number,
        rows: Number,
    ) -> ExecutorResult<()> {
        let (id, rpc) = self.find(&authority, &peer, &terminal_id)?;
        let request = encode(AttachmentCall {
            authority: &authority,
            attachment_id: &id,
            terminal_id: &terminal_id,
            action: AttachmentAction::Resize { cols, rows },
        })?;
        rpc.call("", "terminals.resize", request, RpcCallOptions::default())
            .await
            .map_err(own_rpc_error)?;
        Ok(())
    }

    fn detach_peer(&self, authority: TerminalAuthority, peer: Rc<dyn TerminalPeer>) {
        let ids: Vec<_> = self
            .attachments
            .borrow()
            .iter()
            .filter(|(_, attachment)| {
                Rc::ptr_eq(&attachment.peer, &peer) && attachment.authority.key == authority.key
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            self.detach(&id);
        }
    }

    fn disconnect(&self) {
        for (_, attachment) in self.attachments.take() {
            release_ownership(&attachment);
            attachment
                .peer
                .send_terminal_message(TerminalStreamServerMessage {
                    payload: TerminalStreamServerPayload::TerminalError {
                        terminal_id: Some(attachment.terminal_id.clone()),
                        code: TerminalErrorCode::TERMINAL_UNAVAILABLE,
                        message: "Terminal executor disconnected.".to_owned(),
                    },
                    attachment_id: None,
                });
        }
    }
}

fn release_ownership(attachment: &Attachment) {
    attachment
        .peer
        .owned_terminal_ids()
        .borrow_mut()
        .shift_remove(&attachment.terminal_id);
}

fn reference(id: &str) -> Option<TerminalReference> {
    parse_terminal_reference(&Value::String(id.to_owned()))
}

fn invalid_mutation(message: &str) -> TerminalError {
    TerminalError::with_status(TerminalErrorCode::TERMINAL_OUTCOME_UNKNOWN, message, 502)
}
