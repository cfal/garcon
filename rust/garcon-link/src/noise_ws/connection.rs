//! Ports `@cfal/noise-ws/src/connection.ts`: the state machine of one
//! encrypted connection, over any transport that hands it whole binary frames.

use std::cell::RefCell;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::task::{Context, Poll, Waker, ready};
use std::time::Duration;

use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::Shared;
use tokio::task::{JoinHandle, spawn_local};
use tokio::time::{Instant, sleep_until};
use zeroize::Zeroizing;

use super::TypeError;
use super::crypto::NoiseCrypto;
use super::errors::{NoiseError, NoiseErrorCode};
use super::options::{
    MAX_FRAME_BYTES, NoiseCloseInfo, NoiseMessage, NoiseOptions, ResolvedNoiseLimits,
    connection_prologue, resolve_limits,
};
use super::records::{
    CLIENT_READY, CLOSE, MessageAssembler, SERVER_READY, encoded_bytes, message_records,
    record_count,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoiseReadyState {
    Connecting,
    Handshaking,
    Confirming,
    Open,
    Closed,
}

/// Internal adapter contract. A successful write includes queued bytes, never a dropped frame.
pub trait NoiseTransport {
    fn buffered_amount(&self) -> usize;
    /// Queues one frame. `Err` is a transport that rejected the write.
    fn write(&self, frame: Vec<u8>) -> Result<(), RejectedWrite>;
    fn close(&self);
    fn abort(&self);
}

/// A write the transport refused; the connection reports it as `TRANSPORT_ERROR`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RejectedWrite;

impl fmt::Display for RejectedWrite {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the transport rejected the frame")
    }
}

/// What [`NoiseConnection::receive`] is handed: a binary WebSocket message, an
/// `ArrayBuffer` or `Uint8Array` in the original, or a value of any other type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoiseFrame<'a> {
    Binary(&'a [u8]),
    Other,
}

/// What a handler returns. An `Err` is a handler that threw: the connection
/// then fails as `HANDLER_ERROR` and the reason is dropped.
pub type HandlerResult = Result<(), Box<dyn std::error::Error>>;

type Handler<A> = dyn Fn(&Rc<NoiseConnection>, A) -> HandlerResult;

pub type FinishHandler = Rc<dyn Fn(&Rc<NoiseConnection>)>;
pub type MessageHandler = Rc<Handler<NoiseMessage>>;
pub type OpenHandler = Rc<Handler<()>>;
pub type ErrorHandler = Rc<Handler<NoiseError>>;
pub type CloseHandler = Rc<Handler<NoiseCloseInfo>>;

/// Adapts a handler that defers work. As with a JavaScript async callback, its
/// synchronous prefix runs before dispatch returns, and rejection is deferred.
pub fn async_handler<A: 'static, F>(
    handler: impl Fn(&Rc<NoiseConnection>, A) -> F + 'static,
) -> Rc<Handler<A>>
where
    F: Future<Output = HandlerResult> + 'static,
{
    Rc::new(move |connection, value| {
        let mut future = Box::pin(handler(connection, value));
        let first = future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()));
        if !matches!(first, Poll::Ready(Ok(()))) {
            let connection = Rc::clone(connection);
            spawn_local(async move {
                let result = match first {
                    Poll::Ready(result) => result,
                    Poll::Pending => future.await,
                };
                if result.is_err() {
                    connection.fail(NoiseErrorCode::HandlerError);
                }
            });
        }
        Ok(())
    })
}

/// `ready`: resolves when the handshake completes and rejects with the failure otherwise.
pub struct Ready(Shared<oneshot::Receiver<Result<(), NoiseError>>>);

impl Future for Ready {
    type Output = Result<(), NoiseError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match ready!(Pin::new(&mut self.0).poll(cx)) {
            Ok(result) => Poll::Ready(result),
            // A connection dropped before it settles leaves its promise pending, as the
            // original's would be.
            Err(_) => Poll::Pending,
        }
    }
}

/// `closed`: settles with how the connection ended.
pub struct Closed(Shared<oneshot::Receiver<NoiseCloseInfo>>);

impl Future for Closed {
    type Output = NoiseCloseInfo;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        match ready!(Pin::new(&mut self.0).poll(cx)) {
            Ok(info) => Poll::Ready(info),
            // A connection dropped before it settles leaves its promise pending, as the
            // original's would be.
            Err(_) => Poll::Pending,
        }
    }
}

pub struct NoiseConnection {
    state: RefCell<State>,
    handlers: RefCell<Option<Handlers>>,
    ready: Shared<oneshot::Receiver<Result<(), NoiseError>>>,
    closed: Shared<oneshot::Receiver<NoiseCloseInfo>>,
}

