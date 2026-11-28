//! Ports `server-agents/interface/src/contracts/terminals.ts`.

use std::cell::RefCell;
use std::rc::Rc;

use async_trait::async_trait;
use garcon_contract::terminal::{
    TerminalAttachIntent, TerminalCreateRequest, TerminalCreateResponse, TerminalListResponse,
    TerminalRenameResponse, TerminalStreamServerMessage, TerminalTerminateResponse,
};
use garcon_js::Number;
use indexmap::IndexSet;
use serde::{Deserialize, Serialize};

use crate::resources::{ExecutorCallOptions, ExecutorResult};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAuthority {
    pub key: String,
    pub expires_at_ms: Option<u64>,
}

pub trait TerminalPeer {
    fn connection_id(&self) -> &str;
    fn owned_terminal_ids(&self) -> &RefCell<IndexSet<String>>;
    fn send_terminal_message(&self, message: TerminalStreamServerMessage);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminalAttachKind {
    TerminalAttach,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachRequest {
    pub r#type: TerminalAttachKind,
    pub terminal_id: String,
    pub client_id: String,
    pub after_sequence: Number,
    pub intent: TerminalAttachIntent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment_epoch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment_id: Option<String>,
}

#[async_trait(?Send)]
pub trait ExecutionTerminalService {
    async fn list(
        &self,
        authority: TerminalAuthority,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TerminalListResponse>;
    async fn create(
        &self,
        authority: TerminalAuthority,
        request: TerminalCreateRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TerminalCreateResponse>;
    async fn rename(
        &self,
        authority: TerminalAuthority,
        terminal_id: String,
        title: Option<String>,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TerminalRenameResponse>;
    async fn terminate(
        &self,
        authority: TerminalAuthority,
        terminal_id: String,
        request_id: String,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TerminalTerminateResponse>;
    async fn attach(
        &self,
        authority: TerminalAuthority,
        peer: Rc<dyn TerminalPeer>,
        request: TerminalAttachRequest,
    ) -> ExecutorResult<()>;
    async fn input(
        &self,
        authority: TerminalAuthority,
        peer: Rc<dyn TerminalPeer>,
        terminal_id: String,
        data: String,
    ) -> ExecutorResult<()>;
    async fn resize(
        &self,
        authority: TerminalAuthority,
        peer: Rc<dyn TerminalPeer>,
        terminal_id: String,
        cols: Number,
        rows: Number,
    ) -> ExecutorResult<()>;
    fn detach_peer(&self, authority: TerminalAuthority, peer: Rc<dyn TerminalPeer>);
    fn disconnect(&self);
}
