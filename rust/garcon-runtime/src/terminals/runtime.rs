//! Ports `server/runtime/terminals/runtime.ts`.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};
use std::time::Duration;

use async_trait::async_trait;
use garcon_contract::terminal::{
    TerminalCreateRequest, TerminalCreateResponse, TerminalErrorCode as Code, TerminalListResponse,
    TerminalRenameResponse, TerminalStreamServerMessage, TerminalTerminateResponse,
};
use garcon_contract::terminal_error::TerminalError;
use garcon_contract::terminal_identity::parse_terminal_reference;
use garcon_interface::resources::{ExecutorCallOptions, ExecutorResult};
use garcon_interface::terminals::{
    ExecutionTerminalService, TerminalAttachRequest, TerminalAuthority, TerminalPeer,
};
use garcon_js::{Number, clock::Clock};
use indexmap::IndexSet;
use serde_json::Value;
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::cancellation::check_cancelled;

use super::terminal_manager::{TerminalManager, TerminalManagerOptions, expired, stopping};

/// Owns terminals for the executor process, not any individual link session.
pub struct TerminalRuntime {
    id: String,
    options: TerminalManagerOptions,
    managers: RefCell<HashMap<String, TerminalManager>>,
    stopped: Cell<bool>,
}

impl TerminalRuntime {
    pub fn new(options: TerminalManagerOptions) -> Self {
        let id = options
            .terminal_runtime_id
            .clone()
            .unwrap_or_else(|| (options.new_id)().to_string());
        Self {
            id,
            options,
            managers: RefCell::new(HashMap::new()),
            stopped: Cell::new(false),
        }
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn service(&self, executor_id: &str) -> Result<TerminalService, TerminalError> {
        if self.stopped.get() {
            return Err(stopping());
        }
        let manager = self
            .managers
            .borrow_mut()
            .entry(executor_id.to_owned())
            .or_insert_with(|| {
                TerminalManager::new(TerminalManagerOptions {
                    executor_id: Some(executor_id.to_owned()),
                    terminal_runtime_id: Some(self.id.clone()),
                    ..self.options.clone()
                })
            })
            .clone();
        Ok(TerminalService::new(
            manager,
            self.options.clock.clone(),
            self.options.new_id.clone(),
        ))
    }

    pub fn shutdown(&self) {
        self.stopped.set(true);
        for (_, manager) in self.managers.take() {
            manager.shutdown();
        }
    }
}

impl Drop for TerminalRuntime {
    fn drop(&mut self) {
        self.shutdown();
    }
}

type Peer = Rc<dyn TerminalPeer>;
type PeerKey = *const ();

fn peer_key(peer: &Peer) -> PeerKey {
    Rc::as_ptr(peer).cast()
}

struct Subscription {
    peer: Rc<SubscribedPeer>,
    timer: Option<JoinHandle<()>>,
}

struct SubscribedPeer {
    authority: TerminalAuthority,
    upstream: Peer,
    owner: Weak<Inner>,
    active: Cell<bool>,
}

impl TerminalPeer for SubscribedPeer {
    fn connection_id(&self) -> &str {
        self.upstream.connection_id()
    }

    fn owned_terminal_ids(&self) -> &RefCell<IndexSet<String>> {
        self.upstream.owned_terminal_ids()
    }

    fn send_terminal_message(&self, message: TerminalStreamServerMessage) {
        if !self.active.get() {
            return;
        }
        let Some(owner) = self.owner.upgrade() else {
            return;
        };
        if expired(&self.authority, owner.clock.now_ms()) {
            owner.detach(&self.authority, peer_key(&self.upstream));
        } else {
            self.upstream.send_terminal_message(message);
        }
    }
}

struct Inner {
    manager: TerminalManager,
    clock: Rc<dyn Clock>,
    new_id: Rc<dyn Fn() -> Uuid>,
    subscriptions: RefCell<HashMap<PeerKey, Subscription>>,
    disposed: Cell<bool>,
    epoch: RefCell<String>,
}

impl Inner {
    fn detach(&self, authority: &TerminalAuthority, key: PeerKey) {
        let subscription = self.subscriptions.borrow_mut().remove(&key);
        if let Some(subscription) = subscription {
            self.detach_subscription(authority, subscription);
        }
    }