/// The name consumers hold an encrypted socket by.
pub type NoiseWebSocket = NoiseConnection;

struct State {
    crypto: NoiseCrypto,
    transport: Option<Rc<dyn NoiseTransport>>,
    status: NoiseReadyState,
    limits: ResolvedNoiseLimits,
    assembler: MessageAssembler,
    handshake_timer: Option<JoinHandle<()>>,
    message_timer: Option<JoinHandle<()>>,
    ready: Option<oneshot::Sender<Result<(), NoiseError>>>,
    closed: Option<oneshot::Sender<NoiseCloseInfo>>,
    initiator: bool,
}

struct Handlers {
    on_finish: Option<FinishHandler>,
    on_message: MessageHandler,
    on_open: Option<OpenHandler>,
    on_error: Option<ErrorHandler>,
    on_close: Option<CloseHandler>,
}

impl Handlers {
    fn open(handlers: &Self) -> Option<&OpenHandler> {
        handlers.on_open.as_ref()
    }

    fn message(handlers: &Self) -> Option<&MessageHandler> {
        Some(&handlers.on_message)
    }
}

/// `setTimeout(() => connection.fail(code), ms)`, cleared by aborting the task.
fn arm(connection: &Rc<NoiseConnection>, ms: u64, code: NoiseErrorCode) -> JoinHandle<()> {
    let connection = Rc::clone(connection);
    let deadline = Instant::now() + Duration::from_millis(ms);
    spawn_local(async move {
        sleep_until(deadline).await;
        connection.fail(code);
    })
}

/// What `receive` leaves for the caller once the state borrow is released.
enum Next {
    Stay,
    Open,
    Message(NoiseMessage),
    PeerClosed,
}

/// Why a `send` failed: refused before anything was encrypted, which leaves the
/// connection usable, or terminal once encryption started.
enum SendFailure {
    Refused(NoiseError),
    Terminal(NoiseError),
}

impl NoiseConnection {
    /// Use connect_noise_web_socket or create_noise_server rather than constructing a socket directly.
    pub fn new(
        initiator: bool,
        options: NoiseOptions,
        on_finish: Option<FinishHandler>,
    ) -> Result<Rc<Self>, TypeError> {
        let psk = Zeroizing::new(options.psk);
        let limits = resolve_limits(options.limits)?;
        let crypto = NoiseCrypto::new(
            initiator,
            &psk,
            &connection_prologue(&options.context)?,
            limits.max_records_per_direction as u64,
        )?;
        let (ready_sender, ready_receiver) = oneshot::channel();
        let (closed_sender, closed_receiver) = oneshot::channel();
        let connection = Rc::new(Self {
            state: RefCell::new(State {
                crypto,
                transport: None,
                status: NoiseReadyState::Connecting,
                limits,
                assembler: MessageAssembler::default(),
                handshake_timer: None,
                message_timer: None,
                ready: Some(ready_sender),
                closed: Some(closed_sender),
                initiator,
            }),
            handlers: RefCell::new(Some(Handlers {
                on_finish,
                on_message: options.on_message,
                on_open: options.on_open,
                on_error: options.on_error,
                on_close: options.on_close,
            })),
            ready: ready_receiver.shared(),
            closed: closed_receiver.shared(),
        });
        connection.state.borrow_mut().handshake_timer = Some(arm(
            &connection,
            limits.handshake_timeout_ms,
            NoiseErrorCode::HandshakeTimeout,
        ));
        Ok(connection)
    }

    pub fn ready_state(&self) -> NoiseReadyState {
        self.state.borrow().status
    }

    pub fn buffered_amount(&self) -> usize {
        self.state.borrow().buffered_amount()
    }

    pub fn ready(&self) -> Ready {
        Ready(self.ready.clone())
    }

    pub fn closed(&self) -> Closed {
        Closed(self.closed.clone())
    }

    pub fn send(self: &Rc<Self>, message: NoiseMessage) -> Result<(), NoiseError> {
        let sent = self.state.borrow_mut().send(message);
        match sent {
            Ok(()) => Ok(()),
            Err(SendFailure::Refused(error)) => Err(error),
            Err(SendFailure::Terminal(error)) => {
                self.finish(false, Some(error));
                Err(error)
            }
        }
    }

    pub fn close(self: &Rc<Self>) {
        let failure = self.state.borrow_mut().close();
        self.finish(false, failure);
    }

