//! Ports `test/helpers.ts`.

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::rc::Rc;
use std::time::Duration;

use tokio::task::{LocalSet, spawn_local};

use crate::noise_ws::client::NoiseClientOptions;
use crate::noise_ws::connection::{
    CloseHandler, ErrorHandler, MessageHandler, NoiseConnection, NoiseFrame, NoiseTransport,
    OpenHandler, RejectedWrite,
};
use crate::noise_ws::errors::NoiseErrorCode;
use crate::noise_ws::options::{NoiseLimits, NoiseMessage, NoiseOptions};

pub(super) const PSK: [u8; 32] = [42; 32];
pub(super) const CONTEXT: &str = "noise-ws-tests/v1";

/// Runs a test on one single-threaded runtime, with its local tasks and the
/// clock paused.
pub(super) fn paused(body: impl Future<Output = ()>) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .expect("the test runtime builds");
    runtime.block_on(LocalSet::new().run_until(body));
}

/// Runs a test on one single-threaded runtime with its local tasks, on the
/// real clock: its sockets and child processes are real.
pub(super) fn real(body: impl Future<Output = ()>) {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("the test runtime builds");
    runtime.block_on(LocalSet::new().run_until(async {
        tokio::time::timeout(Duration::from_secs(120), body)
            .await
            .unwrap_or_else(|_| panic!("Test deadline exceeded"));
    }));
}

/// `deadline(promise, ms)`.
#[track_caller]
pub(super) fn deadline<T>(promise: impl Future<Output = T>, ms: u64) -> impl Future<Output = T> {
    let caller = std::panic::Location::caller();
    async move {
        tokio::time::timeout(Duration::from_millis(ms), promise)
            .await
            .unwrap_or_else(|_| panic!("Test deadline of {ms} ms exceeded at {caller}"))
    }
}

/// `Bun.sleep(ms)` in a test, which lets queued microtasks run.
pub(super) async fn settle(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/// Which side of a pair wrote a frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum From {
    Left,
    Right,
}

/// A pair's frame filter: the frame to deliver, `None` to withhold it, or
/// `Err` for a write that throws.
pub(super) type Filter = Box<dyn FnMut(&[u8], From) -> Result<Option<Vec<u8>>, RejectedWrite>>;

#[derive(Default)]
struct Control {
    buffered_amount: Cell<usize>,
    write_error: Cell<bool>,
    filter: RefCell<Option<Filter>>,
}

struct PairTransport {
    peer: Rc<NoiseConnection>,
    frames: Frames,
    from: From,
    control: Rc<Control>,
}

impl NoiseTransport for PairTransport {
    fn buffered_amount(&self) -> usize {
        self.control.buffered_amount.get()
    }

    fn write(&self, frame: Vec<u8>) -> Result<(), RejectedWrite> {
        if self.control.write_error.get() {
            return Err(RejectedWrite);
        }
        self.frames.borrow_mut().push(frame.clone());
        let changed = match self.control.filter.borrow_mut().as_mut() {
            Some(filter) => filter(&frame, self.from)?,
            None => Some(frame),
        };
        if let Some(changed) = changed {
            let peer = Rc::clone(&self.peer);
            spawn_local(async move {
                peer.receive(NoiseFrame::Binary(&changed));
            });
        }
        Ok(())
    }

    fn close(&self) {
        let peer = Rc::clone(&self.peer);
        spawn_local(async move {
            peer.fail(NoiseErrorCode::TransportClosed);
        });
    }

    fn abort(&self) {
        self.close();
    }
}

/// A transport that accepts every frame and delivers nothing.
pub(super) struct Silent;

impl NoiseTransport for Silent {
    fn buffered_amount(&self) -> usize {
        0
    }

    fn write(&self, _frame: Vec<u8>) -> Result<(), RejectedWrite> {
        Ok(())
    }

    fn close(&self) {}

    fn abort(&self) {}
}

pub(super) type Messages = Rc<RefCell<Vec<NoiseMessage>>>;
pub(super) type Frames = Rc<RefCell<Vec<Vec<u8>>>>;