    fn detach_subscription(&self, authority: &TerminalAuthority, subscription: Subscription) {
        subscription.peer.active.set(false);
        if let Some(timer) = subscription.timer {
            timer.abort();
        }
        let peer: Peer = subscription.peer;
        self.manager.detach_peer(authority, &peer);
    }

    fn detach_all(&self) {
        for (_, subscription) in self.subscriptions.take() {
            let authority = subscription.peer.authority.clone();
            self.detach_subscription(&authority, subscription);
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.detach_all();
    }
}

#[derive(Clone)]
pub struct TerminalService(Rc<Inner>);

impl TerminalService {
    fn new(manager: TerminalManager, clock: Rc<dyn Clock>, new_id: Rc<dyn Fn() -> Uuid>) -> Self {
        let epoch = new_id().to_string();
        Self(Rc::new(Inner {
            manager,
            clock,
            new_id,
            subscriptions: RefCell::new(HashMap::new()),
            disposed: Cell::new(false),
            epoch: RefCell::new(epoch),
        }))
    }

    pub fn manager(&self) -> &TerminalManager {
        &self.0.manager
    }

    pub fn dispose(&self) {
        self.0.disposed.set(true);
        self.disconnect();
    }

    fn subscribe(&self, authority: TerminalAuthority, peer: Peer) -> Peer {
        let key = peer_key(&peer);
        let mut subscriptions = self.0.subscriptions.borrow_mut();
        if let Some(subscription) = subscriptions.get(&key) {
            return subscription.peer.clone();
        }
        let wrapped = Rc::new(SubscribedPeer {
            authority,
            upstream: peer,
            owner: Rc::downgrade(&self.0),
            active: Cell::new(true),
        });
        let timer = wrapped.authority.expires_at_ms.map(|deadline| {
            let peer = Rc::downgrade(&wrapped);
            tokio::task::spawn_local(async move {
                loop {
                    let delay = {
                        let Some(peer) = peer.upgrade() else { return };
                        let Some(owner) = peer.owner.upgrade() else {
                            return;
                        };
                        let remaining = i128::from(deadline) - i128::from(owner.clock.now_ms());
                        if remaining <= 0 {
                            owner.detach(&peer.authority, key);
                            return;
                        }
                        Duration::from_millis(remaining.min(2_147_000_000) as u64)
                    };
                    tokio::time::sleep(delay).await;
                }
            })
        });
        subscriptions.insert(
            key,
            Subscription {
                peer: wrapped.clone(),
                timer,
            },
        );
        wrapped
    }

    fn peer(&self, peer: &Peer) -> Result<Peer, TerminalError> {
        self.0
            .subscriptions
            .borrow()
            .get(&peer_key(peer))
            .map(|value| value.peer.clone() as Peer)
            .ok_or_else(|| {
                TerminalError::with_status(
                    Code::TERMINAL_NOT_ATTACHED,
                    "Terminal attachment expired.",
                    409,
                )
            })
    }

    fn check(
        &self,
        authority: &TerminalAuthority,
        options: Option<&ExecutorCallOptions>,
    ) -> ExecutorResult<()> {
        check_cancelled(options.and_then(|options| options.signal.as_ref()))?;
        if self.0.disposed.get() {
            return Err(TerminalError::with_status(
                Code::TERMINAL_UNAVAILABLE,
                "Terminal connection retired.",
                503,
            )
            .into());
        }
        if authority.key.is_empty() || expired(authority, self.0.clock.now_ms()) {
            return Err(TerminalError::with_status(
                Code::TERMINAL_AUTH_EXPIRED,
                "Terminal authorization expired.",
                401,
            )
            .into());
        }
        Ok(())
    }