    /// Adapter lifecycle: invoked exactly once after the physical WebSocket opens.
    pub fn attach(self: &Rc<Self>, transport: Rc<dyn NoiseTransport>) {
        enum Attached {
            Done,
            Closed,
            Twice,
            Failed,
        }
        let attached = {
            let mut state = self.state.borrow_mut();
            match state.status {
                NoiseReadyState::Closed => Attached::Closed,
                _ if state.transport.is_some() => Attached::Twice,
                _ => {
                    state.transport = Some(Rc::clone(&transport));
                    state.status = NoiseReadyState::Handshaking;
                    if state.initiator && state.write_handshake().is_err() {
                        Attached::Failed
                    } else {
                        Attached::Done
                    }
                }
            }
        };
        match attached {
            Attached::Done => {}
            Attached::Closed => transport.abort(),
            Attached::Failed => self.fail(NoiseErrorCode::TransportError),
            Attached::Twice => {
                transport.abort();
                self.fail(NoiseErrorCode::ProtocolError);
            }
        }
    }

    /// Adapter lifecycle: raw, complete binary WebSocket messages only.
    pub fn receive(self: &Rc<Self>, frame: NoiseFrame<'_>) {
        let received = {
            let mut state = self.state.borrow_mut();
            if state.status == NoiseReadyState::Closed {
                return;
            }
            state.receive(frame, self)
        };
        match received {
            Ok(Next::Stay) => {}
            Ok(Next::Open) => self.invoke(self.handler(Handlers::open).as_ref(), ()),
            Ok(Next::Message(message)) => {
                self.invoke(self.handler(Handlers::message).as_ref(), message);
            }
            Ok(Next::PeerClosed) => self.finish(true, None),
            Err(error) => self.finish(false, Some(error)),
        }
    }

    /// Adapter lifecycle: raw errors and close reasons must never be trusted as Noise messages.
    pub fn fail(self: &Rc<Self>, code: NoiseErrorCode) {
        self.finish(false, Some(NoiseError::new(code)));
    }

    fn handler<A>(
        &self,
        select: fn(&Handlers) -> Option<&Rc<Handler<A>>>,
    ) -> Option<Rc<Handler<A>>> {
        self.handlers.borrow().as_ref().and_then(select).cloned()
    }

    fn invoke<A>(self: &Rc<Self>, handler: Option<&Rc<Handler<A>>>, argument: A) {
        let Some(handler) = handler else {
            return;
        };
        // Invocation is ordered; callers own any asynchronous work and its queue bounds.
        if handler(self, argument).is_err() {
            self.fail(NoiseErrorCode::HandlerError);
        }
    }

    fn finish(self: &Rc<Self>, authenticated: bool, error: Option<NoiseError>) {
        let Some(transport) = self.settle(authenticated, error) else {
            return;
        };
        // Transport teardown cannot prevent key cleanup or settlement.
        if let Some(transport) = transport {
            if error.is_some() {
                transport.abort();
            } else {
                transport.close();
            }
        }
        if let Some(handlers) = self.handlers.borrow_mut().take() {
            if let Some(on_finish) = &handlers.on_finish {
                on_finish(self);
            }
            if let Some(error) = error {
                self.invoke(handlers.on_error.as_ref(), error);
            }
            self.invoke(
                handlers.on_close.as_ref(),
                NoiseCloseInfo {
                    authenticated,
                    error,
                },
            );
        }
    }

    fn settle(
        &self,
        authenticated: bool,
        error: Option<NoiseError>,
    ) -> Option<Option<Rc<dyn NoiseTransport>>> {
        let mut state = self.state.borrow_mut();
        if state.status == NoiseReadyState::Closed {
            return None;
        }
        state.status = NoiseReadyState::Closed;
        if let Some(timer) = state.handshake_timer.take() {
            timer.abort();
        }
        if let Some(timer) = state.message_timer.take() {
            timer.abort();
        }
        state.assembler.clear();
        state.crypto.destroy();
        let rejection = error.unwrap_or_else(|| NoiseErrorCode::Closed.into());
        let _ = state.ready.take().map(|ready| ready.send(Err(rejection)));
        let _ = state.closed.take().map(|closed| {
            closed.send(NoiseCloseInfo {
                authenticated,
                error,
            })
        });
        Some(state.transport.take())
    }
}

impl State {
    fn buffered_amount(&self) -> usize {
        self.transport
            .as_ref()
            .map_or(0, |transport| transport.buffered_amount())
    }

    fn write_handshake(&mut self) -> Result<(), NoiseError> {
        let frame = self.crypto.send_handshake()?;
        self.write(frame)
    }