fn recording() -> (Messages, MessageHandler) {
    let messages = Rc::new(RefCell::new(Vec::new()));
    let handler = {
        let messages = Rc::clone(&messages);
        Rc::new(move |_: &Rc<NoiseConnection>, message: NoiseMessage| {
            messages.borrow_mut().push(message);
            Ok(())
        })
    };
    (messages, handler)
}

/// The `Partial<NoiseOptions>` each side of a pair takes.
#[derive(Default)]
pub(super) struct Overrides {
    pub psk: Option<Vec<u8>>,
    pub context: Option<String>,
    pub limits: Option<NoiseLimits>,
    pub on_message: Option<MessageHandler>,
    pub on_open: Option<OpenHandler>,
    pub on_error: Option<ErrorHandler>,
    pub on_close: Option<CloseHandler>,
}

fn pair_options(overrides: &Overrides, on_message: MessageHandler) -> NoiseOptions {
    NoiseOptions {
        psk: overrides.psk.clone().unwrap_or_else(|| PSK.to_vec()),
        context: overrides
            .context
            .clone()
            .unwrap_or_else(|| CONTEXT.to_owned()),
        limits: overrides.limits,
        on_message: overrides.on_message.clone().unwrap_or(on_message),
        on_open: overrides.on_open.clone(),
        on_error: overrides.on_error.clone(),
        on_close: overrides.on_close.clone(),
    }
}

pub(super) struct Pair {
    pub left: Rc<NoiseConnection>,
    pub right: Rc<NoiseConnection>,
    pub left_messages: Messages,
    pub right_messages: Messages,
    pub left_frames: Frames,
    pub right_frames: Frames,
    control: Rc<Control>,
}

/// `pair(leftOptions, rightOptions)`.
pub(super) fn pair(left_options: Overrides, right_options: Overrides) -> Pair {
    let (left_messages, left_on_message) = recording();
    let (right_messages, right_on_message) = recording();
    let left = NoiseConnection::new(true, pair_options(&left_options, left_on_message), None)
        .expect("the initiator builds");
    let right = NoiseConnection::new(false, pair_options(&right_options, right_on_message), None)
        .expect("the responder builds");
    Pair {
        left,
        right,
        left_messages,
        right_messages,
        left_frames: Rc::default(),
        right_frames: Rc::default(),
        control: Rc::default(),
    }
}

impl Pair {
    pub fn start(&self) {
        self.right.attach(self.transport(
            Rc::clone(&self.left),
            Rc::clone(&self.right_frames),
            From::Right,
        ));
        self.left.attach(self.transport(
            Rc::clone(&self.right),
            Rc::clone(&self.left_frames),
            From::Left,
        ));
    }

    fn transport(
        &self,
        peer: Rc<NoiseConnection>,
        frames: Frames,
        from: From,
    ) -> Rc<dyn NoiseTransport> {
        Rc::new(PairTransport {
            peer,
            frames,
            from,
            control: Rc::clone(&self.control),
        })
    }

    pub async fn ready(&self) {
        let (left, right) = deadline(
            futures::future::join(self.left.ready(), self.right.ready()),
            2_000,
        )
        .await;
        left.expect("the initiator opens");
        right.expect("the responder opens");
    }

    pub fn set_filter(&self, filter: Filter) {
        *self.control.filter.borrow_mut() = Some(filter);
    }

    pub fn set_buffered_amount(&self, value: usize) {
        self.control.buffered_amount.set(value);
    }

    pub fn set_write_error(&self, value: bool) {
        self.control.write_error.set(value);
    }

    pub fn close(&self) {
        self.left.close();
        self.right.close();
    }
}

/// The connection ended with this error code.
pub(super) fn code(info: crate::noise_ws::options::NoiseCloseInfo) -> NoiseErrorCode {
    info.error.expect("the connection ended with an error").code
}

/// A handler that throws `message`.
pub(super) fn throwing(message: &'static str) -> MessageHandler {
    Rc::new(move |_, _| Err(message.into()))
}

/// An `onOpen` handler that counts its calls.
pub(super) fn counting(
    counter: Rc<Cell<u32>>,
) -> impl Fn(&Rc<NoiseConnection>, ()) -> crate::noise_ws::connection::HandlerResult + 'static {
    move |_: &Rc<NoiseConnection>, ()| {
        counter.set(counter.get() + 1);
        Ok(())
    }
}