    fn reference(&self, id: &str) -> Result<(), TerminalError> {
        let reference = parse_terminal_reference(&Value::String(id.to_owned()))
            .filter(|reference| reference.executor_id == self.manager().executor_id())
            .ok_or_else(|| {
                TerminalError::new(Code::TERMINAL_VALIDATION, "Invalid terminal target.")
            })?;
        if reference.terminal_runtime_id != self.manager().terminal_runtime_id() {
            return Err(TerminalError::with_status(
                Code::TERMINAL_RUNTIME_CHANGED,
                "Terminal executor restarted.",
                409,
            ));
        }
        Ok(())
    }
}

#[async_trait(?Send)]
impl ExecutionTerminalService for TerminalService {
    async fn list(
        &self,
        authority: TerminalAuthority,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TerminalListResponse> {
        self.check(&authority, options.as_ref())?;
        Ok(TerminalListResponse {
            success: true,
            terminal_runtime_id: Some(self.manager().terminal_runtime_id().to_owned()),
            attachment_epoch: Some(self.0.epoch.borrow().clone()),
            terminals: self.manager().list(&authority),
        })
    }

    async fn create(
        &self,
        authority: TerminalAuthority,
        request: TerminalCreateRequest,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TerminalCreateResponse> {
        self.check(&authority, options.as_ref())?;
        if request
            .executor_id
            .as_deref()
            .is_some_and(|id| id != self.manager().executor_id())
        {
            return Err(TerminalError::new(
                Code::TERMINAL_VALIDATION,
                "Terminal executor mismatch.",
            )
            .into());
        }
        if request
            .expected_terminal_runtime_id
            .as_deref()
            .is_none_or(str::is_empty)
        {
            return Err(TerminalError::new(
                Code::TERMINAL_VALIDATION,
                "List terminals before creating a shell.",
            )
            .into());
        }
        self.manager().create(authority, request).await
    }

    async fn rename(
        &self,
        authority: TerminalAuthority,
        terminal_id: String,
        title: Option<String>,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TerminalRenameResponse> {
        self.check(&authority, options.as_ref())?;
        self.reference(&terminal_id)?;
        Ok(self.manager().rename(&authority, &terminal_id, title)?)
    }

    async fn terminate(
        &self,
        authority: TerminalAuthority,
        terminal_id: String,
        request_id: String,
        options: Option<ExecutorCallOptions>,
    ) -> ExecutorResult<TerminalTerminateResponse> {
        self.check(&authority, options.as_ref())?;
        self.reference(&terminal_id)?;
        self.manager()
            .terminate(authority, terminal_id, request_id)
            .await
    }

    async fn attach(
        &self,
        authority: TerminalAuthority,
        peer: Peer,
        request: TerminalAttachRequest,
    ) -> ExecutorResult<()> {
        self.check(&authority, None)?;
        self.reference(&request.terminal_id)?;
        if request.attachment_epoch.as_deref() != Some(self.0.epoch.borrow().as_str()) {
            return Err(TerminalError::with_status(
                Code::TERMINAL_NOT_ATTACHED,
                "Refresh terminal attachments after reconnecting.",
                409,
            )
            .into());
        }
        let peer = self.subscribe(authority.clone(), peer);
        Ok(self.manager().attach(&authority, peer, request)?)
    }

    async fn input(
        &self,
        authority: TerminalAuthority,
        peer: Peer,
        terminal_id: String,
        data: String,
    ) -> ExecutorResult<()> {
        self.check(&authority, None)?;
        self.reference(&terminal_id)?;
        Ok(self
            .manager()
            .input(authority, self.peer(&peer)?, &terminal_id, data)?)
    }

    async fn resize(
        &self,
        authority: TerminalAuthority,
        peer: Peer,
        terminal_id: String,
        cols: Number,
        rows: Number,
    ) -> ExecutorResult<()> {
        self.check(&authority, None)?;
        self.reference(&terminal_id)?;
        Ok(self
            .manager()
            .resize(authority, self.peer(&peer)?, &terminal_id, cols, rows)?)
    }

    fn detach_peer(&self, authority: TerminalAuthority, peer: Peer) {
        self.0.detach(&authority, peer_key(&peer));
    }

    fn disconnect(&self) {
        *self.0.epoch.borrow_mut() = (self.0.new_id)().to_string();
        self.0.detach_all();
    }
}