    fn write(&mut self, frame: Vec<u8>) -> Result<(), NoiseError> {
        let Some(transport) = self
            .transport
            .as_ref()
            .filter(|_| self.status != NoiseReadyState::Closed)
        else {
            return Err(NoiseErrorCode::Closed.into());
        };
        if self.buffered_amount() + frame.len() + 14 > self.limits.max_buffered_bytes {
            return Err(NoiseErrorCode::Backpressure.into());
        }
        transport
            .write(frame)
            .map_err(|_| NoiseErrorCode::TransportError.into())
    }

    fn send(&mut self, message: NoiseMessage) -> Result<(), SendFailure> {
        if self.status != NoiseReadyState::Open {
            return Err(SendFailure::Refused(NoiseErrorCode::NotOpen.into()));
        }
        let (text, payload) = match message {
            NoiseMessage::Text(text) => (true, text.into_bytes()),
            NoiseMessage::Binary(bytes) => (false, bytes),
        };
        let length = payload.len();
        if length > self.limits.max_message_bytes {
            return Err(SendFailure::Refused(NoiseErrorCode::MessageTooLarge.into()));
        }
        if self.buffered_amount() + encoded_bytes(length) > self.limits.max_buffered_bytes {
            return Err(SendFailure::Refused(NoiseErrorCode::Backpressure.into()));
        }
        if record_count(length) as u64 > self.crypto.send_remaining() {
            return Err(SendFailure::Terminal(NoiseErrorCode::RecordLimit.into()));
        }
        for record in message_records(&payload, text) {
            let frame = self
                .crypto
                .encrypt(&record)
                .map_err(SendFailure::Terminal)?;
            self.write(frame).map_err(SendFailure::Terminal)?;
        }
        Ok(())
    }

    fn close(&mut self) -> Option<NoiseError> {
        if self.status != NoiseReadyState::Open {
            return Some(NoiseErrorCode::Closed.into());
        }
        self.crypto
            .encrypt(&[CLOSE])
            .and_then(|frame| self.write(frame))
            .err()
    }

    fn receive(
        &mut self,
        frame: NoiseFrame<'_>,
        connection: &Rc<NoiseConnection>,
    ) -> Result<Next, NoiseError> {
        let NoiseFrame::Binary(bytes) = frame else {
            return Err(NoiseErrorCode::ProtocolError.into());
        };
        if bytes.len() > MAX_FRAME_BYTES || bytes.len() < 17 {
            return Err(NoiseErrorCode::ProtocolError.into());
        }

        if self.status == NoiseReadyState::Handshaking {
            if bytes.len() != 48 {
                return Err(NoiseErrorCode::ProtocolError.into());
            }
            self.crypto.receive_handshake(bytes)?;
            self.status = NoiseReadyState::Confirming;
            if self.initiator {
                let confirmation = self.crypto.encrypt(&[CLIENT_READY])?;
                self.write(confirmation)?;
            } else {
                self.write_handshake()?;
            }
            return Ok(Next::Stay);
        }

        let record = self.crypto.decrypt(bytes)?;
        if self.status == NoiseReadyState::Confirming {
            let expected = if self.initiator {
                SERVER_READY
            } else {
                CLIENT_READY
            };
            if record.as_slice() != [expected] {
                return Err(NoiseErrorCode::ProtocolError.into());
            }
            if !self.initiator {
                let confirmation = self.crypto.encrypt(&[SERVER_READY])?;
                self.write(confirmation)?;
            }
            self.status = NoiseReadyState::Open;
            if let Some(timer) = self.handshake_timer.take() {
                timer.abort();
            }
            let _ = self.ready.take().map(|ready| ready.send(Ok(())));
            return Ok(Next::Open);
        }

        if self.status != NoiseReadyState::Open {
            return Err(NoiseErrorCode::ProtocolError.into());
        }
        if record.first() == Some(&CLOSE) {
            if record.len() != 1 || self.assembler.active() {
                return Err(NoiseErrorCode::ProtocolError.into());
            }
            return Ok(Next::PeerClosed);
        }

        let message = self
            .assembler
            .receive(&record, self.limits.max_message_bytes)?;
        match message {
            Some(message) => {
                if let Some(timer) = self.message_timer.take() {
                    timer.abort();
                }
                Ok(Next::Message(message))
            }
            None => {
                if self.message_timer.is_none() {
                    self.message_timer = Some(arm(
                        connection,
                        self.limits.message_timeout_ms,
                        NoiseErrorCode::MessageTimeout,
                    ));
                }
                Ok(Next::Stay)
            }
        }
    }
}