/// A text message.
pub(super) fn text(value: &str) -> NoiseMessage {
    NoiseMessage::Text(value.to_owned())
}

/// A binary message of `length` zero bytes.
pub(super) fn binary(length: usize) -> NoiseMessage {
    NoiseMessage::Binary(vec![0; length])
}

/// The messages one side of a pair received.
pub(super) fn messages(pair: &Pair, side: From) -> Vec<NoiseMessage> {
    match side {
        From::Left => &pair.left_messages,
        From::Right => &pair.right_messages,
    }
    .borrow()
    .clone()
}

/// How many frames one side of a pair wrote.
pub(super) fn frames(pair: &Pair, side: From) -> usize {
    match side {
        From::Left => &pair.left_frames,
        From::Right => &pair.right_frames,
    }
    .borrow()
    .len()
}

/// The error's message says `text`.
pub(super) fn throws(error: crate::noise_ws::NoiseError, text: &str) {
    assert!(error.to_string().contains(text), "{error}");
}

/// `onMessage() {}`.
pub(super) fn ignoring() -> MessageHandler {
    Rc::new(|_, _| Ok(()))
}

/// `NoiseOptions` with the tests' key and context.
pub(super) fn options(on_message: MessageHandler) -> NoiseOptions {
    NoiseOptions {
        psk: PSK.to_vec(),
        context: CONTEXT.to_owned(),
        limits: None,
        on_message,
        on_open: None,
        on_error: None,
        on_close: None,
    }
}

/// `NoiseClientOptions` with the tests' key and context.
pub(super) fn client_options(on_message: MessageHandler) -> NoiseClientOptions {
    NoiseClientOptions {
        psk: PSK.to_vec(),
        context: CONTEXT.to_owned(),
        limits: None,
        on_message,
        on_open: None,
        on_error: None,
        on_close: None,
        tls: None,
        allow_unverified_tls: false,
        signal: None,
    }
}

/// `NoiseOptions` for a listener's fixture: the tests' key and context, an
/// `onOpen`, and limits.
pub(super) fn server_options(
    on_open: Option<OpenHandler>,
    limits: Option<NoiseLimits>,
) -> NoiseOptions {
    NoiseOptions {
        psk: PSK.to_vec(),
        context: CONTEXT.to_owned(),
        limits,
        on_message: ignoring(),
        on_open,
        on_error: None,
        on_close: None,
    }
}

/// A socket's inbox: what its `onMessage` receives.
pub(super) type Inbox = Rc<RefCell<Vec<NoiseMessage>>>;

/// An empty inbox and the handler that fills it.
pub(super) fn inbox() -> (Inbox, MessageHandler) {
    let inbox: Inbox = Rc::default();
    let handler = {
        let inbox = Rc::clone(&inbox);
        Rc::new(move |_: &Rc<NoiseConnection>, message: NoiseMessage| {
            inbox.borrow_mut().push(message);
            Ok(())
        })
    };
    (inbox, handler)
}

/// Waits until the inbox holds `count` messages.
pub(super) async fn received(inbox: &Inbox, count: usize) -> Vec<NoiseMessage> {
    received_within(inbox, count, 5_000).await
}

/// Preserves the oracle's I/O deadlines in release builds. Unoptimized
/// RustCrypto can spend several seconds per 16 MiB encryption or decryption.
pub(super) fn large_exchange_ms(oracle_ms: u64) -> u64 {
    if cfg!(debug_assertions) {
        30_000
    } else {
        oracle_ms
    }
}

pub(super) async fn received_within(inbox: &Inbox, count: usize, ms: u64) -> Vec<NoiseMessage> {
    deadline(
        async {
            loop {
                let held = inbox.borrow().len();
                if held >= count {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            inbox.borrow().clone()
        },
        ms,
    )
    .await
}

/// Waits until `condition` holds.
pub(super) async fn until(condition: impl Fn() -> bool) {
    deadline(
        async {
            while !condition() {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        },
        5_000,
    )
    .await
}
